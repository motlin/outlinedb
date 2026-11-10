---
name: otter-journal-auto
description: Auto half of daily-review Otter ingestion — scan Otter.ai for meetings newer than the cursor, calendar-dedup against 📆 Calendar, validate titles against transcript evidence, create the verified survivors under 📆 Calendar, advance the live scanner cursor, then stage a briefing fragment. Fully autonomous; no confirmation gate.
---

# Otter → Journal — Auto

Ingest new Otter.ai meetings into the Workflowy `📆 Calendar` without prompting. Cursor-based dedup plus a calendar-match backstop ensure only new meetings are created. The live prep task carries `Auto`, so it stages a briefing fragment instead of a confirmable proposal.

It is the head of `Serial: Calendar journal`: it creates the entries that `refine-journal-prep` and the inline Refine exercise task then refine.

## Auto contract (read this first)

- **Fully autonomous.** Never call `AskUserQuestion` / `TaskCreate` / `TaskUpdate` / `TodoWrite`. There is no confirmation gate; deduplicated new meetings with supported titles are created automatically. Flag mismatched or uncertain titles in the briefing for review; do not prompt during Auto.
- **Read, don't rebuild, metadata.** The DAG runs the import barrier and `metadata-sync` once before fan-out. Read the cache as-is.
- **Idempotent via the cursor.** Dedup is cursor-based (`last_synced_otid`) with a calendar-match backstop, so a re-run creates nothing new.

## Load scanner state

State lives under `Metadata > ⚙️ Scanner State > otter-journal-scanner` as a JSON child node:

```json
{
	"cursor": "1762808594",
	"session_start": 1736283600,
	"last_synced_otid": "abc123",
	"reached_beginning": false
}
```

- **State exists with `last_synced_otid`** → incremental scan: create only meetings newer than that otid.
- **First run (no state)** → choosing how far back to sync needs the user (an unbounded scan of hundreds of meetings is not safe to auto-run). Auto cannot prompt, so create nothing, stage a briefing with `status: "error"` and a line explaining a first-run scope choice is required, and stop — the user seeds state by running the Otter scanner manually in `create` mode. (In practice state already exists, so this is a guard, not a normal path.)

## Refresh the dedup cache

New Otter meetings are flat direct children of `📆 Calendar`. The import barrier already refreshed these, so this is normally a fast no-op:

```bash
./bin/run.js cache sync-node --path "📆 Calendar"
```

## Validate calendar-derived titles before creating

Otter can borrow the title of any overlapping calendar event, including a skipped meeting. Treat that title as a claim to check against the recording, not evidence of who attended.

Before creating any nodes on a page, have the scanner compare each new meeting's Overview (`summary`) and available transcript-derived outline with its title. Check whether the named attendees and the subject fit what was actually recorded. A name mentioned in passing does not prove attendance; a name absent from a short summary does not prove absence. Use speaker or transcript evidence when available. If the evidence is missing or ambiguous, flag it as uncertain rather than infer a match.

On a mismatch or uncertainty, **flag the entry for review and create no node for it**. Never create it untitled, remove an attendee from its title, or invent a replacement title automatically. For example, a calendar title `Work lunch with @Alice` paired with an Overview about a personal weekend-planning conversation needs review. Preserve the original title, date, Otter URL/otid, and a concise reason in the local briefing; avoid copying the transcript into logs.

Preflight the whole page before writes. If any candidate is flagged, stop without creating that page's entries or updating its scanner state. Keep the cursor, session start, and last-synced boundary at the last successfully saved page so the held recordings resurface. Return any earlier pages' verified creates alongside the flags. Review flags are unresolved work, not a successful empty scan; use `status: "error"` so the prep date does not advance. Resolving a flag requires a later explicit user decision; this run does not alter or delete existing journal entries.

## Resolve a stale recording flag

The scanner flags a recording under 2 minutes long, with no summary after 24 hours, as `⚠️ Otter stale silent recording`, with its title, date, URL/otid, and duration. Report one such line per flag in the briefing, and return `status: "error"`. The auto run never deletes anything.

The daily review resolves each flag with the user, one `AskUserQuestion` per flag, with the title, date, URL, and duration inside the question. Options: "Delete it from Otter", "Keep it and skip it", "Keep it and wait". Delete only on an explicit "Delete it from Otter" answer for that otid, never in bulk and never by inference:

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/otter-api.sh trash <otid>
```

It returns `{"status": "OK"}` on success; treat anything else as a failure and report it. After a successful trash, rerun this command so the cursor advances. For "Keep it and skip it", record the otid as `skip` in `.llm/gtd/review/otter-confirmed-titles.json`, as in the title flag flow.

An unsummarized recording (2 minutes or longer, no summary after 24 hours) is flagged with the reason `no summary after 24 hours` and resolved the same way, one `AskUserQuestion` per flag with the title, date, URL, and duration. Its options are "Keep it and skip it", "Keep it and wait", and "Delete it from Otter". "Keep it and wait" leaves the page held, so offer it only when the user expects Otter to still produce a summary.

## Resolve a title flag

The auto run never resolves a flag on its own. The daily review does it with the user, one flag per `AskUserQuestion`, when it surfaces this task's error. Put the title, date, Otter URL, and the reason inside the question. Options: keep the title as recorded, retitle it, or skip the recording.

The main thread records each answer and creates nothing itself. Creation stays in the scanner. Merge each decision into `.llm/gtd/review/otter-confirmed-titles.json`, keyed by otid. Keep existing keys and overwrite only the otid just answered:

```json
{
	"abc123": { "title": "Work lunch with @Alice", "decidedAt": "2026-10-10" },
	"def456": { "skip": true, "decidedAt": "2026-10-10" }
}
```

- Keep or retitle: write `title` as the plain approved title text. The scanner wraps it in the `<time>` tag, Otter link, and `#meeting`.
- Skip: write `"skip": true` and no title. The scanner then passes over that recording without creating an entry.

Once every flag on the held page has a decision, rerun this command right away. If the user wants to wait, the next daily review's Auto run picks the decisions up instead. The scanner reads the file during title preflight, so a decided otid no longer holds the page. It creates the approved entries, skips the skipped ones, and advances the cursor. URL dedup still prevents duplicates. A recording with no decision still flags as before.

When the user confirms a flagged attendee was in the meeting, offer in a follow-up question to tag that person as a speaker in Otter. Word the options with the actor named, not bare "I" or "you". Offer "Claude tags it in the browser" first and "the user will tag it" below it. Otter learns a voice from tagged blocks and then labels that person in future recordings by itself, which stops the same flag from coming back. Erroneous tags destroy voice recognition far more than missing tags do, so suggest only 1-2 obvious blocks per person, never all blocks. Skip mixed or unattributed blocks, and suggest no tag when in doubt:

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/otter-api.sh speaker-blocks <otid> [count]
```

- Prints JSON: `{otid, title, url, speakers: [{speaker_id, label, blocks: [{time, chars, text}]}]}`. Each speaker other than the user gets its `count` longest blocks (default 2), in time order. Segments with no speaker go under `unattributed`, and `text` is cut to a 120-character preview so the block is easy to find.
- Choose the speaker whose blocks match the confirmed attendee. Often that is a generic `Speaker N` or `unattributed`.
- Put the URL plus each block's `[mm:ss]` time and preview inside the question. Do not put them in text around the question.
- Tagging happens in the Otter web app: open the URL, go to each listed block, click its speaker label, and choose or type the attendee's name. When Otter asks, apply the tag to every block from that speaker.
- When the user picks "Claude tags it in the browser", drive the Otter page through the browser tools. Afterward, reload the page and confirm every tagged block shows the attendee's name. If any block does not, say so in the next question.
- When the user picks "the user will tag it", the user tags the blocks and Claude moves on.

## Scan Otter and create (create mode)

Run the `otter-journal-scanner` agent in its default **`create`** mode — it scans meetings newer than `last_synced_otid`, builds the entry JSON, calendar-dedups each against `📆 Calendar` (`node search --query "otter.ai/u/<otid>"`), preflights calendar-derived titles against Overview/transcript evidence, **creates** each verified surviving meeting as a direct child of `📆 Calendar`, and advances the live `otter-journal-scanner` state after each page:

```text
Agent tool:
- subagent_type: "general-purpose"
  prompt: "CLAUDE_PLUGIN_ROOT=${CLAUDE_PLUGIN_ROOT}. Read ${CLAUDE_PLUGIN_ROOT}/prompts/journal/scanners/otter-journal-scanner.md and follow it. Create mode for otter-journal-auto: scan Otter for meetings newer than last_synced_otid, calendar-dedup against 📆 Calendar. Before any page writes, validate every new meeting title and named attendees against its Overview and available transcript evidence, applying any user decisions in .llm/gtd/review/otter-confirmed-titles.json first. On mismatch or uncertainty, flag for review, never create untitled or retitle, hold the whole page and its scanner state, and stop. Otherwise CREATE each verified new meeting under 📆 Calendar and advance the live scanner state. Return created meetings (date + title + otid), review flags (original title + date + otid/URL + concise reason), and the newest otid actually recorded. Run every Workflowy write as a bare CLI Bash call with no variable prefix, $(...), pipe, redirect, or chain: --json-file for entries, a literal --name for state."
```

(The scanner fetches with `${CLAUDE_PLUGIN_ROOT}/scripts/otter-api.sh sync-since <last_synced_otid>`, which lists small pages only until the boundary and fetches action items only for new meetings; `OTTER_USERNAME` / `OTTER_PASSWORD` must be set. If the scan fails — auth, network, API — create nothing, stage a briefing with `status: "error"` carrying the error, and stop; the review surfaces it and the cursor is untouched, so the meetings resurface next run.)

## Stage the briefing

Create the directory, then write `.llm/gtd/review/briefings/otter-journal.json` per the briefing schema in `${CLAUDE_PLUGIN_ROOT}/skills/review-proposal-staging.md`:

```bash
mkdir -p .llm/gtd/review/briefings
```

```json
{
	"task": "otter-journal",
	"status": "ready",
	"lines": ["📅 Added 1 Otter meeting: Platform Upgrades and Metrics (Jun 30)"],
	"autoApplied": ["Created 'Platform Upgrades and Metrics' under 📆 Calendar; cursor → 5m88r5g…"]
}
```

- `status`: `ready` (one or more created) | `empty` (caught up — nothing newer survived dedup) | `error` (scan failed, first-run scope needed, or titles need review).
- `lines`: folded verbatim into the daily-review summary — one line per created meeting, or `"📅 No new Otter meetings"` when empty.
- When titles need review, include one `⚠️ Otter title needs review` line per flag with its original title, date, URL/otid, and reason. State that no entry was created for the held page and its cursor was not advanced. Include any earlier pages' actual creates; never report a flag as created or caught up.
- `autoApplied`: what the auto run did (entries created, new cursor otid), for transparency.

## Summary

The daily review folds the staged `lines` into the final summary. Return verified success or empty with a one-line status. Return failure on scan or state errors or unresolved title-review flags. The DAG executor advances the prep date only after success or empty.

## Idempotency

After a successful run, a re-run creates nothing: the scanner's cursor-based dedup finds nothing newer than the just-persisted `last_synced_otid`, and the calendar-match backstop catches anything the cursor missed. The briefing then reads `status: "empty"`.

A run held for title review retries the unadvanced page. Existing URL and in-session dedup checks still prevent duplication of previously created entries; do not advance past a flag merely because it appeared in an earlier briefing.
