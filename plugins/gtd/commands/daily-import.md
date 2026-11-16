---
name: daily-import
description: Refresh the Workflowy cache and review subtree for the daily review's mandatory import barrier.
---

# Daily Import

## Preflight: check credentials before anything else

Prep tasks fan out into subagents that cannot recover a broken credential themselves, and a failure only surfaces once that task has burned its full runtime. The checks below are instant, so run them first and halt on the first failure.

```bash
timeout 90 op run -- true   # 1Password: this is the call the review actually makes
```

Use **`op run`**, not `op vault list` and not `op whoami`.

- `op whoami` reports `account is not signed in` and exits 1 under desktop-app (system auth) integration — how this machine is set up — even while secret resolution works perfectly. It reads a session-token field system auth never populates.
- `op vault list` is not sufficient either, and this is the trap: it can exit 0 while `op run` still fails. `op run` initializes a **separate** client that raises its own desktop authorization prompt, and if nobody approves that prompt it dies with `error initializing client: authorization timeout`.

Only `op run` proves `op run` works. Warming it here means the authorization prompt is approved **once, in the foreground, while the user is present** — instead of firing inside a background subagent that cannot surface it.

**Always bound `op run` with `timeout`.** Unbounded, it waits on a prompt nobody sees: the Otter scanner subagent hung 22 minutes on it, reported nothing, and had to be killed. A `timeout` turns an invisible hang into a reportable failure.

- `timeout 90 op run -- true` fails or times out → halt. Tell the user to approve the 1Password prompt (or unlock the desktop app), then re-run. Retry once after they confirm — the second call succeeds immediately once the first authorization lands.

Then confirm **subagents** can reach iMCP and every Gmail IMAP server listed under `mailServers` in `.llm/gtd/config.json` (array of MCP server names, such as `gmail-alice-imap`; when missing, discover the `mcp__gmail-*-imap__` tools, ask once, and save). Prep tasks run in subagents, so the main thread seeing the tools proves nothing. Spawn one throwaway probe subagent that calls `mcp__imcp__calendars_list` plus `mcp__<server>__check_connection` for each configured server, and reports per tool whether it was available and succeeded. `iMCP.app` appearing in `ps` proves nothing — only a successful call from the probe counts. `email-calendar-prep` reads unread inbox mail through the Gmail servers, so a missing tool or failed connection on any account means that prep task stages nothing — one healthy account does not vouch for the other.

- `op run` fails → halt. Tell the user to unlock the 1Password desktop app (Settings → Developer → "Integrate with 1Password CLI" must be on) and approve the authorization prompt. Do not suggest `eval $(op signin)`: it exports `OP_SESSION_*` into one shell, and every Bash tool call gets a fresh shell, so that token never reaches the barrier.
- Probe shows iMCP tools absent or failing → halt. Tell the user to run `/mcp`, wait, then re-run; the probe re-checks on the next run.
- Probe shows Gmail IMAP tools absent, or `check_connection` failing on either account → halt with the same message, naming the account that failed.
- Probe still fails after the user ran `/mcp` and re-ran → only then tell the user to restart the Claude Code session.

Every halt message must be a plain-text response that ends the turn. Do **not** use `AskUserQuestion`: an open prompt prevents the user from typing `/mcp` and gets in the way of unlocking 1Password until they press Esc. State the recovery action in plain text and return control immediately.

A server connected mid-session via `/mcp` has been observed to reach subagents (a post-`/mcp` subagent listed 9 calendars), so a restart is not assumed. The probe decides: subagents that can call the tools mean the barrier proceeds; subagents that cannot mean a restart is required, because the session's startup configuration is what those subagents inherit.

Do not fan out on a partial credential set. A halted barrier costs one re-run; a fan-out on missing credentials costs the whole review and silently degrades Apple-calendar deduplication and the email-calendar scan.

## Preflight: refresh a stale plugin cache

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/plugin-cache-fresh.mts" gtd@workflowy-gtd workflowy@workflowy-gtd
```

The review runs this plugin from Claude Code's cache, and `claude plugin update` compares only the version, which this repo never bumps. A pushed fix is therefore reported "already at latest" and never reaches the cache: on 2026-11-13 a stale `compute-llm-dag.mts` printed nothing, exited 0, and the review planned no tasks. The script refreshes the marketplace clone, diffs each plugin's cache file by file against its source there, and uninstalls and reinstalls (keeping plugin data) whichever differs.

- Exit 0 → every cache is fresh; continue.
- Exit 2 → a cache was reinstalled. This session still holds the old commands and skills, so halt and tell the user, in a plain-text response that ends the turn, to run `/reload-plugins` (or restart the session) and re-run the review.
- Exit 1 → the check or reinstall failed; halt with its error.

## Import

Run the barrier without piping or masking either exit status:

```bash
direnv exec . op run -- just daily
direnv exec . ./bin/run.js cache sync-node --path "Personal,🔄 Review" --recursive
direnv exec . "${CLAUDE_PLUGIN_ROOT}/scripts/otter-api.sh" warm-credentials
```

The third line is what keeps prep subagents away from `op` entirely. `otter-api.sh` resolves its `op://` refs lazily on first login; without this, the first process to need them is a background Otter scanner, which then raises both a Claude Code permission prompt and a 1Password authorization prompt that nobody can see. Warming here resolves them once, in the foreground, into a cache the subagent just reads. It is idempotent — a warm cache makes it a no-op that never invokes `op`.

Then pre-score the Clef people hints `refine-journal-prep` reads, so prep never needs `CLOUDFLARE_AI_TOKEN`:

```bash
direnv exec . op run -- ./bin/run.js ai suggest-labels --parent-id 6bf42551caa3 --since "$(date -v1d -v-1m +%Y-%m)" --kind person --verifier clef --threshold 0.84 >/dev/null
```

The token is an `op://` ref in `.envrc`, so it only resolves under `op run`. `ai suggest-labels` stores every score in the local `node_label_suggestions` table and asks for the token only when an entry is new or edited since it was last scored. Scoring the live window here leaves nothing stale, so prep's own call (same scope, no `op`) just reads the stored hints. `-v1d` before `-v-1m` keeps the prior month right on the 29th-31st. This step is not a halt condition: hints are advisory, and if it fails, say so and continue — prep's call then exits non-zero and prep tags without hints.

`direnv exec .` is required, not optional. The `op://` references and the literal `WORKFLOWY_API_KEY` live in the gitignored `.envrc`, and direnv loads it through a **prompt hook** that only fires in interactive shells. Every Bash tool call is a fresh non-interactive shell, so the hook never runs and the whole `.envrc` is silently absent — `op run` then has no `op://` refs to resolve and the barrier dies on `Dropbox credentials not set` at `cache import-backups`. Running it bare works from the user's own terminal and fails only under automation, which is exactly the asymmetry that makes it easy to reintroduce.

`direnv exec .` is idempotent — harmless when direnv already loaded the environment — so always prefix the barrier with it rather than testing whether the variables happen to be set.

Verify that `cache import-api` reported fetched and changed node counts and that the subtree sync succeeded.

Then run the cache sanity check, and halt the daily review if it exits non-zero:

```bash
set -o pipefail
total=$(direnv exec . ./bin/run.js cache status --json | jq -er '.nodes.total') \
  || { echo "cache status failed"; exit 1; }
[ "$total" -ge 1000 ] \
  || { echo "Cache holds only $total nodes (expected at least 1000)"; exit 1; }
direnv exec . ./bin/run.js calendar day --level year --json >/dev/null \
  || { echo "No 📆 Calendar year node for $(date +%Y) in the cache"; exit 1; }
echo "Cache sane: $total nodes"
```

A healthy cache holds well over 100,000 nodes. A count under 1000 means the import wrote to an empty or wrong database (a DB rename once silently produced an empty cache, and the import still reported success). The calendar check is a strict `metadata.calendar` walk, so it fails when the 📆 Calendar tree did not land. It checks the year, not today's day: workflowy.com creates day nodes only when a day is opened or written to, so most days have none and a day-level check would fail healthy runs. Never add `--ensure` here; on a broken cache it would create duplicate calendar nodes on workflowy.com.

Return success only after positive verification. On error, timeout, missing summary, stale data, or a failed sanity check, return failure and halt the daily review before prep fan-out.
