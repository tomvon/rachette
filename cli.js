// cli.js — rachette commands:
//   node cli.js generate <table...>   write/refresh a policy scaffold from the live schema
//   node cli.js audit [table...]      check classifications; no args = every table (CI mode)
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");
const { generate } = require("./rachette/generate");
const { audit } = require("./rachette/audit");

const [cmd, ...tables] = process.argv.slice(2);
const db = new DatabaseSync("app.db");
const policyDir = path.join(__dirname, "policies");

// Discover every table worth auditing: the union of real DB tables and existing
// policy files. This is why `audit` needs no arguments in CI — a new table (with
// or without a policy) is found automatically, so the check can never silently
// skip something just because nobody updated a hardcoded list.
function discoverTables() {
  const fromDb = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all().map((r) => r.name);
  const fromPolicies = fs.existsSync(policyDir)
    ? fs.readdirSync(policyDir).filter((f) => f.endsWith(".policy.js")).map((f) => f.slice(0, -".policy.js".length))
    : [];
  return [...new Set([...fromDb, ...fromPolicies])];
}

if (cmd === "generate") {
  if (!tables.length) { console.error("usage: node cli.js generate <table...>"); db.close(); process.exit(2); }
  for (const t of tables) {
    const { filePath, columns, added } = generate(db, t, policyDir);
    console.log(`generated ${path.basename(filePath)}  (${columns.length} cols`
      + (added.length ? `, NEW→UNCLASSIFIED: ${added.join(", ")}` : "") + ")");
  }
} else if (cmd === "audit") {
  const targets = tables.length ? tables : discoverTables();
  // Drop any cached policy modules so an audit always reflects the file on disk.
  for (const t of targets) delete require.cache[path.join(policyDir, `${t}.policy.js`)];
  const problems = audit(db, targets, policyDir);
  if (problems.length) {
    console.error("rachette — audit failed:");
    problems.forEach((p) => console.error("  ✗ " + p));
    db.close(); process.exit(1);
  }
  console.log(`rachette — audit passed ✓  every column classified (${targets.length} table(s)).`);
} else {
  console.log("usage: node cli.js [generate|audit] <table...>");
}
db.close();
