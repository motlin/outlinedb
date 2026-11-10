# `just --list --unsorted`
[group('default')]
default:
    @just --list --unsorted

ci := env("CI", "")

export PATH := justfile_directory() / "node_modules/.bin" + ":" + env("PATH")

# Install dependencies and rebuild native modules
[group('setup')]
install:
    pnpm install
    just ensure-sqlite-native
    vp fmt CLAUDE.md AGENTS.md

# Verify better-sqlite3 native modules match the active Node runtime
[group('setup')]
ensure-sqlite-native:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ ! -d node_modules/.pnpm ]; then
        exit 0
    fi
    find node_modules/.pnpm -path "*/node_modules/better-sqlite3/package.json" -print | sort | while IFS= read -r package_json; do
        package_dir="$PWD/$(dirname "$package_json")"
        if node -e 'const Database = require(process.argv[1]); new Database(":memory:").close();' "$package_dir" >/dev/null 2>&1; then
            continue
        fi
        rm -rf "$package_dir/build"
        pnpm --dir "$package_dir" run build-release
        node -e 'const Database = require(process.argv[1]); new Database(":memory:").close();' "$package_dir"
    done

# Run dev server, node host (shared code live from source; see `web`)
dev-node *args: build-shared
    OUTLINEDB_DB_PATH={{ justfile_directory() }}/outlinedb.sqlite vp run --filter @outlinedb/web dev {{ args }}

# Run linter
[group('lint')]
lint: install
    vp lint {{ if ci != "" { "--format github" } else { "--fix" } }}

# Run formatter
[group('lint')]
format: install
    pre-commit run just-fmt --all-files
    vp fmt {{ if ci != "" { "--check" } else { "" } }}

# Run checks (format + lint + typecheck)
[group('lint')]
check *args: build-shared
    vp run --cache check {{ if ci != "" { "" } else { "--fix" } }} {{ args }}

# Run tests
[group('test')]
test *args: build-shared
    CHAI_TRUNCATE_THRESHOLD=0 vp run --cache test:run {{ args }}

# Run the Worker tests (also part of `test`)
[group('test')]
cf-test: build-shared
    vp test run --project cloudflare

# Run the SPA and the Worker together in local workerd (Cloudflare Vite plugin; R2 and Durable Objects simulated, no Cloudflare account needed) with a fixed dev identity; state persists in packages/cloudflare/.wrangler/state. `dev-node` keeps the two-process Node host over outlinedb.sqlite
[group('web')]
dev *args: build-shared cf-d1-migrate-local
    cd packages/web && ACCESS_DEV_IDENTITY="${ACCESS_DEV_IDENTITY:-dev}" vp dev -c vite.worker.config.ts {{ args }}

# Apply the AUTH_DB D1 migrations to the local state `just dev` uses (WORKER_PERSIST_DIR overrides it, as in vite.worker.config.ts)
[group('web')]
cf-d1-migrate-local:
    cd packages/cloudflare && vp exec wrangler d1 migrations apply AUTH_DB --local --persist-to "${WORKER_PERSIST_DIR:-.wrangler/state}"

# Build the client and the Worker with the Cloudflare Vite plugin; writes packages/web/dist/outlinedb/worker/wrangler.json for cf-deploy
[group('web')]
cf-build: build-shared
    cd packages/web && vp build -c vite.worker.config.ts

# Browser smoke test against a fresh `just dev` with a fake upstream (outside verify, like the evals)
[group('test')]
cf-smoke: build-shared
    node packages/cloudflare/smoke/run-smoke.ts

# Seed the account state (account tables and expanded keys) into a Worker's Durable Object (post-deploy step; pass the Worker URL)
[group('web')]
cf-seed-account url:
    ./bin/run.js cache seed-account-state --url {{ url }}

# Deploy the Worker by hand; CI deploys on every push to main (push.yml), so prefer pushing. Refuses unless CONFIRM_DEPLOY=1; never part of verify
[group('web')]
cf-deploy:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ "${CONFIRM_DEPLOY:-}" != "1" ]; then
        echo "cf-deploy refused: set CONFIRM_DEPLOY=1 to deploy" >&2
        exit 1
    fi
    just cf-build
    cd packages/web && vp exec wrangler deploy -c dist/outlinedb/worker/wrangler.json

# Run the plugin script tests, which vitest does not glob
[group('test')]
test-plugins:
    node --test plugins/gtd/scripts/*.test.mts

# No --cache on tsc: vp's cache tracking cannot see the native tsc 7 binary's reads or writes, so every run was a hit that never rebuilt
# Type-check the project, including the web package, which the root solution does not reference (its types read shared dist)
[group('build')]
typecheck: build-shared
    vp run typecheck
    vp run --filter @outlinedb/web typecheck
    vp run --filter @outlinedb/web build:types
    vp run --filter @outlinedb/cloudflare typecheck

# Remove all dist dirs and tsbuildinfo to prevent stale artifacts (used by git-test)
[group('build')]
clean:
    rm -rf \
        packages/shared/dist \
        packages/shared/tsconfig.tsbuildinfo \
        packages/shared/test/tsconfig.tsbuildinfo \
        packages/cli/dist \
        packages/cli/tsconfig.tsbuildinfo \
        packages/cli/test/tsconfig.tsbuildinfo \
        packages/mcp/dist \
        packages/mcp/tsconfig.tsbuildinfo \
        packages/web/dist \
        packages/web/tsconfig.tsbuildinfo \
        dist-test \
        dist-test/tsconfig.tsbuildinfo

# No --cache on tsc: see typecheck
# Build the project
[group('build')]
build: build-shared
    vp run build

# Apply safe Fallow fixes locally, then reject remaining dead code
[group('build')]
fallow: install
    {{ if ci == "" { "vp run fallow" } else { "true" } }}
    vp run fallow:ci

# vp run fallow:ci
[group('build')]
fallow-check: install
    vp run fallow:ci

# Build the shared package
[group('build')]
build-shared: install
    vp run --filter @outlinedb/shared build

# Regenerate the oclif usage and command sections of README.md from the built CLI
[group('build')]
readme: build
    scripts/readme.sh

# Fail when README.md's oclif sections differ from what `just readme` would write
[group('lint')]
readme-check: build
    scripts/readme.sh --check

# `vp run --filter @outlinedb/cli prepack`
[group('build')]
manifest: install
    vp run --filter @outlinedb/cli prepack

# Run structural eval tests against .claude/ markdown files
[group('test')]
eval-structural: build manifest
    CHAI_TRUNCATE_THRESHOLD=0 vp run eval:structural

# Run deterministic behavioral evals (no LLM calls needed)
[group('test')]
eval-deterministic: build
    CHAI_TRUNCATE_THRESHOLD=0 vp run eval:deterministic

# Run Tier 1 leaf agent evals (requires ANTHROPIC_API_KEY)
[group('test')]
eval-leaf: build
    CHAI_TRUNCATE_THRESHOLD=0 vp run eval:leaf

# Run Tier 2 orchestrator evals with recursive subagents (requires ANTHROPIC_API_KEY)
[group('test')]
eval-orchestrator: build
    CHAI_TRUNCATE_THRESHOLD=0 vp run eval:orchestrator

# Run Tier 3 end-to-end evals (requires ANTHROPIC_API_KEY, expensive)
[group('test')]
eval-e2e: build
    CHAI_TRUNCATE_THRESHOLD=0 vp run eval:e2e

# Run all behavioral eval tests (expensive, not in precommit)
[group('test')]
eval-behavioral: build
    CHAI_TRUNCATE_THRESHOLD=0 vp run eval:behavioral

# Run pre-commit hooks on all files (same as CI's pre-commit job)
[group('lint')]
pre-commit: build-shared
    pre-commit run --all-files

# Run pre-commit hooks except Fallow and vp fmt, which verify's fixer branch already ran
_pre-commit-unformatted: build-shared
    SKIP=fallow,oxfmt pre-commit run --all-files

# Run all pre-commit checks
[arg("quick", long, value="true", help="Skip tests")]
[group('workflow')]
verify quick="": build-shared
    #!/usr/bin/env bash
    set -uo pipefail
    # Branches run in parallel with --no-deps: just's [parallel] can start a shared dependency twice, and a second build-shared rewrites shared dist under the running tests.
    # Fixers rewrite files in place, so they share one serial branch. Fallow goes first because its fix rewrites package.json with 2-space indentation, which check's formatter re-tabs.
    branches=(
        "fallow check _pre-commit-unformatted"
        "typecheck build manifest readme-check eval-structural"
        "test-plugins"
        {{ if quick == "true" { "" } else { '"test"' } }}
    )
    pids=()
    for branch in "${branches[@]}"; do
        (for recipe in $branch; do just --no-deps "$recipe" || exit; done) &
        pids+=("$!")
    done
    failed=0
    for index in "${!pids[@]}"; do
        if ! wait "${pids[$index]}"; then
            echo "verify branch failed: ${branches[$index]}" >&2
            failed=1
        fi
    done
    if [ "$failed" -ne 0 ]; then
        exit 1
    fi
    echo "All pre-commit checks passed!"

# Deprecated alias for `verify`
[arg("quick", long, value="true", help="Skip tests")]
[group('workflow')]
precommit quick="": (verify quick)

# Backup database before operations that modify it
[group('database')]
backup-db:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -f outlinedb.sqlite ]; then
        cp outlinedb.sqlite outlinedb.sqlite.bak
        echo "Database backed up to outlinedb.sqlite.bak"
    else
        echo "No database to backup (outlinedb.sqlite not found)"
    fi

# Run daily workflow: build the CLI, import backup files, then update from API, generate embeddings, then reclaim dead pages
[group('workflow')]
daily: build backup-db
    ./bin/run.js cache import-backups --no-embeddings
    ./bin/run.js cache import-api
    ./bin/run.js ai embed
    # Reclaim dead pages so the db file does not regrow unbounded (full VACUUM; logs before/after sizes)
    ./bin/run.js cache vacuum

# Rebuild the database from scratch into a new file (download + replay every backup, API catch-up, account state, local state, embeddings, vacuum), then swap it in and keep a backup; run as `op run -- just build-fresh-database`; refuses while `just web` runs; `just build-fresh-database --swap-only` swaps in a finished rebuild whose swap was refused
[group('workflow')]
build-fresh-database *args: build manifest
    ./scripts/build-fresh-database.sh {{ args }}

# Demo CLI commands - comprehensive exploration of all CLI functionality
[group('demo')]
demo:
    @./scripts/demo.sh

# `open -a "DB Browser for SQLite" outlinedb.sqlite`
[group('database')]
db-browser:
    open -a "DB Browser for SQLite" outlinedb.sqlite

# `sqlite3 outlinedb.sqlite`
[group('database')]
db-cli:
    sqlite3 outlinedb.sqlite

# `datasette outlinedb.sqlite`
[group('database')]
db-web:
    datasette outlinedb.sqlite

# The API server's `tsx watch` runs with `--conditions=source`, so @outlinedb/shared resolves to packages/shared/src (its exports' `source` condition), not dist: shared edits restart the server live and it never runs stale built code.
# Start web app with API server and Vite dev server (shared code live from source)
[group('web')]
web: build-shared
    OUTLINEDB_DB_PATH={{ justfile_directory() }}/outlinedb.sqlite vp run --filter @outlinedb/web dev

# Download all available Dropbox backups that aren't already downloaded
[group('backup')]
download-backups:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "Syncing Workflowy backups from Dropbox (Dropbox keeps last 3 days)"
    echo ""

    mkdir -p backups/Data
    mkdir -p backups/History

    AVAILABLE=$(./bin/run.js dropbox list-backups 2>/dev/null | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}' || true)

    if [ -z "$AVAILABLE" ]; then
        echo "No backups found in Dropbox or authentication failed"
        echo "Run: ./bin/run.js dropbox:auth"
        exit 1
    fi

    TOTAL=0
    SKIPPED=0
    DOWNLOADED=0

    while IFS= read -r line; do
        DATE=$(echo "$line" | awk '{print $1}')
        SOURCE=$(echo "$line" | awk '{print $2}')

        if [ -z "$DATE" ] || [ "$DATE" = "unknown" ]; then
            continue
        fi

        TOTAL=$((TOTAL + 1))

        if find backups -type f -name "*${DATE}*" 2>/dev/null | grep -q .; then
            echo "Already have: $DATE ($SOURCE)"
            SKIPPED=$((SKIPPED + 1))
        else
            echo "Downloading: $DATE ($SOURCE)"
            ./bin/run.js dropbox download-backup --date "$DATE" --quiet > /dev/null
            DOWNLOADED=$((DOWNLOADED + 1))
        fi
    done <<< "$AVAILABLE"

    echo ""
    echo "Dropbox sync (keeps last 3 per folder):"
    echo "   In Dropbox:    $TOTAL"
    echo "   Already local: $SKIPPED"
    echo "   Downloaded:    $DOWNLOADED"
