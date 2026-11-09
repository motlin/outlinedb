#!/usr/bin/env bash
#
# Launch Datasette Agent against the Workflowy SQLite cache.
#
# Datasette Agent (Simon Willison, May 2026) is an LLM assistant that answers
# plain-English questions about a SQLite database by writing and running SQL.
# See: https://datasette.io/blog/2026/datasette-agent/
#
# This reads the LIVE outlinedb.sqlite from the main working tree, opened
# read-only (datasette never writes to the data database; its own state goes to
# the --internal db).
#
# By default it runs through your ChatGPT/Codex SUBSCRIPTION (no API token
# spend) via the llm-openai-via-codex plugin, which reuses the `codex` CLI login
# (~/.codex/auth.json). Run `codex login` first if not already authenticated.
#
# Requirements: uv (provides uvx). Everything else is fetched on demand.
#
# Env overrides:
#   DATASETTE_AGENT_MODEL  model id         (default: openai-codex/gpt-5.5)
#   DATASETTE_LLM_PLUGIN   llm model plugin (default: llm-openai-via-codex)
#   OUTLINEDB_DB_PATH      path to the SQLite db (default: <main-tree>/outlinedb.sqlite)
#   DATASETTE_PORT         port to serve on (default: 8001)
#
# Other backends (swap both vars together):
#   Anthropic API key: DATASETTE_AGENT_MODEL=anthropic/claude-sonnet-4-6 DATASETTE_LLM_PLUGIN=llm-anthropic
#   Local (LM Studio): DATASETTE_AGENT_MODEL=lmstudio/<model>            DATASETTE_LLM_PLUGIN=llm-lmstudio
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The db is gitignored, so a worktree won't contain it. Resolve it from the
# main working tree (the parent of the shared .git common dir).
MAIN_TREE="$(dirname "$(git -C "$REPO_ROOT" rev-parse --git-common-dir)")"

DB_PATH="${OUTLINEDB_DB_PATH:-$MAIN_TREE/outlinedb.sqlite}"
MODEL="${DATASETTE_AGENT_MODEL:-openai-codex/gpt-5.5}"
LLM_PLUGIN="${DATASETTE_LLM_PLUGIN:-llm-openai-via-codex}"
PORT="${DATASETTE_PORT:-8001}"
CONFIG_DIR="$REPO_ROOT/datasette"
INTERNAL_DB="$REPO_ROOT/.llm/datasette-internal.db"  # .llm/ is gitignored

if [[ ! -f "$DB_PATH" ]]; then
  echo "error: SQLite db not found at: $DB_PATH" >&2
  echo "       set OUTLINEDB_DB_PATH to override." >&2
  exit 1
fi

mkdir -p "$(dirname "$INTERNAL_DB")"

echo "datasette-agent: db=$DB_PATH model=$MODEL plugin=$LLM_PLUGIN port=$PORT" >&2

exec uvx --prerelease=allow \
  --with datasette-agent \
  --with "$LLM_PLUGIN" \
  datasette \
  -s plugins.datasette-llm.default_model "$MODEL" \
  -m "$CONFIG_DIR/metadata.yml" \
  -c "$CONFIG_DIR/datasette.yml" \
  --internal "$INTERNAL_DB" \
  --root \
  --port "$PORT" \
  "$DB_PATH"
