#!/usr/bin/env bash
# Rebuild the cache database from scratch into a new file, then swap it in.
#
# usage: scripts/build-fresh-database.sh [--offline | --swap-only]
# Craig runs it as `op run -- just build-fresh-database`.
#
# The database rebuilt is $WORKFLOWY_DB_PATH, or workflowy.sqlite in the repo root.
# --offline skips every step that needs credentials or the network (Dropbox
# download, account state, import-api) and needs WORKFLOWY_EPOCH;
# it exists to rehearse the pipeline against a scratch copy.
# --swap-only skips the rebuild and swaps an existing workflowy.rebuilding.sqlite in,
# for a run that finished but refused its swap; the old database is moved aside as a pre-rebuild backup.
set -euo pipefail

offline=false
swap_only=false
for arg in "$@"; do
    case "$arg" in
        --offline) offline=true ;;
        --swap-only) swap_only=true ;;
        *)
            echo "unknown argument: $arg" >&2
            exit 2
            ;;
    esac
done

repo=$(cd "$(dirname "$0")/.." && pwd -P)
cd "$repo"
run="$repo/bin/run.js"
target="${WORKFLOWY_DB_PATH:-$repo/workflowy.sqlite}"
target="$(cd "$(dirname "$target")" && pwd)/$(basename "$target")"
stamp=$(date +%Y-%m-%d-%H%M%S)
base="${target%.sqlite}"
building="$base.rebuilding.sqlite"
backup="$base.pre-rebuild-$stamp.sqlite"

if $offline && $swap_only; then
    echo "--offline and --swap-only cannot be combined" >&2
    exit 2
fi

if $offline && [ -z "${WORKFLOWY_EPOCH:-}" ]; then
    echo "--offline needs WORKFLOWY_EPOCH (the account import, which stores the join date, needs credentials)" >&2
    exit 2
fi

# `just web` runs the API server under concurrently + `tsx watch`, which respawns the server when only the server is killed,
# so its database handle comes back mid-rebuild; refuse while that watcher runs in this checkout.
refuse_if_web_watcher() {
    local pid watchers=()
    for pid in $(pgrep -f 'tsx watch' || true); do
        if [ "$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')" = "$repo/packages/web" ]; then
            watchers+=("$pid")
        fi
    done
    if [ ${#watchers[@]} -gt 0 ]; then
        echo "❌ \`just web\` is running in $repo; stop it (Ctrl-C in its terminal), since its \`tsx watch\` respawns the server and reopens $target:" >&2
        ps -o pid=,command= -p "$(
            IFS=,
            echo "${watchers[*]}"
        )" >&2 || true
        exit 1
    fi
}

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

swap_in() {
    step "Swapping $building into $target"
    refuse_if_web_watcher
    refuse_if_busy
    sqlite3 "$building" "pragma journal_mode=delete" >/dev/null
    rm -f "$target-wal" "$target-shm"
    mv "$building" "$target"
    rm -f "$building-wal" "$building-shm" "$building-journal"
}

refuse_if_web_watcher
refuse_if_busy

if $swap_only; then
    if [ ! -f "$building" ]; then
        echo "❌ --swap-only needs $building, which does not exist" >&2
        exit 1
    fi
    if [ -f "$target" ]; then
        step "Moving $target aside to $backup (kept)"
        # Folds the WAL into the file so the moved-aside database stands on its own.
        sqlite3 "$target" "pragma wal_checkpoint(truncate)" >/dev/null
        mv "$target" "$backup"
        rm -f "$target-wal" "$target-shm"
    else
        backup=""
    fi
    swap_in
else
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

    if [ -n "$backup" ]; then
        # Before import-account and import-api, which merge the current values on top as new versions.
        step "Carrying over the account tables' history and file_blobs from the previous database"
        # Opening the backup migrates it, so an old schema's account state reaches the typed account tables first.
        WORKFLOWY_DB_PATH="$backup" "$run" cache status >/dev/null
        "$run" cache import-local-state --from "$backup"
    fi

    # The backups' timestamps count from the account's join date: WORKFLOWY_EPOCH when set, else account.date_joined_sec.
    if $offline; then
        step "Skipping account state (--offline); the backups use WORKFLOWY_EPOCH"
    else
        step "Fetching account state (account incl. join date and entropy key, root metadata incl. tag colors and stars, settings, visible features)"
        "$run" cache import-account
    fi

    step "Importing every backup oldest-first, each stamped with its own time and taken verbatim"
    if $offline; then
        "$run" cache import-backups --no-download --no-archive --backup-system-time --force --no-embeddings
    else
        "$run" cache import-backups --backup-system-time --force --no-embeddings
    fi

    if $offline; then
        step "Skipping import-api (--offline)"
    else
        step "Catching up past the last backup from the API (also item metadata, tree transaction id, expanded keys)"
        "$run" cache import-api
    fi

    # Recheck before the hours of embeddings, so a `just web` started mid-run fails here rather than at the swap.
    refuse_if_web_watcher
    step "Generating embeddings and the full-text index"
    "$run" ai embed

    step "Vacuuming"
    "$run" cache vacuum

    swap_in
fi

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
    echo "File size: $(wc -c <"$backup" | tr -d " ") bytes before → $(wc -c <"$target" | tr -d " ") bytes after"
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
    echo "File size: $(wc -c <"$target" | tr -d " ") bytes"
    echo ""
    (
        echo "table|rows|live|dup groups"
        table_stats "$target"
    ) | column -t -s'|'
fi
