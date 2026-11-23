---
description: Deprecated legacy bulk capture — scan Chrome tabs, git repos, iMessages, GitHub PRs, and Gmail for inbox items. Superseded by /gtd:capture; reach for this only when explicitly invoking the legacy orchestrator.
---

# GTD Bulk Capture

> Legacy command. The current `/gtd:capture` covers multi-source capture; use this only when explicitly asked for the legacy flow.

Scan external sources for items to capture into the GTD system. This command orchestrates capture subagents to process:

- Chrome browser tabs (open tabs and high-engagement history)
- Git repositories (unpushed commits in ~/projects)
- iMessages (actionable messages from the past 7 days)
- GitHub PRs (authored PRs awaiting review, PRs where review is requested)
- Gmail (unread emails needing attention)

## Do not use the built-in task list

Track all progress through `.llm/` files, Workflowy nodes, and inline status updates. Do **not** create Claude Code built-in tasks (`TaskCreate` / `TaskUpdate` / `TodoWrite`) to mirror the sources or per-item work in this command — they clutter the display and are never cleaned up.

(Note: launching **subagents** via the `Agent` tool / `subagent_type` is unrelated to the built-in task list and is expected.)

## Architecture

This command is an **orchestrator** that invokes modular capture subagents. Each subagent:

- Invokes its corresponding scanner agent
- Processes items interactively with the user
- Creates Workflowy nodes with proper provenance
- Returns structured JSON with capture results

**Capture Subagents** (in `${CLAUDE_PLUGIN_ROOT}/prompts/capture/`):

| Subagent         | Scanner Used        | Purpose                                       |
| ---------------- | ------------------- | --------------------------------------------- |
| chrome-capture   | chrome-tabs-scanner | Process Chrome tabs and high-engagement pages |
| git-capture      | git-repos-scanner   | Process unpushed/uncommitted git work         |
| imessage-capture | imessage-scanner    | Process actionable iMessages                  |
| github-capture   | github-pr-checker   | Process GitHub PRs                            |
| gmail-capture    | gmail-checker       | Process Gmail inbox                           |

**Reference skills:**

- **capture-provenance.md** - Format for captured items (source, URL, date, tags)

**Support agents:**

- **read-metadata** - Load GTD configuration from Workflowy Metadata node
- **session-memory-writer** - Log capture operations to Session Memory

## Load Configuration

Invoke the read-metadata agent to get inbox paths:

```text
/agents/gtd/fetchers/read-metadata
```

Extract the `inboxPath` for use in capture subagents.

## Check Previously Declined Items

Check Session Memory for items declined in the past 7 days:

```bash
./bin/run.js node get --path "Metadata,🧠 Session Memory" --depth 3
```

Look for entries under recent dates containing:

- `bulk-capture-declined: <url or identifier>`

Build a `declinedItems` array of URLs to pass to the chrome-capture subagent.

## Process Each Source

Invoke each capture subagent in sequence, collecting results.

### Source 1: Chrome Tabs

Invoke the chrome-capture subagent:

```text
/agents/gtd/capture/chrome-capture with lookbackDays=7 inboxPath="<inboxPath>" declinedItems=<declinedItems>
```

The subagent handles:

- Scanning Chrome via chrome-tabs-scanner
- Presenting items to user with AskUserQuestion
- Creating Workflowy nodes with provenance
- Optionally closing captured tabs
- Tracking declined items for Session Memory

Collect the returned JSON result for summary.

If unavailable, display: "(Chrome tabs unavailable)"

### Source 2: Git Repositories

Invoke the git-capture subagent:

```text
/agents/gtd/capture/git-capture with inboxPath="<inboxPath>"
```

The subagent handles:

- Scanning repos via git-repos-scanner
- Presenting repos with work to user
- Creating tasks or executing git push as requested
- Tracking stale unpushed work

Collect the returned JSON result for summary.

If unavailable, display: "(Git repositories scan unavailable)"

### Source 3: iMessages

Invoke the imessage-capture subagent:

```text
/agents/gtd/capture/imessage-capture with lookbackDays=7 inboxPath="<inboxPath>"
```

The subagent handles:

- Scanning messages via imessage-scanner
- Presenting actionable messages to user
- Creating Workflowy nodes with provenance

Collect the returned JSON result for summary.

If unavailable, display: "(iMessage unavailable)"

### Source 4: GitHub PRs

Invoke the github-capture subagent:

```text
/agents/gtd/capture/github-capture with inboxPath="<inboxPath>"
```

The subagent handles:

- Checking PRs via github-pr-checker
- Presenting review requests and authored PRs to user
- Creating Workflowy nodes with provenance

Collect the returned JSON result for summary.

If unavailable, display: "(GitHub PRs unavailable)"

### Source 5: Gmail

Invoke the gmail-capture subagent:

```text
/agents/gtd/capture/gmail-capture with inboxPath="<inboxPath>"
```

The subagent handles:

- Checking inbox via gmail-checker
- Filtering automated notifications
- Presenting actionable emails to user
- Creating Workflowy nodes with provenance

Collect the returned JSON result for summary.

If unavailable, display: "(Gmail unavailable)"

## Record Declined Items

For any items declined in chrome-capture (returned in `declined` array), record to Session Memory (use `--position bottom` to preserve chronological order):

```bash
TODAY=$(date +%Y-%m-%d)

# Create date node if needed
./bin/run.js node create --parent-path "Metadata,🧠 Session Memory" --name "$TODAY"

# Record each declined URL
for url in <declined_urls>; do
  ./bin/run.js node create --parent-path "Metadata,🧠 Session Memory,$TODAY" --name "bulk-capture-declined: $url" --position bottom
done
```

## Log Completion

Log the bulk capture session to Session Memory:

```bash
TODAY=$(date +%Y-%m-%d)
TIME=$(date +%H:%M)

./bin/run.js node create --parent-path "Metadata,🧠 Session Memory,$TODAY" \
  --name "bulk-capture: $TIME - X from Chrome, Y from git, Z from iMessage, W from GitHub, V from Gmail" \
  --position bottom
```

## Display Summary

Aggregate results from all subagents and display:

```text
BULK CAPTURE SUMMARY
══════════════════════════════════════════════════════════════════════

Chrome tabs:    X captured, Y declined, Z tabs closed
Git repos:      X tasks created, Y repos pushed, Z skipped
iMessages:      X captured, Y already handled, Z skipped
GitHub PRs:     X captured, Y skipped
Gmail:          X captured, Y already handled, Z skipped

──────────────────────────────────────────────────────────────────────
Total items added to inbox: N
══════════════════════════════════════════════════════════════════════
```

## Usage

This command can be invoked:

- Directly: `/gtd:legacy:bulk-capture`
- By weekly review: Review Recent Changes phase
- By daily review: Optional, if user wants deeper capture

## Subagent Benefits

Each capture agent can be invoked independently, tested in isolation, and changed without affecting other sources; new sources are added as new subagents.

## Notes

- Deduplication is time-bounded: Chrome history and iMessages are scanned for past 7 days only
- Chrome tabs that are captured can optionally be closed to prevent re-offering
- Items explicitly declined are tracked in Session Memory and not offered again for 7 days
- Git repos with pushed commits naturally disappear from the scan
- All captured items use capture-provenance skill format for consistent source tracking
