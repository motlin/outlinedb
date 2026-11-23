---
name: otter-journal-scanner
description: Sync Otter.ai meeting transcripts directly into the Workflowy calendar, skipping meetings already logged. Invoked by /gtd:journal and the daily-review /gtd:otter-journal-auto task.
---

This journal agent ingests Otter.ai meetings into the Workflowy journal at the root Calendar node.

Follow the workflowy plugin's `calendar-dates` and `workflowy-html` skill docs for date and HTML formats.

**Important:** Entries are intentionally created as direct children of `📆 Calendar`, not under date sub-nodes. Workflowy has built-in functionality to auto-sort calendar entries into the correct date positions — the user runs this manually. So don't find or create date nodes; just create entries at the Calendar root.

Uses the Otter API directly via `${CLAUDE_PLUGIN_ROOT}/scripts/otter-api.sh`. Incremental runs fetch only meetings newer than `last_synced_otid`, so cost scales with new meetings, not history.

## Invocation

This agent creates entries directly under `📆 Calendar`. Manual `/gtd:journal` runs and the daily-review `/gtd:otter-journal-auto` (`🤖 Auto`) task both scan, create entries inline, and advance the live scanner state after each page (see **Save State**).

## API Script

The script `${CLAUDE_PLUGIN_ROOT}/scripts/otter-api.sh` handles authentication and provides:

```bash
# Incremental sync (use this): every meeting newer than the boundary, newest first
${CLAUDE_PLUGIN_ROOT}/scripts/otter-api.sh sync-since "$LAST_SYNCED_OTID"

# First run only (no state), or raw endpoints if needed:
${CLAUDE_PLUGIN_ROOT}/scripts/otter-api.sh sync [page_size] [cursor] [modified_after]
${CLAUDE_PLUGIN_ROOT}/scripts/otter-api.sh available_speeches [page_size] [cursor] [modified_after]
${CLAUDE_PLUGIN_ROOT}/scripts/otter-api.sh action_items <otid>
```

`sync-since` pages through small pages (10 by default) until it reaches `last_synced_otid`, drops the boundary and anything older, and fetches action items only for the new meetings. It returns `{"boundary_found": bool, "end_of_list": bool, "speeches": [...]}`, where each speech has:

- `otid`, `title`, `start_time`, `summary`, `outline`
- `action_items` array inlined (fetched only for processed meetings, those with a `summary` or a non-empty `outline`)

It exits non-zero rather than scanning unbounded when the boundary is not found within `OTTER_MAX_PAGES` pages (default 20). Treat that as a scan failure: create nothing and do not move state.

**Keep `page_size` small:** large pages (1000) take over a minute and return 504s.

**Required environment variables:** `OTTER_USERNAME`, `OTTER_PASSWORD`

## State Storage

Sync state is stored under `Metadata > ⚙️ Scanner State > otter-journal-scanner` as a JSON child node:

```json
{
	"cursor": "1762808594",
	"session_start": 1736283600,
	"last_synced_otid": "abc123",
	"reached_beginning": false
}
```

## Process Overview

- Load state from Workflowy
- Determine scope (first run: ask user how far back; subsequent: incremental from cursor)
- Fetch new meetings via `sync-since "$LAST_SYNCED_OTID"` (first run: `sync` pages within the chosen scope)
- Process meetings oldest first
- Save state after each page (an incremental run is one page)
- First run only: continue until `end_of_list: true`

## Load State

> Run `./bin/run.js node get --help` to verify available flags before constructing commands.

```bash
./bin/run.js node get --path "Metadata,⚙️ Scanner State,otter-journal-scanner" --depth 1 --json --fields id,name,children 2>/dev/null
```

If path doesn't exist (first run), state is empty. Parse JSON from first child's name if it exists.

## Determine Scope

**If state exists with `last_synced_otid`:** This is an incremental sync. Sync only meetings newer than the cursor. Skip to Initialize Session.

**If first run (no state):** Don't fetch all meetings — that risks an unbounded scan of hundreds of meetings. Instead:

- Use `AskUserQuestion` to ask the user how far back to sync (e.g., "Last 2 weeks", "Last month", "Since January 2026", "All meetings")
- Convert their answer to a Unix timestamp for the `modified_after` parameter
- This prevents unbounded scans of potentially hundreds of meetings

## Initialize Session

Set `session_start` to current Unix timestamp: `$(date +%s)` This becomes the constant `modified_after` value for all pages in this sync session.

## Refresh Destination Cache

The URL-dedup check in **Process Meetings** reads the local SQLite cache. By the time this scanner runs, that cache is stale for the Calendar subtree (the daily import runs earlier, and other tasks modify the calendar after it), so existing meetings look new and get re-created. This is the historical cause of duplicate meetings.

Before processing any meetings, sync the Calendar's direct children so the dedup search reflects what is already in Workflowy. Use a **non-recursive** sync — new meetings are created as flat direct children of `📆 Calendar` (see above), so the direct-children level is the only scope the dedup needs. It refreshes all direct children in well under a second; a `--recursive` sync of the full year/month archive takes minutes and locks the cache against the scanner's own reads.

```bash
./bin/run.js cache sync-node --path "📆 Calendar"
```

Then reset the in-session guard, which catches the case the cache cannot — a meeting this same run already created on an earlier page (same-session creates are not visible to the search until the next sync):

```bash
mkdir -p .llm/gtd/journal/logs
: > .llm/gtd/journal/logs/otter-created-this-session.txt
```

## Fetch Meetings

**Incremental run (state has `last_synced_otid`):** one call returns every new meeting, already cut at the boundary, with action items inlined. Treat the whole result as a single page for preflight and **Save State**.

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/otter-api.sh sync-since "$LAST_SYNCED_OTID"
```

- `boundary_found: true` → every returned meeting is new. An empty `speeches` array means all caught up.
- `boundary_found: false` with `end_of_list: true` → the boundary meeting no longer exists in Otter (deleted). Every returned meeting still goes through the URL dedup below, which skips anything already logged.

**First run (no state):** page by the user's chosen scope with a modest page size, never 1000:

```bash
# Page 1 (no cursor)
${CLAUDE_PLUGIN_ROOT}/scripts/otter-api.sh sync 50 "" "$MODIFIED_AFTER"

# Page 2+ (with cursor and modified_after)
${CLAUDE_PLUGIN_ROOT}/scripts/otter-api.sh sync 50 "$CURSOR" "$MODIFIED_AFTER"
```

Parse `speeches[]`, `last_load_ts` (cursor for the next page), and `end_of_list` (true when no more pages). A cursor page can repeat meetings from the previous page; the in-session guard and URL dedup skip them.

## Preflight calendar-derived titles

Before any create or state write for a page, deduplicate its candidates using the cursor, in-session guard, and URL checks below, then compare every ready candidate's calendar-derived title with its Overview (`summary`) and available transcript-derived outline. Calendar overlap is not attendance evidence: a skipped event can lend its title to a different recording.

**Apply user decisions first.** Read `.llm/gtd/review/otter-confirmed-titles.json` if it exists. It maps otid to a decision the user made about an earlier flag, per the auto command's **Resolve a title flag**. A missing file means no decisions. For each ready candidate whose otid is a key:

- `title` set: the user approved this title, so skip the evidence check. Build the entry with this title in place of the calendar-derived one, and create it like any verified candidate.
- `skip: true`: create nothing for this recording, and do not add it to the session guard. It no longer holds the page, so the page can still save state.

Only candidates without a decision go through the evidence check below. Never write to this file. The main thread owns it.

Check both the subject and named attendees against the recording. Names mentioned in passing do not establish attendance, and missing names in a short summary do not establish absence. Use transcript/speaker evidence when available; flag missing or ambiguous evidence as uncertain. Do not accept a title solely because it matches the calendar.

Otter's speaker names are guesses from its voice model. When the only conflict is that Otter labels a speaker as someone other than the titled attendee, and the subject fits, use the reason `probable speaker mislabel: title says @<attendee>, Otter labels the speaker <name>` instead of a mismatch reason. It is still a review flag.

If any candidate mismatches or remains uncertain, stop before creating any entries on that page. Return review flags containing the original title, date and local start time, Otter URL/otid, and a concise evidence-based reason. The start time lets the daily review match the recording to its recurring slot. **Never create the flagged entry untitled or automatically retitle it.** Keep full transcript content out of logs and the review summary. Preserve any verified creates and saved state from earlier pages, but make no state update for this held page: do not move its cursor, session start, or last-synced boundary past unresolved recordings. On a rerun, the held page must be reconsidered rather than silently treated as synced.

In Auto, return the flags to `otter-journal-auto` for an error briefing; do not prompt. In manual mode, report that review is required before proceeding. Do not log a flagged candidate as created or add it to the created-this-session guard. Existing entries remain untouched.

## Process Meetings

For each meeting in page (process oldest first to maintain calendar order):

**Check if already synced (cursor):** If `otid == last_synced_otid`, stop - we've caught up to previous sync.

**Check if created earlier this session (in-run guard):** If `<otid>` is already in the session guard file, skip — this run created it on an earlier page, and the cache cannot reflect same-session creates:

```bash
grep -qF "<otid>" .llm/gtd/journal/logs/otter-created-this-session.txt && echo "skip: created this session"
```

**Check if already exists (URL dedup):** Even if the cursor check passes, verify the meeting doesn't already exist in the calendar. This search reads the local cache, which was refreshed in **Refresh Destination Cache** above so it reflects meetings already in Workflowy:

```bash
./bin/run.js node search --query "otter.ai/u/<otid>" --limit 1 --json
```

If any result is returned, skip this meeting — it was already created (e.g., from a previous sync or manual entry).

**Log the dedup decision:**

```bash
mkdir -p .llm/gtd/journal/logs
echo "[$(date -Iseconds)] otid=<otid> search_result=<found|not_found> action=<created|skipped>" >> .llm/gtd/journal/logs/otter-sync.log
```

**Check if ready:** A meeting is processed when it has a `summary` or a non-empty `outline`. Otter sometimes outlines a meeting without writing the abstract, and the web app then shows the outline as its summary. Skip a meeting only when both are missing (still processing). For an outlined meeting with no `summary`, build the entry from the outline and leave the overview child out.

**Stale silent recordings:** A recording with `duration` under 120 seconds, no `summary` or `outline`, and `start_time` more than 24 hours ago probably never happened (a cancelled meeting, or the other person was out). Do not skip it silently, and do not let it hold the cursor as "still processing". Flag it like a title flag: original title, date, Otter URL/otid, duration, and the reason `short silent recording with no summary after 24 hours`. Create no node for it. Hold the page and its scanner state the same way a title flag does, with `status: "error"`. The daily review offers to delete it from Otter (see `Resolve a stale recording flag` in `commands/otter-journal-auto.md`). Recordings younger than 24 hours with neither are still processing and are skipped as before.

**Unsummarized recordings:** A recording of 120 seconds or longer with no `summary` and no `outline` more than 24 hours after `start_time` is not still processing: Otter finishes a summary within hours, so it will likely never get one. Flag it the same way with the reason `no summary after 24 hours`, its title, date, Otter URL/otid, and duration. Create no node for it and hold the page. Treating it as still processing would hold the page, and every meeting after it, forever.

**Use the fetched output directly:** `sync-since` and `sync` return all needed data in minimal JSON, so never call `action_items` per meeting yourself:

- `summary` - the narrative overview
- `outline[]` - sections with titles and segments
- `action_items[]` - with `text`, `assignee`, `completed` (auto-fetched)

**Build entry:**

Convert Unix timestamp to Workflowy date (see **calendar-dates** skill).

The entry name has three parts: `<time>` tag, then title wrapped in `<a href>` linking to the Otter URL, then `#meeting`. Encode quotes in titles as `&quot;`.

```json
{
  "name": "<time startYear=\"2026\" startMonth=\"1\" startDay=\"6\" startHour=\"15\" startMinute=\"31\">Tue, Jan 6, 2026 at 3:31pm</time> <a href=\"https://otter.ai/u/<otid>\">Title</a> #meeting",
  "children": [
    {"name": "otter.ai/u/<otid>"},
    {"name": "<b>Overview</b>", "children": [{"name": "<overview text>"}]},
    {"name": "<b>Action Items</b>", "children": [{"name": "Action item text (@Assignee)", "layoutMode": "todo"}]},
    {"name": "<b>Outline</b>", "children": [<from speech_outline>]}
  ]
}
```

Build outline children from `speech_outline`:

- Each top-level item → `<b>Section Title</b>` with children
- Each segment → child node with text

Build action items children from `speech_action_items`:

- Each item → `{"name": "<text>", "layoutMode": "todo"}` for native checkbox
- If assignee exists, append `(@<assignee.name>)` to the name
- If completed in Otter, also add `"completed": true`

**Create node:**

Write the entry JSON to `.llm/gtd/journal/entries/<otid>.json` with the Write tool, then create it with one standalone Bash call:

```bash
./bin/run.js node create --parent-path "📆 Calendar" --json-file .llm/gtd/journal/entries/<otid>.json --position bottom
```

**Keep every Workflowy write a bare command.** The permission allowlist matches the `node create` and `node update` CLI commands by prefix. Without a match, the auto-mode classifier judges the write and denies it as an external system write, which strands the run. So each create or update must be its own Bash call that starts with the literal CLI path and takes literal arguments:

- No `cd`, variable assignments (`S=...;`), or env prefixes in front of it
- No `$(...)` command substitution (use `--json-file`, never `--json "$(cat file)"`)
- No loops, `&&`/`;` chains, pipes, or output redirects around it
- Read the command's stdout directly; don't capture it into a file

**Handle create errors — never blindly retry.** Workflowy can rate-limit (HTTP 429) and return an error _after the node was already created server-side_. A naive retry then produces a duplicate (exactly the failure mode this scanner exists to prevent). So on any create error: refresh the cache, re-check whether the meeting now exists, and only retry if it genuinely does not.

```bash
# On create error: refresh, then re-check existence
./bin/run.js cache sync-node --path "📆 Calendar"
./bin/run.js node search --query "otter.ai/u/<otid>" --limit 1 --json
```

- If the search now finds it → the create **started**, but do not treat existence as success. See the structural audit below.
- If still not found → wait a few seconds for the rate limit to clear, then retry the create once. Re-check again before any further retry.

**Existence is not completeness — audit the structure.** A 429 can land the entry and then truncate the rest of the tree mid-write. The `otter.ai/u/<otid>` child is created _before_ the `Outline` subtree, so the URL search matches a half-written entry just as readily as a complete one. Treating that match as success leaves a meeting in the calendar with an empty `Outline`, and because its otid is recorded and the cursor advances past it, nothing ever revisits it.

So after any create that errored, compare the entry against the Otter source and repair rather than re-create:

```bash
./bin/run.js node get --id <new-entry-id> --depth 3 --json --fields name,children
```

Check the action-item count, the number of `Outline` sections, and the segment count under each section against the source. If any are short, create only the missing children — never delete and re-create the entry, which would lose the otid link and risk a duplicate. Re-audit after repairing.

When a run hits any 429, audit every entry it created, not just the one that reported the error. An entry that reported a 429 as "already landed" can still be missing outline sections.

After the node exists (created cleanly, or confirmed created after an error), record the otid in the session guard file so later pages in this same run do not re-create it:

```bash
echo "<otid>" >> .llm/gtd/journal/logs/otter-created-this-session.txt
```

## Save State

After processing each page that passed title preflight, update state. A page held for title review must not reach this step, even when it is the final page.

After an incremental `sync-since` run, set `last_synced_otid` to the newest returned otid (`speeches[0].otid`) and keep the existing `cursor` and `session_start`. When it returned no meetings, leave state untouched.

**Important: the state JSON must be single-line**, because Workflowy interprets newlines as separate child nodes.

Take the state node id from the first child returned by **Load State**, then write the single-line state JSON as a literal argument in one standalone Bash call (same bare-command rule as the create step: no variables, `$(...)`, or `if` block around it):

```bash
./bin/run.js node update --id <state-node-id> --name '{"cursor":"123","session_start":1768518232,"last_synced_otid":"abc","reached_beginning":false}'
```

First run only (no state child yet), create it instead (`--create-path` creates the parent structure):

```bash
./bin/run.js node create --parent-path "Metadata,⚙️ Scanner State,otter-journal-scanner" --name '{"cursor":"123","session_start":1768518232,"last_synced_otid":"abc","reached_beginning":false}' --create-path
```

## Check End Conditions

- Incremental run → done after the single `sync-since` result
- First run: if `end_of_list: true` → set `reached_beginning: true`, done; otherwise continue to the next page with the new cursor

## Return Format

```text
Otter Sync Complete:
- Created: 4 entries (Jan 5 to Jan 6, 2026)
- Cursor saved at: 1762808594
```

If all caught up:

```text
Otter Sync: All meetings already synced (newest: Jan 6, 2026)
```

## Quick Reference

**First run:**

- No state exists
- Asks user how far back to sync (do NOT scan everything unbounded)
- Creates `Metadata > ⚙️ Scanner State > otter-journal-scanner` structure
- Syncs meetings within the chosen window

**Subsequent runs:**

- Loads state, passes `last_synced_otid` to `sync-since` as the stop boundary
- Syncs only the new meetings it returns
- If already caught up (newest meeting matches cursor), reports "all synced"

**Interrupted sync:**

- Cursor persists in state
- Resume with same `session_start` and cursor
- Continues where it left off
