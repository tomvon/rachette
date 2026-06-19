// driver.js — starts the app on an ephemeral port, fires requests, exits clean.
// This is the narrated demo: each section exercises one door from the outside,
// over real HTTP, so what you see is exactly what a client would get.
const http = require("node:http");
const app = require("./app");

const srv = app.listen(0);
const port = srv.address().port;

// Minimal HTTP client: method + path + headers + optional JSON body.
function req(method, path, headers = {}, body) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const r = http.request({ port, method, path,
      headers: { ...headers, ...(payload ? { "content-type": "application/json" } : {}) } },
      (res) => {
        let b = ""; res.on("data", (d) => (b += d));
        res.on("end", () => resolve({ status: res.statusCode, cache: res.headers["x-rachette-cache"], body: b }));
      });
    if (payload) r.write(payload);
    r.end();
  });
}
const get = (path, headers) => req("GET", path, headers);
const put = (path, body, headers) => req("PUT", path, headers, body);
const show = (label, r) =>
  console.log(label + "\n   " + (r.cache ? `[x-rachette-cache: ${r.cache}] ` : "") + r.body);

(async () => {
  const owner = { "x-user-id": "7", "x-role": "member" };
  const stranger = { "x-user-id": "99", "x-role": "member" };
  const admin = { "x-user-id": "1", "x-role": "admin" };

  console.log("\n#### DOOR 1 — response projection, same record three ways ####");
  show("owner (id=7) sees own private fields:", await get("/users/7", owner));
  show("stranger sees public only:", await get("/users/7", stranger));
  show("admin sees private fields:", await get("/users/7", admin));
  show("anonymous sees public only:", await get("/users/7"));

  console.log("\n#### DOOR 2 — cache: split public shard + per-owner overlay, versioned ####");
  show("owner again -> served from cache, full:", await get("/users/7", owner));
  show("stranger hits same cache -> overlay withheld:", await get("/users/7", stranger));

  console.log("\n#### DOOR 2b — a row changes via PUT; the cache self-versions ####");
  show("owner edits their name (PUT):", await put("/users/7", { name: "Dana Reyes-Smith" }, owner));
  show("next read -> fresh value, new version, no manual purge:", await get("/users/7", owner));
  show("stranger tries to edit someone else -> authorization, not field policy:",
    await put("/users/7", { name: "hacked" }, stranger));

  console.log("\n#### list endpoint — every row projected for the viewer ####");
  show("list as stranger:", await get("/users", stranger));

  console.log("\n#### DOOR 3 — log redaction is happening server-side (see notes) ####");
  console.log("   (each request above logged a redacted line: private fields [redacted],");
  console.log("    operational fields like role/created_at kept for debugging)");

  console.log("\n#### RUNTIME BACKSTOP — handler attaches a field not in the policy ####");
  show("/leak/7 -> door blocks the undeclared session_token:", await get("/leak/7", owner));

  srv.close(() => process.exit(0));
})();
