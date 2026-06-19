// rachette/server.js
// A thin HTTP framework whose entire job is to OWN THE EXITS. Handlers are given
// a context with policy-aware reply builders; they never receive the raw socket,
// so there is no `res.json(rawObject)` to forget. The only path from a record to
// the wire runs through projection (Door 1). The same context exposes the cache
// (Door 2) and log (Door 3) doors. Every door runs the field guard first.
//
// This is deliberately small. It is not Express. It exists to show what "the
// framework owns the exits" looks like end to end; in a real codebase you would
// apply the same three doors inside whatever framework you already use.

const http = require("node:http");
const { project, projectList, PolicyCache, redact } = require("./exits");

// Request bodies are capped so a single oversized POST/PUT can't exhaust memory.
const MAX_BODY_BYTES = 1 << 20; // 1 MiB

// Read and JSON-parse a request body, rejecting bodies over the cap or with
// malformed JSON. Resolves `undefined` for an empty body (e.g. a bare PUT).
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { req.destroy(); reject(new Error("body too large")); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve(undefined);
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new Error("invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

function send(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, { "content-type": "application/json", ...extraHeaders });
  res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
}

function createApp({ logger } = {}) {
  const routes = [];
  const cache = new PolicyCache();
  const log = logger || ((tag, obj) => console.log(tag, JSON.stringify(obj)));

  const add = (method, pattern, handler) =>
    routes.push({ method, parts: pattern.split("/").filter(Boolean), handler });

  // The reply descriptors a handler may return. None of these write bytes; they
  // describe WHAT to send, and the framework does the projecting + writing.
  // There is deliberately NO raw-object door: every object that can leave is
  // either a projected record (resource/list) or a fixed-shape {error} string.
  // That closes the "reply.raw(200, userRow)" bypass — the unsafe way to reply
  // no longer sits next to the safe one.
  const reply = {
    resource: (table, record, meta) => ({ __kind: "resource", table, record, meta }),
    list:     (table, records) => ({ __kind: "list", table, records }),
    error:    (status, message) => ({ __kind: "error", status, message: String(message) }),
    notFound: () => ({ __kind: "error", status: 404, message: "not found" }),
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const reqParts = url.pathname.split("/").filter(Boolean);

    // INTEGRATION SEAM — auth. The demo derives the viewer from request headers;
    // a real app resolves it from a verified session/token. Everything downstream
    // only needs `{ id, role }`, so this is the one line you swap for production.
    const viewer = req.headers["x-user-id"]
      ? { id: Number(req.headers["x-user-id"]), role: req.headers["x-role"] || "member" }
      : null;

    const route = routes.find((r) =>
      r.method === req.method && r.parts.length === reqParts.length &&
      r.parts.every((p, i) => p.startsWith(":") || p === reqParts[i]));

    if (!route) return send(res, 404, { error: "no route" });

    // Parse the body for methods that carry one, with the cap above. A bad or
    // oversized body is a client error (400), not a server fault.
    let body;
    if (req.method !== "GET" && req.method !== "HEAD") {
      try { body = await readJsonBody(req); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }

    const params = {};
    route.parts.forEach((p, i) => { if (p.startsWith(":")) params[p.slice(1)] = reqParts[i]; });

    const ctx = {
      params, viewer, body, cache, reply,
      log: (table, rec) => log("[log]", redact(table, rec)), // Door 3
    };

    let status = 200, payload, headers = {};
    try {
      const out = await route.handler(ctx);
      // Projection runs INSIDE this try: if a door throws (unknown/unclassified
      // field), we fail the request CLOSED (500 below) instead of leaking.
      if (!out) { status = 204; payload = ""; }
      else if (out.__kind === "resource") {
        payload = project(out.table, out.record, viewer); // Door 1
        if (out.meta && out.meta.cache) headers["x-rachette-cache"] = out.meta.cache;
      }
      else if (out.__kind === "list") payload = projectList(out.table, out.records, viewer);
      else if (out.__kind === "error") { status = out.status; payload = { error: out.message }; }
      else throw new Error("handler returned a non-descriptor value");
    } catch (e) {
      // Fail closed: a field that couldn't be classified at a door never escapes
      // as data — the request errors instead. The reason is logged server-side.
      log("[blocked]", { path: url.pathname, reason: e.message });
      return send(res, 500, { error: "blocked by policy", detail: e.message });
    }

    send(res, status, payload, headers);
  });

  return {
    get:    (p, h) => add("GET", p, h),
    post:   (p, h) => add("POST", p, h),
    put:    (p, h) => add("PUT", p, h),
    patch:  (p, h) => add("PATCH", p, h),
    delete: (p, h) => add("DELETE", p, h),
    cache,
    listen: (...a) => server.listen(...a),
    close:  () => server.close(),
  };
}

module.exports = { createApp };
