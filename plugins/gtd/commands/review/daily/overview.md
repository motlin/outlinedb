---
description: Morning orientation — pull together today's calendar, Apple Reminders, next actions, delegated/waiting items, and inbox status into one HTML page opened in the browser. Use when the user wants their morning briefing, to see what's on their plate today, or the overview portion of the daily review.
---

# GTD Daily Review

Quick morning orientation to see what's on your plate and plan your day.

## Do not use the built-in task list

Track all progress through `.llm/` files, Workflowy nodes, and inline status updates. Do **not** create Claude Code built-in tasks (`TaskCreate` / `TaskUpdate` / `TodoWrite`) to mirror the phases or per-item work in this command — they clutter the display and are never cleaned up.

(Note: launching **subagents** via the `Agent` tool / `subagent_type` is unrelated to the built-in task list and is expected.)

## Configuration

The GTD lists this overview reads are fixed paths, given in each section's `node get --path` command below.

**iMCP halt rule:** If any fetcher returns `status: "imcp-unavailable"`, stop the review and tell the user to reconnect, per the halt rule in `${CLAUDE_PLUGIN_ROOT}/skills/imcp-recovery.md`.

**iMCP self-heal preflight:** Before invoking `calendar-fetcher` / `reminders-fetcher`, proactively restart a stale iMCP so the fetchers don't trip the halt rule. iMCP stops responding after days of uptime (the app is still running but answers nothing). Check the helper's age:

```bash
IMCP_AGE=$(node ${CLAUDE_PLUGIN_ROOT}/scripts/imcp-helper-age.mts)
```

The script prints one token; branch on it:

- `none` — no helper running → launch a fresh one: `open -a iMCP`, `sleep 5`.
- a number **> 86400** — stale (older than ~1 day) → restart per the `imcp-recovery.md` recipe: `kill` this session's helper PID from `node ${CLAUDE_PLUGIN_ROOT}/scripts/imcp-helper-age.mts --pid` (`kill -9` if it survives; never a `pgrep` match, which includes other sessions' helpers), `open -a iMCP`, `sleep 5`. Restart even if the helper still answers a probe; age alone decides (see `imcp-recovery.md`).
- a number **≤ 86400** — fresh → proceed without restarting.
- `unknown` — helper running but start time unparseable → proceed; never kill a live helper on a parse glitch (a failed probe still restarts it — see below).

A liveness probe is an **additional** restart trigger, never a substitute for the age rule: if any `mcp__imcp__*` call errors or reports the server disconnected, restart regardless of age — a fresh (≤ 86400) or `unknown`-age helper included. The two rules only ever add restarts; neither one cancels the other's.

**Restart without asking:** The mandatory restart drops this session's MCP connection. That disconnect is expected and is never grounds for `AskUserQuestion` or another confirmation prompt. Restart first, then end the turn with the plain-text instruction: "iMCP has restarted. Run /mcp to reconnect, then re-run the daily review." Do not launch fetchers or continue the review before reconnection. **Claude cannot run `/mcp`**; return control immediately so the user can run it.

**Performance — front-load every fetch in one batch.** The two fetcher agents and the six `node get` reads have no data dependencies, so launch them all concurrently in a **single assistant message**: the `calendar-fetcher` Agent call, the `reminders-fetcher` Agent call, and the six `node get --path` Bash blocks below (Next Actions × 2, Delegate × 2, Inbox × 2). Wait for all results, then format the sections. Do not run the fetchers one after another.

**Date labels — compute with `date`, never by hand.** Derive the TODAY / TOMORROW weekday labels from the system clock; do not infer the day-of-week yourself. Capture them once up front and reuse them in the section headers:

```bash
TODAY_LABEL=$(date '+%a, %b %-d')        # e.g. Fri, Jun 26
TOMORROW_LABEL=$(date -v+1d '+%a, %b %-d')
```

**Output is an HTML page, never the console.** The overview is never printed to the console: a console overview goes unnoticed unless something else stops the turn. The `text` blocks in each section below describe that section's content and order; put that content into the page spec described in [Render the page](#render-the-page), not into chat.

**Output completeness rule:** Every section of the page MUST carry its full content. Never abbreviate by referring to earlier text ("already shown above", "see prior output") — if a section's content appeared earlier in the run, put it on the page again in full.

## Workflow

### Calendar Review

`calendar-fetcher` is launched in the front-loaded batch above (not sequentially) as a `general-purpose` subagent (`model: "sonnet"`) whose prompt starts `CLAUDE_PLUGIN_ROOT=${CLAUDE_PLUGIN_ROOT}. Read ${CLAUDE_PLUGIN_ROOT}/prompts/fetchers/calendar-fetcher.md and follow it.` pass `startDate`=today 00:00:00 ISO, `endDate`=day-after-tomorrow 00:00:00 ISO, `includeWorkflowy: true`. Returns `{fantastical, workflowy, summary, errors}`.

#### Format

Combine the agent's output into unified display:

```text
📅 TODAY'S CALENDAR
Fantastical (via EventKit):
  - 10:00 AM - Team standup (calendar-name)
  - 2:00 PM - Dentist (calendar-name)
  - All day - Holiday (calendar-name)
> Open Fantastical for full view: fantastical://

Workflowy:
  - (items from workflowy array matching today's date)
```

Use `$TODAY_LABEL` in the "📅 TODAY'S CALENDAR" header. Then show "📅 **Tomorrow Preview — $TOMORROW_LABEL:**" in the same format, filtering for tomorrow's date — taking the weekday from `$TOMORROW_LABEL`, never hand-computed.

Include the Fantastical deep link (`fantastical://`) to allow quick access to the full calendar view.

### Apple Reminders

`reminders-fetcher` is launched in the same front-loaded batch above as a `general-purpose` subagent (`model: "sonnet"`) whose prompt starts `CLAUDE_PLUGIN_ROOT=${CLAUDE_PLUGIN_ROOT}. Read ${CLAUDE_PLUGIN_ROOT}/prompts/fetchers/reminders-fetcher.md and follow it.` Returns `{overdue, dueToday, dueTomorrow, noDueDateCount, summary, errors}`.

Format the agent's output as:

```text
🔔 APPLE REMINDERS
Overdue (2):
  - 🔴 Overdue reminder 1 (Dec 15)
  - 🔴 Overdue reminder 2 (Dec 20)

Due Today (3):
  - Reminder with time (1:00 PM)
  - Another reminder (2:40 PM)
  - Morning reminder (9:05 AM)

Due Tomorrow (1):
  - Tomorrow's reminder

No due date: 3 items
```

### Next Actions

List Next Actions from both contexts using `node get` with `--path`:

```bash
./bin/run.js node get --path "Personal,☑️ Next (Personal)" --depth 1 --json --fields name,completedAt,shortId,children
./bin/run.js node get --path "Work,☑️ Next (Work)" --depth 1 --json --fields name,completedAt,shortId,children
```

Filter to `completedAt == null` (the `completedAt` field, not `completed`). Format as "☑️ **Next Actions:**" with items grouped by context (Personal / Work).

**Future-dated filtering:** Hide items with a `<time>` tag whose start date is more than 3 days from today. These are deferred and not actionable yet.

**Quick Wins:** Scan for items containing `<2min` or `2 min` or similar patterns. Highlight these as quick wins that can be done immediately.

### Delegate / Waiting For

List items delegated or waiting on others:

```bash
./bin/run.js node get --path "Personal,📤 Delegate" --depth 1 --json --fields name,completedAt,shortId,children
./bin/run.js node get --path "Work,📤 Delegate" --depth 1 --json --fields name,completedAt,shortId,children
```

Filter to `completedAt == null`. Format as "📤 **Delegate / Waiting For:**" — flag items that seem overdue or need follow-up.

### Inbox Status

Count inbox items:

```bash
./bin/run.js node get --path "Personal,📥 Inbox" --depth 1 --json --fields name,shortId,children
./bin/run.js node get --path "Work,📥 Inbox" --depth 1 --json --fields name,shortId,children
```

Also check the root Inbox:

```bash
./bin/run.js node list --parent-id <root-inbox-id> --json
```

Format as "📥 **Inbox Status:**" showing count for each. If combined count > 10, suggest running `/gtd:inbox` after daily review.

### Render the page

Write the sections to `.llm/gtd/review/overview.json`, render it, and open it in the browser:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/render-overview.mts .llm/gtd/review/overview.json .llm/gtd/review/overview.html
open .llm/gtd/review/overview.html
```

The spec, with plain-text strings (strip Workflowy HTML such as `<time>` and `<a>` down to its text; put a node's Workflowy URL in `href`):

```json
{
	"title": "Morning overview",
	"subtitle": "$TODAY_LABEL",
	"sections": [
		{
			"heading": "📅 Today's calendar — $TODAY_LABEL",
			"link": {"label": "Open Fantastical", "href": "fantastical://"},
			"groups": [
				{"heading": "Fantastical", "items": [{"text": "10:00 AM - Team standup", "note": "calendar-name"}]},
				{"heading": "Workflowy", "items": []}
			]
		},
		{
			"heading": "☑️ Next Actions",
			"groups": [{"heading": "Personal", "items": [{"text": "Call the plumber <2min", "href": "https://workflowy.com/#/<shortId>", "highlight": true}]}],
			"notes": ["Quick win: Call the plumber"]
		}
	]
}
```

One section per heading above, in order: Today's calendar, Tomorrow preview, Apple Reminders (groups Overdue / Due Today / Due Tomorrow, the no-due-date count as a note), Next Actions (one group per context), Delegate / Waiting For, Inbox Status (counts as items, the `/gtd:inbox` suggestion as a note). `highlight: true` marks overdue reminders, overdue delegated items, and quick wins. An empty group renders as "None"; keep it rather than dropping the heading.

The script exits non-zero naming the first malformed field; fix the spec and rerun. In chat, write one line naming the opened page, then continue.

### This phase orients; it does not act

Render and open the page, then move on in the same turn. **Do not offer to complete, move, or edit anything here.**

Every actionable outcome belongs to a later phase, and each has a walk built for it:

| What the user wants to do           | Where it happens                     |
| ----------------------------------- | ------------------------------------ |
| Complete or reschedule a dated task | Recurring Review — due-items segment |
| File an inbox item                  | Process Inbox                        |
| Move a loose task into a bucket     | File Loose Tasks                     |
| Handle a recurring item             | Recurring Review — recurring segment |

Do not render the overview as a checklist with completion controls. The real outcomes are move, edit, reschedule, and discuss, not just complete, and later phases handle each item one at a time with `AskUserQuestion`.

If the user does ask for an immediate change while reading the overview, just do it — that's a normal request, not a phase. Don't build a prompt loop around it.

### Next Step

Do **not** prompt "what would you like to do next?" — the daily review's phase ordering is deterministic. When invoked as part of `/gtd:review:daily`, continue straight into the next phase (Distribute Project Tasks) in the same turn — opening the page never ends the turn. When invoked standalone, simply end after logging completion.

### Log Completion

After completing the review, log to Session Memory:

```bash
TODAY=$(date +%Y-%m-%d)
TIME=$(date +%H:%M)
./bin/run.js node create --parent-path "Metadata,🧠 Session Memory,$TODAY" --name "daily-review: $TIME - completed"
```

If the date node doesn't exist, create it first:

```bash
./bin/run.js node create --parent-path "Metadata,🧠 Session Memory" --name "$TODAY"
```

## Looking Up Appointment Details

When the user asks about an appointment during the overview (when a service visit arrives, how long its window is), follow **Look up an appointment in email** in `${CLAUDE_PLUGIN_ROOT}/skills/due-item-walk.md`: search every configured `mcp__gmail-<account>-imap__` account by subject word, sender, and body keyword, and open the source email behind any Gmail-created calendar event for the day to read the full window.

## Creating Events via Fantastical

To create a calendar event from a task or inbox item:

```bash
osascript -e 'tell application "Fantastical" to parse sentence "Meeting with John tomorrow at 2pm" with add immediately'
```

## Completing Apple Reminders

Completion happens in the Recurring Review's due-items segment, not here — `collect-due-items.mts` stages the exact `osascript` per reminder, because **iMCP exposes no complete/update tool** (only `reminders_create` / `reminders_fetch` / `reminders_lists`).

Two gotchas that apply wherever that op runs:

- **Recurring reminders roll forward**: completing the overdue instance creates a fresh incomplete one at the next occurrence — verify with `reminders_fetch completed:false query:"<title>"`. You can't permanently clear a repeating series without deleting it; leave it unless the user asks.
- The Reminders/AppleScript bridge **stops responding to writes** after a handful of them — `osascript` hangs until its timeout kills it, exits 124, and applies nothing, while `reminders_fetch` keeps reading fine the whole time. Quitting and relaunching Reminders.app clears it for the next few writes. Batch all reminder writes into one script rather than one per item; see **Apple Reminders writes freeze** in `daily/due.md`. Always confirm through `reminders_fetch`, never through the script's exit code.
- **`reminders_create` drops the due date.** A reminder created through iMCP comes back with no `scheduledTime`, so no alarm ever fires. To create a reminder that actually alerts at a time, use Fantastical instead: `osascript -e 'tell application "Fantastical" to parse sentence "reminder <title> today at 10:07am" with add immediately'`, then verify with `reminders_fetch`. Fantastical also exits 0 on failure, so the verification is not optional — a calendar-event parse can silently create nothing, in which case redo it with `events_create`.
- The fetcher returns `list: null`, so the staged op targets the default "Reminders" list; iterate `lists` if a title isn't found there.
