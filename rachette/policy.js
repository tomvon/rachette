// rachette/policy.js
// Holds the policy map per table and the single guard every door runs first.

const registry = Object.create(null); // table -> { fields, ownerOf }

function register(table, def) {
  // def: { ownerOf?: (viewer, record) => bool, fields: { name: marker } }
  registry[table] = {
    ownerOf: def.ownerOf || null,
    fields: def.fields,
  };
}

function policyFor(table) {
  const p = registry[table];
  if (!p) throw new Error(`no policy registered for table "${table}"`);
  return p;
}

// The runtime backstop. Walks the ACTUAL keys on the record — not the declared
// schema — so a column smuggled in via SELECT * or a derived field is caught
// here even though CI (which only sees the declared schema) was green.
function guardFields(table, record, where) {
  const { fields } = policyFor(table);
  for (const field of Object.keys(record)) {
    const marker = fields[field];
    if (!marker) {
      throw new Error(
        `[${where}] "${table}.${field}" is not in the policy. It reached this ` +
        `exit anyway (raw query / SELECT * / derived field?). Classify it or ` +
        `strip it before it can leave.`);
    }
    if (marker.__unclassified) {
      throw new Error(
        `[${where}] "${table}.${field}" is UNCLASSIFIED. Classify it ` +
        `(public/private/internal/operational) before it can be rendered, ` +
        `cached, or logged.`);
    }
  }
}

module.exports = { register, policyFor, guardFields, registry };
