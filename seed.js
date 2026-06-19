// seed.js — create a real SQLite DB with a users table + rows.
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("app.db");
db.exec("DROP TABLE IF EXISTS users");
db.exec(`CREATE TABLE users (
  id INTEGER PRIMARY KEY, name TEXT, email TEXT,
  phone_number TEXT, role TEXT, created_at TEXT
)`);
const ins = db.prepare("INSERT INTO users VALUES (?,?,?,?,?,?)");
ins.run(7, "Dana Reyes", "dana@example.com", "555-0142", "member", "2024-03-01");
ins.run(8, "Lee Okafor", "lee@example.com",  "555-0199", "admin",  "2024-04-15");
console.log("seeded app.db with", db.prepare("SELECT count(*) c FROM users").get().c, "users");
db.close();
