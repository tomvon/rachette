// AUTO-GENERATED policy scaffold for "users". Safe to hand-edit: re-running
// the generator preserves your labels and only appends new columns (as
// UNCLASSIFIED). Keep one `field: MARKER,` per line so that preservation works.
// New columns arrive UNCLASSIFIED and fail every exit until you classify them.
const { PUBLIC, PRIVATE, INTERNAL, OPERATIONAL, UNCLASSIFIED } = require("../rachette/markers");

module.exports = {
  table: "users",
  // owner check used by PRIVATE fields:
  ownerOf: (viewer, record) => viewer && viewer.id === record.id,
  fields: {
    id: PUBLIC,
    name: PUBLIC,
    email: PRIVATE,
    phone_number: PRIVATE,
    role: OPERATIONAL,
    created_at: OPERATIONAL,
  },
};
