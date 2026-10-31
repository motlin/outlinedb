#!/usr/bin/env bash
# Rebuild the cache database from scratch into a new file, then swap it in.
#
# usage: scripts/build-fresh-database.sh [--offline]
# Craig runs it as `op run -- just build-fresh-database`.
#
# The database rebuilt is $WORKFLOWY_DB_PATH, or workflowy.sqlite in the repo root.
# --offline skips every step that needs credentials or the network (Dropbox
# download, epoch fetch, import-api, account state) and needs WORKFLOWY_EPOCH;
# it exists to rehearse the pipeline against a scratch copy.
set -euo pipefail

offline=false
for arg in "$@"; do
    case "$arg" in
        --offline) offline=true ;;
        *)
            echo "unknown argument: $arg" >&2
            exit 2
            ;;
    esac
done

repo=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo"
run="$repo/bin/run.js"
target="${WORKFLOWY_DB_PATH:-$repo/workflowy.sqlite}"
target="$(cd "$(dirname "$target")" && pwd)/$(basename "$target")"
stamp=$(date +%Y-%m-%d-%H%M%S)
base="${target%.sqlite}"
building="$base.rebuilding.sqlite"
backup="$base.pre-rebuild-$stamp.sqlite"

if $offline && [ -z "${WORKFLOWY_EPOCH:-}" ]; then
    echo "--offline needs WORKFLOWY_EPOCH (the epoch fetch needs credentials)" >&2
    exit 2
fi

# Refuse while any other process (e.g. `just web` on 5175/5176) holds the database open.
refuse_if_busy() {
    local holders
    holders=$(lsof -t -- "$target" "$target-wal" "$target-shm" 2>/dev/null | sort -u || true)
    if [ -n "$holders" ]; then
        echo "❌ $target is open in another process; stop it first (e.g. the \`just web\` servers on 5175/5176):" >&2
        ps -o pid=,command= -p "$(echo "$holders" | paste -sd, -)" >&2 || true
        exit 1
    fi
}

step() {
    echo ""
    echo "▶ $*"
}

refuse_if_busy

rm -f "$building" "$building-wal" "$building-shm" "$building-journal"

if [ -f "$target" ]; then
    step "Backing up $target to $backup (kept)"
    sqlite3 "$target" ".backup '$backup'"
else
    backup=""
    echo "No existing database at $target; nothing to back up or carry over"
fi

# WAL is persistent in the file, so every CLI step writes the new database the way `daily` writes the live one
# (the CLI only switches to WAL itself when WORKFLOWY_DB_PATH is unset).
sqlite3 "$building" "pragma journal_mode=wal" >/dev/null
export WORKFLOWY_DB_PATH="$building"

step "Seeding the Workflowy epoch"
if [ -n "${WORKFLOWY_EPOCH:-}" ]; then
    "$run" cache config --set "epoch=$WORKFLOWY_EPOCH"
else
    "$run" cache config --fetch-epoch
fi

if [ -n "$backup" ]; then
    # Before import-api and import-account, which merge the current values on top as new versions.
    step "Carrying over the account tables' history and file_blobs from the previous database"
    # Opening the backup migrates it, so an old schema's account state reaches the typed account tables first.
    WORKFLOWY_DB_PATH="$backup" "$run" cache status >/dev/null
    "$run" cache import-local-state --from "$backup"
fi

step "Importing every backup oldest-first, each stamped with its own time and taken verbatim"
if $offline; then
    "$run" cache import-backups --no-download --no-archive --backup-system-time --force --no-embeddings
else
    "$run" cache import-backups --backup-system-time --force --no-embeddings
fi

if $offline; then
    step "Skipping import-api and account state (--offline)"
else
    step "Catching up past the last backup from the API (also item metadata, tree transaction id, expanded keys)"
    "$run" cache import-api
    step "Fetching account state (account incl. entropy key, root metadata incl. tag colors and stars, settings, visible features)"
    "$run" cache import-account
fi

step "Generating embeddings and the full-text index"
"$run" ai embed

step "Vacuuming"
"$run" cache vacuum

step "Swapping $building into $target"
refuse_if_busy
sqlite3 "$building" "pragma journal_mode=delete" >/dev/null
rm -f "$target-wal" "$target-shm"
mv "$building" "$target"
rm -f "$building-wal" "$building-shm" "$building-journal"

# One line per table: name|total rows|live rows (or - when the table is not bitemporal)|duplicate (key, system_to) groups
table_stats() {
    local db=$1
    local q=(sqlite3 -readonly "$db")
    local tables
    tables=$("${q[@]}" "select name from sqlite_master where type='table' and name not like 'sqlite_%' and name not like '__drizzle%' and sql not like 'CREATE VIRTUAL%' and name not like '%_vec%' order by name")
    for table in $tables; do
        local total live dups keys
        total=$("${q[@]}" "select count(*) from \"$table\"")
        if [ "$("${q[@]}" "select count(*) from pragma_table_info('$table') where name='system_to'")" = 1 ]; then
            live=$("${q[@]}" "select count(*) from \"$table\" where system_to='9999-12-31 23:59:59'")
            keys=$("${q[@]}" "select group_concat(name, ', ') from (select name from pragma_table_info('$table') where pk > 0 and name not in ('system_from', 'system_to') order by pk)")
            if [ -n "$keys" ]; then
                dups=$("${q[@]}" "select count(*) from (select 1 from \"$table\" group by $keys, system_to having count(*) > 1)")
            else
                dups="-"
            fi
        else
            live="-"
            dups="-"
        fi
        echo "$table|$total|$live|$dups"
    done
}

echo ""
echo "✅ Rebuilt $target"
echo ""
if [ -n "$backup" ]; then
    echo "File size: $(stat -f %z "$backup") bytes before → $(stat -f %z "$target") bytes after"
    echo ""
    join -t'|' -a1 -a2 -e'0' -o '0,1.2,1.3,1.4,2.2,2.3,2.4' \
        <(table_stats "$backup" | sort) <(table_stats "$target" | sort) |
        (
            echo "table|before rows|before live|before dup groups|after rows|after live|after dup groups"
            cat
        ) | column -t -s'|'
    echo ""
    echo "Previous database kept at $backup"
else
    echo "File size: $(stat -f %z "$target") bytes"
    echo ""
    (
        echo "table|rows|live|dup groups"
        table_stats "$target"
    ) | column -t -s'|'
fi
