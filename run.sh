#!/usr/bin/env bash
# One command to see the whole thing.
set -e
cd "$(dirname "$0")"
echo "### 1. seed a real SQLite db"; node seed.js 2>/dev/null
echo; echo "### 2. generate policy (new columns => UNCLASSIFIED)"; node cli.js generate users 2>/dev/null
echo; echo "### 3. audit (CI ratchet) — every table, red until every column is classified"
node cli.js audit 2>/dev/null || echo "   (exit 1 — build would fail here)"
echo; echo "### 4. tests"; node --test 2>/dev/null | grep -E '^. (tests|pass|fail) '
echo; echo "### 5. run the live demo"; node driver.js 2>/dev/null
