// app.js — the real service, wired through the owned exits.
const { DatabaseSync } = require("node:sqlite");
const { createApp } = require("./rachette/server");
const { register } = require("./rachette/policy");
const userPolicy = require("./policies/users.policy");

register("users", userPolicy);              // policy is live
const db = new DatabaseSync("app.db");
const app = createApp();

const findUser = (id) => db.prepare("SELECT * FROM users WHERE id = ?").get(Number(id));
// Whitelist the fields a client may write. Mass-assignment guard: even a PUT
// carrying `role` or `id` can't touch them — only these keys are applied.
const pick = (obj, keys) => Object.fromEntries(
  keys.filter((k) => obj && k in obj).map((k) => [k, obj[k]]));

// GET /users/:id  -> cached, projected per viewer.
app.get("/users/:id", (ctx) => {
  const id = Number(ctx.params.id);
  const hit = ctx.cache.read("users", id, ctx.viewer);   // Door 2 — version resolved by the cache
  if (hit) { ctx.log("users", findUser(id)); return ctx.reply.resource("users", hit, { cache: "HIT" }); }
  const row = findUser(id);
  if (!row) return ctx.reply.notFound();
  ctx.cache.write("users", row);             // Door 2 — versions itself
  ctx.log("users", row);                     // Door 3 — redacts private fields
  return ctx.reply.resource("users", row);   // Door 1 — projects per viewer
});

// PUT /users/:id  -> update a row, then refresh the cache through the door.
// This is where field-policy and AUTHORIZATION are shown to be different things:
// rachette governs which *fields* leave; the `forbidden` check below governs who
// may *act*. rachette does not do the second — your app still must.
app.put("/users/:id", (ctx) => {
  const id = Number(ctx.params.id);
  const existing = findUser(id);
  if (!existing) return ctx.reply.notFound();
  if (!(ctx.viewer && (ctx.viewer.role === "admin" || ctx.viewer.id === id)))
    return ctx.reply.error(403, "forbidden");  // authorization — separate concern

  const next = { ...existing, ...pick(ctx.body, ["name", "email", "phone_number"]) };
  db.prepare("UPDATE users SET name=?, email=?, phone_number=? WHERE id=?")
    .run(next.name, next.email, next.phone_number, id);
  ctx.cache.write("users", next);            // Door 2 — bumps version, retires the stale entry
  ctx.log("users", next);                    // Door 3
  return ctx.reply.resource("users", next);  // Door 1
});

// GET /users -> list, projected per viewer.
app.get("/users", (ctx) => {
  const rows = db.prepare("SELECT * FROM users ORDER BY id").all();
  return ctx.reply.list("users", rows);
});

// GET /leak/:id -> a handler MISTAKE: attaches a field not in the policy.
// The door catches it at runtime even though CI was green (the build-time audit
// only sees declared columns; this field is invented in the handler).
app.get("/leak/:id", (ctx) => {
  const row = findUser(ctx.params.id);
  return ctx.reply.resource("users", { ...row, session_token: "tok_secret_xyz" });
});

module.exports = app;
if (require.main === module) app.listen(3000, () => console.log("rachette app on :3000"));
