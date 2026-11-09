# Datasette Agent for the Workflowy cache

[Datasette Agent](https://datasette.io/blog/2026/datasette-agent/) (Simon Willison, May 2026) is an LLM assistant that answers plain-English questions about a SQLite database by writing and running SQL. This wires it up against this project's `outlinedb.sqlite` cache.

## Run

```bash
./scripts/datasette-agent.sh
```

Then open <http://localhost:8001> and use the agent panel. Stop with Ctrl-C.

## Requirements

- [`uv`](https://docs.astral.sh/uv/) (provides `uvx`). Datasette, the `datasette-agent` plugin, and the model plugin are fetched on demand into an ephemeral environment — nothing is installed globally, and the system `datasette` is untouched.
- A logged-in `codex` CLI (`codex login`). By default the agent runs through your **ChatGPT/Codex subscription** via the `llm-openai-via-codex` plugin, which reuses `~/.codex/auth.json` — **no API token spend, no key in this repo.**

## What it does

- Reads the **live** `outlinedb.sqlite` from the **main working tree** (the file is gitignored, so it isn't present inside a worktree). Datasette never writes to the data database — its own state goes to `.llm/datasette-internal.db` (gitignored).
- Default model is `openai-codex/gpt-5.5` (routed through the Codex subscription).

## Env overrides

| Variable                | Default                        | Purpose                            |
| ----------------------- | ------------------------------ | ---------------------------------- |
| `DATASETTE_AGENT_MODEL` | `openai-codex/gpt-5.5`         | Any `llm` model id.                |
| `DATASETTE_LLM_PLUGIN`  | `llm-openai-via-codex`         | The `llm` model plugin to install. |
| `WORKFLOWY_DB_PATH`     | `<main-tree>/outlinedb.sqlite` | Point at a different SQLite file.  |
| `DATASETTE_PORT`        | `8001`                         | Port to serve on.                  |

> To use another backend, set **both** the model and its plugin, e.g. Anthropic API key: `DATASETTE_AGENT_MODEL=anthropic/claude-sonnet-4-6 DATASETTE_LLM_PLUGIN=llm-anthropic`, or a local LM Studio model: `DATASETTE_AGENT_MODEL=lmstudio/<model> DATASETTE_LLM_PLUGIN=llm-lmstudio`.

## Schema notes for querying

The cache is **bitemporal**. A row is _current_ when `system_to = '9999-12-31 23:59:59'` — filter on that to see the live tree. `datasette/metadata.yml` documents each table for the agent, and `datasette/datasette.yml` ships canned queries (`current_nodes`, `search`, `recently_modified`, `node_children`) as starting points. Full-text search goes through the FTS5 table: `SELECT node_id, content FROM node_fts WHERE node_fts MATCH '…'`.
