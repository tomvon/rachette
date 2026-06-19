# rachette

**A database field can't reach a response, a cache, or a log unless a human has
classified it.** Data stays plain inside your app; the framework guards the three
points where data leaves. New columns are born `UNCLASSIFIED` and fail the build
until someone labels them.

~500 lines, zero runtime dependencies, real SQLite, a test suite. Run `./run.sh`.

---

## Status — read this first

A free, MIT-licensed reference implementation of one idea, done carefully. It is
**not a turnkey product** and **not a security guarantee**. It makes one common
kind of accidental data exposure hard to do *by accident*; it does not promise to
prevent leaks and does not catch every kind (see [Threat model](#threat-model)).
Don't make it your only defense. Provided as-is, no warranty — see `LICENSE`.

It *is* written to production standards: fails closed, bounds its own memory,
caps request bodies, autodiscovers tables in CI, and ships with tests. Adopting
it means routing your reads/writes/logs through its three doors — see
[Using it in a real app](#using-it-in-a-real-app).

---

## The idea

Most data leaks aren't villains — they're a tired person grabbing the unsafe way
to do something because it sits right next to the safe way. rachette removes the
unsafe way at the three points where data leaves:

- **Response** — each field is shown only to viewers allowed to see it (you see
  your own email; a stranger sees just your name).
- **Cache** — public fields cached once and shared; private fields kept separate
  and added back only for the right viewer. Keys are version-stamped, so a changed
  row just stops being read.
- **Log** — private fields redacted automatically; only public/operational survive.

A field's label is a single decision that answers all three doors at once.

## The five labels

Each label is defined by what it permits at **each door** — not by a single rank.
(Response-visibility and log-visibility are different axes: an operational
timestamp is fine in a log yet must never appear in an API response.)

| label         | response        | log       | cache        |
|---------------|-----------------|-----------|--------------|
| `PUBLIC`      | everyone        | shown     | shared       |
| `PRIVATE`     | owner or admin  | redacted  | per-owner    |
| `INTERNAL`    | never           | redacted  | not cached   |
| `OPERATIONAL` | never           | shown     | not cached   |
| `UNCLASSIFIED`| **fails**       | **fails** | **fails**    |

## The ratchet (where the name comes from)

A ratchet only turns one way. That's the mechanism:

1. A **generator** reads your live schema and writes a policy file. Every new
   column arrives `UNCLASSIFIED`; existing labels are never overwritten.
2. An **audit** (run in CI) fails the build on any `UNCLASSIFIED` field — or any
   column present in the DB but missing from the policy.

So adding a column turns the build red until someone decides who may see it. The
visibility decision happens the day the field is created, by the person creating
it — not after it leaks. You stop having to *remember to be careful*; you only
answer the question when it's put in front of you.

## Quick start

```bash
./run.sh        # seed a db, generate + audit the policy, run tests, run the live demo
```

Or step by step:

```bash
node seed.js               # create a real SQLite db (stands in for your migrations)
node cli.js generate users # write/refresh policies/users.policy.js from the schema
node cli.js audit          # CI ratchet — green only when every column is classified
node --test                # the test suite
node app.js                # start the service on :3000
```

The day-to-day loop after a schema change:

```bash
node cli.js generate users   # adds new columns as UNCLASSIFIED
# ...open policies/users.policy.js, label the new field (PUBLIC/PRIVATE/...)...
node cli.js audit            # green once everything is classified
```

## The three doors, in code

Handlers return *descriptors*; the framework projects per viewer. There is no raw
reply to forget — `reply.resource`/`reply.list` always project, and the only other
exit is a fixed-shape `{error}`.

```js
// Door 1 (response), Door 2 (cache), Door 3 (log) — all from one handler:
app.get("/users/:id", (ctx) => {
  const id = Number(ctx.params.id);
  const hit = ctx.cache.read("users", id, ctx.viewer);   // Door 2: version resolved internally
  if (hit) return ctx.reply.resource("users", hit, { cache: "HIT" });
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  if (!row) return ctx.reply.notFound();
  ctx.cache.write("users", row);                         // Door 2: bumps version, retires stale entry
  ctx.log("users", row);                                 // Door 3: redacts private fields
  return ctx.reply.resource("users", row);               // Door 1: projects per viewer
});
```

**Door 2 owns its versioning.** Callers never pass a version number. Each
`cache.write` bumps a per-row counter and stamps fresh shards; `cache.read`
resolves the current version. A changed row writes a new key and reads follow it
automatically — no manual purge. The superseded version is retired on write, so
the in-process store stays bounded (one live version per row).

## The runtime backstop

The build-time audit only sees *declared* columns. A field invented in a handler
(a `SELECT *` leftover, a derived value, a hand-attached `session_token`) was never
in the schema, so CI can't catch it. The doors run a guard over the record's
**actual keys** at request time and fail closed on anything unclassified:

```
GET /leak/7
-> 500 { "error": "blocked by policy",
         "detail": "[response] \"users.session_token\" is not in the policy..." }
```

## Using it in a real app

rachette *is* a small HTTP framework here so the demo can show "the framework owns
the exits" end to end. To adopt the idea in an existing codebase you apply the same
three doors inside whatever framework you already use. The integration seams:

- **Auth (the viewer).** `server.js` derives the viewer from request headers for
  the demo. Replace that one line with your verified session/token. Everything
  downstream only needs `{ id, role }`.
- **Database.** Handlers use plain `node:sqlite` prepared statements. Swap in your
  driver/ORM; rachette never touches the DB itself — it guards what leaves.
- **Writes.** On any mutation, call `ctx.cache.write(table, newRow)` to refresh
  the cache (see `PUT /users/:id` in `app.js`). The same handler shows that
  **field policy is not authorization** — rachette governs which *fields* leave;
  your app still decides who may *act* (the `403 forbidden` check).
- **Owner key.** The generated `ownerOf(viewer, record)` assumes a row is owned by
  its own `id` (the users-table shape). For a table owned by a different column
  (e.g. `record.user_id === viewer.id`), edit `ownerOf` — and note the cache caveat
  in [Limits](#limits).

## Threat model

**What it makes much harder:**

- Shipping a new column that silently rides along in every API response.
- A private field landing in application logs.
- A private field being served to the wrong viewer from a shared cache.
- A handler hand-attaching an off-schema secret to a response.

**What it does *not* do:**

- It is **not authorization.** It governs which *fields* leave, not which
  *actions* a user may take. Pair it with your own authz.
- It does not follow data into *derived* values. Bake a private field into a new
  value (a count, a hash, a concatenation) and that value has no label and passes.
  Information-flow tracking through arbitrary computation is a famously unsolved
  problem and is out of scope.
- It only guards the doors it owns. A stray `console.log(row)`, a third-party
  logger, an ORM `.toJSON()`, or a raw `res.end(...)` bypasses it. The guarantee
  is only as good as your discipline in routing output through the doors.

## Limits

- The audit only sees *declared* columns; raw-query and untyped-blob fields are
  caught at runtime (the backstop), not pre-empted at build time.
- The cache's per-owner overlay (Door 2) currently assumes a row is owned by its
  own `id`. Tables owned by a different key need an explicit owner-key in the
  policy; that generalization isn't built here (a code comment marks the spot).
- The generator preserves your labels by reading `field: MARKER,` lines as text.
  Keep one field per line (the format it emits) and edits round-trip cleanly.

## Testing

```bash
node --test
```

Zero-dependency `node:test` suite covering all three doors, the runtime guard, the
CI ratchet (including drift in both directions and a table with no policy), and
the generator's preserve-on-regenerate behavior. Uses in-memory SQLite and a temp
dir, so it touches nothing on disk.

## Files

```
rachette/markers.js   labels x doors        rachette/generate.js  schema -> policy
rachette/policy.js    registry + guard      rachette/audit.js     CI ratchet
rachette/exits.js     the three doors       rachette/server.js    framework (owns exits)
app.js  cli.js  driver.js  seed.js  run.sh  policies/users.policy.js  test/rachette.test.js
```

## Make CI actually block merges

By default a failed check shows a red ✗ but doesn't stop anyone. To turn it into a
wall: on GitHub go to **Settings → Branches → Add branch ruleset** for `main` and
enable **Require status checks to pass before merging**, then select the `rachette`
check (it appears after the workflow has run once). Without this the ratchet only
*warns*; with it, an unclassified field can't be merged.

## Prior art

Nothing here is novel in isolation — field-level authorization, log redaction,
column classification, and information-flow control are all well-trodden. The only
uncommon bit is the combination: one field policy across response + cache + log,
plus a default-deny ratchet where a new column breaks the build instead of silently
going unprotected. A reference implementation, not a claim of novelty.

## License

MIT License — Copyright (c) 2026 Tom Von Lahndorff

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

See [`LICENSE`](LICENSE) for the canonical copy.
