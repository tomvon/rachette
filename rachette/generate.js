// rachette/generate.js
// Introspects the live SQLite schema and emits/updates a policy file. The
// ratchet rule: every column found in the DB must appear in the policy. New
// columns are written as UNCLASSIFIED. Existing classifications are preserved
// (the ratchet only moves forward — it never downgrades a human's decision).

const fs = require("fs");
const path = require("path");

function introspect(db, table) {
  // PRAGMA table_info returns one row per column.
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.map((r) => r.name);
}

// Parse which fields are already classified in an existing policy file, so we
// don't overwrite them. We read the file as text (rather than require()-ing it)
// so a syntactically-broken policy still round-trips its good lines. The format
// contract is one `fieldName: MARKER,` per line — which is exactly what generate()
// below emits, so a generated-then-hand-labeled file always preserves cleanly.
function existingClassifications(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const text = fs.readFileSync(filePath, "utf8");
  const found = {};
  const re = /^\s*([A-Za-z_]\w*)\s*:\s*(PUBLIC|PRIVATE|INTERNAL|OPERATIONAL|UNCLASSIFIED)\b/gm;
  let m;
  while ((m = re.exec(text))) found[m[1]] = m[2];
  return found;
}

function generate(db, table, outDir) {
  const columns = introspect(db, table);
  const filePath = path.join(outDir, `${table}.policy.js`);
  const prior = existingClassifications(filePath);

  const lines = columns.map((col) => {
    const marker = prior[col] || "UNCLASSIFIED";
    return `    ${col}: ${marker},`;
  });

  const added = columns.filter((c) => !(c in prior));
  const body =
`// AUTO-GENERATED policy scaffold for "${table}". Safe to hand-edit: re-running
// the generator preserves your labels and only appends new columns (as
// UNCLASSIFIED). Keep one \`field: MARKER,\` per line so that preservation works.
// New columns arrive UNCLASSIFIED and fail every exit until you classify them.
const { PUBLIC, PRIVATE, INTERNAL, OPERATIONAL, UNCLASSIFIED } = require("../rachette/markers");

module.exports = {
  table: "${table}",
  // owner check used by PRIVATE fields:
  ownerOf: (viewer, record) => viewer && viewer.id === record.id,
  fields: {
${lines.join("\n")}
  },
};
`;
  fs.writeFileSync(filePath, body);
  return { filePath, columns, added };
}

module.exports = { introspect, generate };
