// rachette/audit.js
// The CI ratchet. For each table: every live DB column must be classified, and
// nothing may be UNCLASSIFIED. Drift in either direction is a failure. Run in
// CI; a red build is the whole mechanism that keeps the policy honest as the
// schema grows.

const path = require("path");
const { introspect } = require("./generate");

function audit(db, tables, policyDir) {
  const problems = [];
  for (const table of tables) {
    const columns = introspect(db, table);
    let policy;
    try {
      policy = require(path.join(policyDir, `${table}.policy.js`));
    } catch {
      problems.push(`${table}: no policy file (run the generator)`);
      continue;
    }
    const classified = policy.fields || {};
    for (const col of columns) {
      const marker = classified[col];
      if (!marker) problems.push(`${table}.${col}: in DB but not in policy`);
      else if (marker.tag === "UNCLASSIFIED") problems.push(`${table}.${col}: UNCLASSIFIED`);
    }
    for (const declared of Object.keys(classified)) {
      if (!columns.includes(declared)) {
        problems.push(`${table}.${declared}: in policy but not in DB (stale)`);
      }
    }
  }
  return problems;
}

module.exports = { audit };
