// rachette/exits.js
// The three doors. Each runs guardFields first, then applies door-specific
// projection. Nothing else in the app is allowed to serialize, cache, or log a
// record — these are the only ways out.

const { policyFor, guardFields } = require("./policy");

// ---- DOOR 1: response (per-viewer projection) ------------------------------
function project(table, record, viewer) {
  guardFields(table, record, "response");
  const { fields, ownerOf } = policyFor(table);
  const out = {};
  for (const [k, v] of Object.entries(record)) {
    if (fields[k].response(viewer, record, ownerOf)) out[k] = v;
  }
  return out;
}

function projectList(table, records, viewer) {
  return records.map((r) => project(table, r, viewer));
}

// ---- DOOR 2: cache (policy-split, version-keyed) ---------------------------
// Public fields go in a shared shard (one entry, CDN-safe). Private fields go in
// an overlay keyed by owner. Internal/operational are never cached for output.
//
// The cache OWNS the version — callers never pass one. Every write bumps a
// per-row counter and stamps the new shards under `...:vN`; reads resolve the
// current N. A changed row therefore writes a fresh key and reads follow it
// automatically — no version number to thread through handlers, no manual purge.
//
// Why a version at all (vs. overwriting one key)? Reads address `...:vN`, so a
// writer never mutates an entry a reader might be mid-flight on: a reader sees
// either vN or vN+1 whole, never a half-updated record. In a distributed cache
// the same property lets nodes converge by version without a cross-node purge
// fan-out. In production the version is usually the row's own updated_at/version
// column (co-located with the data, no side store); the counter here is the
// in-memory stand-in.
//
// Memory: each write retires the immediately-superseded version's shards, so the
// in-process Map stays bounded (one live version per row). That O(1) local delete
// is NOT the cross-node purge the design avoids — it's just garbage collection.
class PolicyCache {
  constructor() { this.store = new Map(); this.versions = new Map(); }

  write(table, record) {
    guardFields(table, record, "cache");
    const { fields } = policyFor(table);
    const pub = {}, priv = {};
    for (const [k, v] of Object.entries(record)) {
      const shard = fields[k].cacheShard;
      if (shard === "public") pub[k] = v;
      else if (shard === "private") priv[k] = v;
    }
    const idKey = `${table}:${record.id}`;
    const prev = this.versions.get(idKey);
    if (prev) { // retire the superseded version so the store can't grow unbounded
      this.store.delete(`${idKey}:v${prev}:public`);
      this.store.delete(`${idKey}:v${prev}:private:${record.id}`);
    }
    const version = (prev || 0) + 1; // bump on every write
    this.versions.set(idKey, version);
    const base = `${idKey}:v${version}`;
    this.store.set(`${base}:public`, pub);
    this.store.set(`${base}:private:${record.id}`, priv); // owner-scoped
    return version;
  }

  // Reassemble for a viewer: always read the shared public shard; layer the
  // private overlay only if the viewer is the owner (or admin).
  //
  // CAVEAT: ownership is checked against a stub record `{ id }` — the only key we
  // have on a cache read is the row id. So the private overlay is correct only
  // when ownership IS the row's own id (the users-table shape, where a row is
  // owned by the user it represents). For any table owned by a *different* key
  // (e.g. `record.user_id === viewer.id`), ownerOf can't resolve here and the
  // overlay would be wrongly withheld. Generalizing this needs an explicit
  // owner-key in the policy; out of scope for this POC.
  read(table, id, viewer) {
    const version = this.versions.get(`${table}:${id}`);
    if (!version) return null; // never written -> caller recomputes
    const base = `${table}:${id}:v${version}`;
    const pub = this.store.get(`${base}:public`);
    if (!pub) return null; // miss -> caller recomputes
    const { ownerOf } = policyFor(table);
    const isOwner = viewer && (viewer.role === "admin" ||
      (ownerOf && ownerOf(viewer, { id })));
    const priv = isOwner ? this.store.get(`${base}:private:${id}`) || {} : {};
    return { ...pub, ...priv }; // clean record; hit-ness is signalled by non-null
  }
}

// ---- DOOR 3: log (unconditional redaction, no viewer) ----------------------
// Logs have no viewer. public + operational survive; everything else redacts.
// Unclassified/unknown still throws — a leak must never pass silently.
function redact(table, record) {
  guardFields(table, record, "log");
  const { fields } = policyFor(table);
  const out = {};
  for (const [k, v] of Object.entries(record)) {
    out[k] = fields[k].log ? v : "[redacted]";
  }
  return out;
}

module.exports = { project, projectList, PolicyCache, redact };
