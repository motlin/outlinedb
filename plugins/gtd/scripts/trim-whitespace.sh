#!/bin/bash
# One-time sweep: strip leading/trailing whitespace from Workflowy node names.
#
# The mobile UI leaves a trailing space on most nodes; this backfills the fix
# across the whole tree. Reads the SQLite cache read-only to find offenders,
# then writes each correction through the CLI (never mutates SQLite directly),
# guarding every update with --expect-name so a stale cache can't clobber a node.
#
# Usage:
#   trim-whitespace.sh            # dry run: report offenders, write nothing
#   trim-whitespace.sh --apply    # execute the corrections
#
# Conservative by design: strips only leading/trailing whitespace (never touches
# internal spacing), and skips any node whose trimmed name would be empty.
set -Eeuo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
DB="$PROJECT_ROOT/outlinedb.sqlite"
CLI="$PROJECT_ROOT/bin/run.js"
APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

[ -f "$DB" ] || { echo "Error: $DB not found" >&2; exit 1; }

APPLY="$APPLY" python3 - "$DB" "$CLI" <<'PY'
import os, sqlite3, subprocess, sys
db, cli = sys.argv[1], sys.argv[2]
apply = os.environ.get("APPLY") == "1"
con = sqlite3.connect(db)
rows = con.execute(
    "SELECT id, name FROM node_content "
    "WHERE system_to='9999-12-31 23:59:59' "
    "AND name IS NOT NULL AND name <> trim(name)"
).fetchall()

work = []
for nid, name in rows:
    trimmed = name.strip()
    if trimmed and trimmed != name:
        work.append((nid, name, trimmed))

print(f"Nodes with leading/trailing whitespace: {len(work)}")
for nid, old, new in work[:10]:
    print(f"  [{old!r}] -> [{new!r}]")
if len(work) > 10:
    print(f"  … and {len(work) - 10} more")

if not apply:
    print("\nDry run — nothing written. Re-run with --apply to execute.")
    sys.exit(0)

ok = fail = 0
failures = []
for i, (nid, old, new) in enumerate(work, 1):
    r = subprocess.run(
        [cli, "node", "update", "--id", nid, "--name", new, "--expect-name", old],
        capture_output=True, text=True,
    )
    if r.returncode == 0:
        ok += 1
    else:
        fail += 1
        failures.append((nid, (r.stderr or r.stdout).strip()[:200]))
    if i % 200 == 0:
        print(f"  … {i}/{len(work)} ({ok} ok, {fail} failed)")

print(f"\nDone: {ok} trimmed, {fail} failed.")
for nid, err in failures[:20]:
    print(f"  FAIL {nid}: {err}")
PY
