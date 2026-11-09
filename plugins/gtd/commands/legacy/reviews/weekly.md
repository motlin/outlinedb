---
description: Deprecated legacy weekly review — full David Allen Get Clear/Current/Creative pass over inboxes, next actions, calendar, projects, and goals (60-90 min). Legacy/unmaintained; reach for this only when explicitly invoked.
---

# GTD Weekly Review

> Legacy command, unmaintained. Use only when explicitly invoked.

The complete weekly review following David Allen's GTD methodology. Takes 60-90 minutes and covers the full "Get Clear, Get Current, Get Creative" sequence.

## Do not use the built-in task list

Track all progress through `.llm/` files, Workflowy nodes, and inline status updates. Do **not** create Claude Code built-in tasks (`TaskCreate` / `TaskUpdate` / `TodoWrite`) to mirror the phases or per-item work in this command — they clutter the display and are never cleaned up.

(Note: launching **subagents** via the `Task` tool / `subagent_type` is unrelated to the built-in task list and is expected.)

## Configuration

Use the `read-metadata` agent to discover all GTD lists dynamically:

```text
Invoke read-metadata agent with deepFetch=['inboxes', 'projects', 'nextActions', 'waitingFor', 'someday', 'calendar', 'sessionMemory']
```

This returns all configured lists from Metadata. **Do not hardcode paths like "📥 Inbox"** - always iterate over the arrays returned by read-metadata.

## Pre-Review: Check for Incomplete Review

Before starting, check Session Memory for incomplete reviews:

```bash
./bin/run.js utils path-to-id --path "Metadata,🧠 Session Memory" --data-source api | xargs -I{} ./bin/run.js node list --parent-id {}
```

Look for entries like `weekly-review: started, step X of 6`. If found, use AskUserQuestion:

- "You have an incomplete weekly review at step X. Resume or start fresh?"
- Options: "Resume from step X", "Start fresh"

## Phase 1: GET CLEAR (Steps 1-2)

### Process Inboxes to Zero

The read-metadata agent returns `deepFetched.inboxes` as an array. Check each inbox for items:

```text
For each inbox in deepFetched.inboxes:
  - Log: "Checking {inbox.linkName}: {inbox.items.length} items"
  - If items.length > 0, they need processing
```

If any inbox has items, invoke `/gtd:inbox` processing until all are empty.

Log progress:

```bash
TODAY=$(date +%Y-%m-%d)
./bin/run.js node create --parent-path "Metadata,🧠 Session Memory,$TODAY" --name "weekly-review: started, step 1 of 6"
```

### Review Recent Changes

Check for nodes modified in the past week to catch anything that might have been missed.

Review folders are optional and may not be configured in all setups. Check if they exist:

```bash
# Review folders are optional - check if they exist before listing
./bin/run.js utils path-to-id --path "🔄 Review" --data-source api 2>/dev/null | xargs -I{} ./bin/run.js node list --parent-id {}
./bin/run.js utils path-to-id --path "🔄 Review" --data-source api 2>/dev/null | xargs -I{} ./bin/run.js node list --parent-id {}
```

If Review folders exist and have items, present them for processing.

#### Bulk Capture from External Sources

Invoke the bulk-capture command to scan Chrome tabs, git repositories, and iMessages for items to capture:

```text
/gtd:legacy:bulk-capture
```

This handles:

- Chrome browser tabs (open tabs and high-engagement history)
- Git repositories (unpushed commits in ~/projects)
- iMessages (actionable messages from the past 7 days)

Update progress:

```bash
./bin/run.js node create --parent-path "Metadata,🧠 Session Memory,$TODAY" --name "weekly-review: completed step 1, on step 2"
```

## Phase 2: GET CURRENT (Steps 3-5)

### Review Next Actions

The read-metadata agent returns `deepFetched.nextActions` as an array. Review all Next Actions lists:

```text
For each list in deepFetched.nextActions:
  - Log: "Reviewing {list.linkName}: {list.items.length} items"
  - Present items for review
```

For each item, use AskUserQuestion:

- "Is this still relevant?"
- Options: "Keep", "Complete now", "Move to Someday", "Delete"

Remove stale items, update any that need clarification.

Update progress:

```bash
./bin/run.js node create --parent-path "Metadata,🧠 Session Memory,$TODAY" --name "weekly-review: completed step 2, on step 3"
```

### Review Calendar

#### Fantastical / Apple Calendar (via iMCP)

Invoke `calendar-fetcher` as a `general-purpose` subagent (`model: "sonnet"`) whose prompt starts `CLAUDE_PLUGIN_ROOT=${CLAUDE_PLUGIN_ROOT}. Read ${CLAUDE_PLUGIN_ROOT}/prompts/fetchers/calendar-fetcher.md and follow it.` Fetch past week and upcoming week events:

```text
Invoke calendar-fetcher agent with:
  startDate: 7 days ago at 00:00:00 (ISO 8601 format)
  endDate: 7 days from now at 23:59:59 (ISO 8601 format)
  includeWorkflowy: false
```

The agent returns consolidated JSON with events from all calendars synced to the system (iCloud, Google, etc.) - the same data shown in Fantastical.

**iMCP halt:** If the agent returns `status: "imcp-unavailable"`, **STOP the weekly review immediately**. Display the agent's `message` to the user and do not continue — a weekly review missing calendar data is not useful. See `${CLAUDE_PLUGIN_ROOT}/skills/imcp-recovery.md`. The user must get iMCP running, then re-run the review.

Review the returned events:

- **Past week events**: Look for lessons learned, missed follow-ups
- **Upcoming week events**: Identify preparation needed

#### Workflowy Calendar (supplementary)

The read-metadata agent returns `deepFetched.calendar` as an array:

```text
For each cal in deepFetched.calendar:
  - Log: "Reviewing {cal.linkName}"
  - Present upcoming items
```

Present upcoming commitments, ask if any need prep actions.

Open Fantastical for full calendar view: `fantastical://`

#### Apple Reminders (via iMCP)

Invoke `reminders-fetcher` as a `general-purpose` subagent (`model: "sonnet"`) whose prompt starts `CLAUDE_PLUGIN_ROOT=${CLAUDE_PLUGIN_ROOT}. Read ${CLAUDE_PLUGIN_ROOT}/prompts/fetchers/reminders-fetcher.md and follow it.` Get categorized reminders:

```text
Invoke reminders-fetcher agent
```

**iMCP halt:** If the agent returns `status: "imcp-unavailable"`, **STOP the weekly review immediately**. Display the agent's `message` and do not continue. See `${CLAUDE_PLUGIN_ROOT}/skills/imcp-recovery.md`.

The agent returns reminders grouped by due date status:

- **overdue** - Flag for immediate attention
- **dueToday** - Review what's due today
- **dueTomorrow** - Preview tomorrow's reminders

For each overdue reminder, use AskUserQuestion:

- "This reminder is overdue: [title]. What would you like to do?"
- Options: "Mark complete", "Reschedule to today", "Reschedule to this week", "Convert to Workflowy task"

For reminders due this week, verify they're still relevant and have appropriate due dates.

Update progress:

```bash
./bin/run.js node create --parent-path "Metadata,🧠 Session Memory,$TODAY" --name "weekly-review: completed step 3, on step 4"
```

### Review Waiting For & Projects

**Waiting For:**

The read-metadata agent returns `deepFetched.waitingFor` as an array:

```text
For each list in deepFetched.waitingFor:
  - Log: "Reviewing {list.linkName}: {list.items.length} items"
  - Present items for follow-up check
```

For each item, ask:

- "Need to follow up on this?"
- Options: "Yes, add follow-up action", "Still waiting", "Complete/remove"

**Projects:**

The read-metadata agent returns `deepFetched.projects` as an array:

```text
For each list in deepFetched.projects:
  - Log: "Reviewing {list.linkName}: {list.items.length} projects"
  - Check each project has a next action
```

For each project, verify it has a defined next action. If not, capture one.

Update progress:

```bash
./bin/run.js node create --parent-path "Metadata,🧠 Session Memory,$TODAY" --name "weekly-review: completed step 4, on step 5"
```

## Phase 3: GET CREATIVE

### Review Someday/Maybe & Goals

The read-metadata agent returns `deepFetched.someday` as an array:

```text
For each list in deepFetched.someday:
  - Log: "Reviewing {list.linkName}: {list.items.length} items"
  - Present items for potential activation
```

For interesting items, ask:

- "Ready to activate this?"
- Options: "Promote to Projects", "Keep in Someday", "Delete"

When user selects "Promote to Projects", invoke the `create-project.md` skill:

- Creates the project node in the appropriate domain (Personal/Work)
- Registers the project in Metadata > 📁 Projects with link and metadata
- Ensures proper project tag format (#kebab-case)

#### Review Higher Horizons (Goals)

Review goals from the Metadata node:

```bash
./bin/run.js utils path-to-id --path "Metadata,🎯 Goals" --data-source api | xargs -I{} ./bin/run.js node list --parent-id {}
```

For each goal, review its sub-structure:

- **Context**: Is the "why" still valid?
- **Progress**: Update with any recent achievements
- **Linked Projects**: Are current projects aligned with this goal?

For each goal, ask:

- "Is this goal still relevant? Any updates?"
- Options: "Update progress", "Link new project", "Archive goal", "Keep as-is"

This is the time to think about higher-level horizons:

- Are your current projects aligned with your goals?
- Is there a goal that has no active projects?
- Should any Someday items be promoted to support a goal?

Update progress:

```bash
./bin/run.js node create --parent-path "Metadata,🧠 Session Memory,$TODAY" --name "weekly-review: completed step 5, on step 6"
```

## Completion

After all steps, log completion:

```bash
./bin/run.js node create --parent-path "Metadata,🧠 Session Memory,$TODAY" --name "weekly-review: completed"
```

Show summary:

- Inboxes processed: X items
- Bulk capture: (see /gtd:legacy:bulk-capture summary)
- Next Actions reviewed: Y items (Z removed)
- Calendar/Reminders: X events reviewed, Y overdue reminders addressed
- Projects reviewed: N (all have next actions: ✓/✗)
- Waiting For items: M (follow-ups created: K)
- Someday items promoted: P
- Goals reviewed: G (progress updated: U, new projects linked: L)

## Progress Tracking

The 6 steps of weekly review:

- **Get Clear** - Process inboxes to zero
- **Get Clear** - Review temporal changes
- **Get Current** - Review Next Actions
- **Get Current** - Review Calendar
- **Get Current** - Review Waiting For & Projects
- **Get Creative** - Review Someday/Maybe & Goals

Session Memory entries track progress:

- `weekly-review: started, step 1 of 6`
- `weekly-review: completed step 1, on step 2`
- ...
- `weekly-review: completed`

## Interruption Handling

If user needs to stop mid-review:

- Save current step to Session Memory
- Confirm with user: "Weekly review paused at step X. Run /gtd:legacy:reviews:weekly later to resume."

## Output Format

```text
📋 WEEKLY REVIEW
══════════════════════════════════════════════════════════════════════

Phase 1: GET CLEAR
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Process Inboxes
(List each inbox from deepFetched.inboxes dynamically)
  Inbox: 3 items → Processing...
  Personal 📥 Inbox: 5 items → Processing...
  Work 📥 Inbox: 2 items → Processing...
[invoke /gtd:inbox]
✓ All inboxes cleared

Review Changes
[check Review folders if configured]
[invoke /gtd:legacy:bulk-capture]
✓ Changes reviewed

Phase 2: GET CURRENT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Review Next Actions
(List each from deepFetched.nextActions dynamically)
...

Review Calendar & Reminders
Past week events: 5 reviewed
Upcoming week events: 8 reviewed

Apple Reminders:
  ⚠️ Overdue (2):
    "Pay credit card" (due: Jan 10) - 5 days overdue
    "Call doctor" (due: Jan 12) - 3 days overdue
  Today (1):
    "Submit report" (due: Jan 15)
  Tomorrow (0): none
[Addressing overdue reminders...]
✓ Calendar and reminders reviewed
...
```

## Notes

- Aim for 60-90 minutes total
- Can be split across sessions if needed (progress saved)
- Best done on consistent day/time (e.g., Friday afternoon, Sunday evening)
- Use AskUserQuestion liberally - this is collaborative review
