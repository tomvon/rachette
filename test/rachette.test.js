// test/rachette.test.js — zero-dependency suite (node:test). Run: `node --test`.
// Covers the three doors, the runtime guard, the CI ratchet, and the generator's
// preserve-on-regenerate behavior. Uses in-memory SQLite and a temp dir so it
// leaves nothing behind and never touches app.db.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { register, guardFields } = require("../rachette/policy");
const { project, projectList, PolicyCache, redact } = require("../rachette/exits");
const { PUBLIC, PRIVATE, INTERNAL, OPERATIONAL, UNCLASSIFIED } = require("../rachette/markers");
const { generate } = require("../rachette/generate");
const { audit } = require("../rachette/audit");

// A registered table used across the door tests. Owned by its own id.
register("t_users", {
  ownerOf: (viewer, record) => !!viewer && viewer.id === record.id,
  fields: { id: PUBLIC, name: PUBLIC, email: PRIVATE, ssn: INTERNAL, role: OPERATIONAL },
});
const ROW = { id: 7, name: "Dana", email: "dana@x", ssn: "111-22-3333", role: "member" };

test("Door 1 — response projects per viewer", () => {
  const owner = { id: 7, role: "member" };
  const stranger = { id: 9, role: "member" };
  const admin = { id: 1, role: "admin" };

  assert.deepEqual(project("t_users", ROW, owner), { id: 7, name: "Dana", email: "dana@x" });
  assert.deepEqual(project("t_users", ROW, stranger), { id: 7, name: "Dana" });
  // admin sees PRIVATE (email) but never INTERNAL (ssn) or OPERATIONAL (role).
  assert.deepEqual(project("t_users", ROW, admin), { id: 7, name: "Dana", email: "dana@x" });
  assert.deepEqual(project("t_users", ROW, null), { id: 7, name: "Dana" });
});

test("Door 1 — list projects every row", () => {
  const rows = [ROW, { ...ROW, id: 8, name: "Lee" }];
  assert.deepEqual(projectList("t_users", rows, null), [{ id: 7, name: "Dana" }, { id: 8, name: "Lee" }]);
});

test("Door 3 — log redacts private/internal, keeps public/operational", () => {
  assert.deepEqual(redact("t_users", ROW), {
    id: 7, name: "Dana", email: "[redacted]", ssn: "[redacted]", role: "member",
  });
});

test("Door 2 — cache splits shards, overlays for owner, versions itself", () => {
  const cache = new PolicyCache();
  assert.equal(cache.read("t_users", 7, { id: 7, role: "member" }), null); // nothing cached yet

  const v1 = cache.write("t_users", ROW);
  assert.equal(v1, 1);
  // INTERNAL/OPERATIONAL fields are never cached for output.
  assert.deepEqual(cache.read("t_users", 7, { id: 7, role: "member" }), { id: 7, name: "Dana", email: "dana@x" });
  assert.deepEqual(cache.read("t_users", 7, { id: 9, role: "member" }), { id: 7, name: "Dana" });
  assert.deepEqual(cache.read("t_users", 7, null), { id: 7, name: "Dana" });

  // A changed row writes a new version; reads follow it, the old one is retired.
  const v2 = cache.write("t_users", { ...ROW, name: "Dana Reyes-Smith" });
  assert.equal(v2, 2);
  assert.equal(cache.read("t_users", 7, null).name, "Dana Reyes-Smith");
  assert.equal(cache.store.has("t_users:7:v1:public"), false); // superseded shard gone (bounded memory)
  assert.equal(cache.store.size, 2); // exactly one live version (public + private)
});

test("guard — throws on a field not in the policy (the runtime backstop)", () => {
  assert.throws(() => guardFields("t_users", { id: 7, surprise: "x" }, "response"), /not in the policy/);
});

test("guard — throws on an UNCLASSIFIED field at every door", () => {
  register("t_unclassified", { fields: { id: PUBLIC, mystery: UNCLASSIFIED } });
  for (const door of ["response", "cache", "log"]) {
    assert.throws(() => guardFields("t_unclassified", { id: 1, mystery: "?" }, door), /UNCLASSIFIED/);
  }
});

// ---- the CI ratchet -------------------------------------------------------
function seedDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT)");
  return db;
}

test("audit — passes when every column is classified", () => {
  const db = seedDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rachette-"));
  fs.writeFileSync(path.join(dir, "users.policy.js"),
    `const { PUBLIC, PRIVATE } = require(${JSON.stringify(path.resolve(__dirname, "../rachette/markers"))});
     module.exports = { table: "users", fields: { id: PUBLIC, name: PUBLIC, email: PRIVATE } };`);
  assert.deepEqual(audit(db, ["users"], dir), []);
});

test("audit — flags an unclassified column, a missing one, and a stale one", () => {
  const db = seedDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rachette-"));
  fs.writeFileSync(path.join(dir, "users.policy.js"),
    `const { PUBLIC, UNCLASSIFIED } = require(${JSON.stringify(path.resolve(__dirname, "../rachette/markers"))});
     module.exports = { table: "users", fields: { id: PUBLIC, email: UNCLASSIFIED, ghost: PUBLIC } };`);
  const problems = audit(db, ["users"], dir);
  assert.ok(problems.some((p) => /email: UNCLASSIFIED/.test(p)));   // present but unclassified
  assert.ok(problems.some((p) => /name: in DB but not in policy/.test(p))); // never classified
  assert.ok(problems.some((p) => /ghost: in policy but not in DB/.test(p))); // stale
});

test("audit — flags a table that has no policy file at all", () => {
  const db = seedDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rachette-"));
  assert.ok(audit(db, ["users"], dir).some((p) => /no policy file/.test(p)));
});

// ---- the generator (the ratchet's forward-only motion) --------------------
test("generate — new columns arrive UNCLASSIFIED and existing labels are preserved", () => {
  const db = seedDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rachette-"));

  const first = generate(db, "users", dir);
  assert.deepEqual(first.added, ["id", "name", "email"]);
  assert.match(fs.readFileSync(first.filePath, "utf8"), /email: UNCLASSIFIED/);

  // Hand-label one field, then add a column and regenerate.
  let text = fs.readFileSync(first.filePath, "utf8").replace("email: UNCLASSIFIED", "email: PRIVATE");
  fs.writeFileSync(first.filePath, text);
  db.exec("ALTER TABLE users ADD COLUMN phone TEXT");

  const second = generate(db, "users", dir);
  assert.deepEqual(second.added, ["phone"]);          // only the new column is "added"
  text = fs.readFileSync(second.filePath, "utf8");
  assert.match(text, /email: PRIVATE/);               // human decision preserved
  assert.match(text, /phone: UNCLASSIFIED/);          // new column defaults closed
});
