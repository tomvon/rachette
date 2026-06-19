// rachette/markers.js
// A classification is defined by what it permits at EACH door, not by a single
// rank. This is the fix for the log-readability problem found by running the
// POC: response-visibility and log-visibility are two different axes, so a field
// can be fine in logs (an operational timestamp) yet never allowed in a response.
//
// Each marker answers three independent questions:
//   response(viewer, record) -> include this field in an HTTP response?
//   log                       -> include this field in a log line? (no viewer)
//   cacheShard                -> "public" (CDN-safe) | "private" | "none"

const isOwnerOrAdmin = (viewer, record, ownerOf) =>
  !!viewer && (viewer.role === "admin" || (ownerOf && ownerOf(viewer, record)));

const PUBLIC = {
  tag: "public",
  response: () => true,
  log: true,
  cacheShard: "public",
};

const PRIVATE = {
  tag: "private",
  response: (viewer, record, ownerOf) => isOwnerOrAdmin(viewer, record, ownerOf),
  log: false,
  cacheShard: "private",
};

// Server-side only. Never leaves through any external door.
const INTERNAL = {
  tag: "internal",
  response: () => false,
  log: false,
  cacheShard: "none",
};

// Safe for logs/ops, never for external responses. Timestamps, status, role,
// feature flags — the fields you want when debugging but never in an API payload.
const OPERATIONAL = {
  tag: "operational",
  response: () => false,
  log: true,
  cacheShard: "none",
};

// The whole point. Not a comment — a value that FAILS at every door until a
// human replaces it. New columns are born here.
const UNCLASSIFIED = {
  tag: "UNCLASSIFIED",
  response: () => { throw unclassified(); },
  log: false,
  cacheShard: "none",
  __unclassified: true,
};
function unclassified() { return new Error("UNCLASSIFIED"); }

module.exports = { PUBLIC, PRIVATE, INTERNAL, OPERATIONAL, UNCLASSIFIED };
