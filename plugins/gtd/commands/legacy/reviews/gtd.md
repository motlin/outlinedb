---
description: Deprecated legacy GTD orchestrator — checks review/inbox state and routes to daily review, weekly review, inbox processing, or focus. Superseded by invoking /gtd:review:daily and friends directly; reach for this only when explicitly requested.
---

# GTD Smart Orchestrator

> Legacy command. Prefer invoking `/gtd:review:daily`, `/gtd:inbox`, etc. directly; use this only when explicitly requested.

Checks current state and suggests or routes to the appropriate GTD action.

## Workflow

### Check Session Memory

Use the `read-metadata` skill to load GTD configuration and session state. The skill handles data source selection and returns Session Memory entries.

From the Session Memory entries, parse recent entries to determine:

- Last daily review date/time
- Last weekly review date/completion status
- Any incomplete reviews

### Check for Incomplete Weekly Review

Look for entries like `weekly-review: started, step X of 6` without a subsequent `weekly-review: completed`.

If found, use AskUserQuestion:

- "You have an incomplete weekly review at step X of 6. What would you like to do?"
- Options:
    - "Resume weekly review" → invoke `/gtd:legacy:reviews:weekly`
    - "Start fresh weekly review"
    - "Skip to daily review"
    - "Just get focus suggestions"

### Check Daily Review Status

Calculate if daily review was done today:

- Parse Session Memory for today's date (YYYY-MM-DD)
- Look for `daily-review: HH:MM - completed`

If not done today:

- "Daily review not done yet today. Start now?"
- Options:
    - "Yes, start daily review" → invoke `/gtd:review:daily`
    - "No, skip for now"

### Check Weekly Review Status

Calculate days since last completed weekly review:

- Find most recent `weekly-review: completed` entry
- Calculate days elapsed

If > 7 days since last weekly:

- "Weekly review is overdue (last: X days ago). What would you like to do?"
- Options:
    - "Start weekly review now" → invoke `/gtd:legacy:reviews:weekly`
    - "Do daily review first" → invoke `/gtd:review:daily`
    - "Skip to focus suggestions"

### Check Inbox Status

```bash
./bin/run.js utils path-to-id --path "📥 Inbox" --data-source cache | xargs -I{} ./bin/run.js node list --parent-id {}
./bin/run.js utils path-to-id --path "📥 Inbox" --data-source cache | xargs -I{} ./bin/run.js node list --parent-id {}
```

Count total inbox items.

If inbox items > 0:

- "You have X items in your inbox. Process them?"
- Options:
    - "Process inbox now" → invoke `/gtd:inbox`
    - "Skip inbox for now"

### All Clear - Offer Focus

If everything is current (daily done, weekly recent, inbox manageable):

- "Your GTD system is current! What would you like to do?"
- Options:
    - "Get focus suggestions" → invoke `/gtd:legacy:focus`
    - "Quick capture" → prompt for text, then invoke `/gtd:capture`
    - "Nothing, I'm good"

## Output Format

```text
🧠 GTD STATUS CHECK

Session Memory: ✓ Connected
Last Daily: Today at 09:30
Last Weekly: 3 days ago (Dec 18)
Inbox: 7 items (Personal: 2, Work: 5)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

✓ Daily review completed today
✓ Weekly review is current
⚠️ Inbox has items to process

Suggestion: Process 7 inbox items?

[Options presented via AskUserQuestion]
```

## Chaining Behavior

After completing one action, offer logical next steps:

- After `/gtd:review:daily` → "Process inbox?" or "Get focus suggestions?"
- After `/gtd:inbox` (if inbox zero) → "Get focus suggestions?" or "Done for now?"
- After `/gtd:legacy:reviews:weekly` → "System is current! Get focus suggestions?"

## Notes

- Legacy entry point; current setups invoke the daily/weekly/inbox commands directly
- Uses AskUserQuestion throughout for collaborative flow
- Always provides an exit option ("I'm good for now")
- Chains commands naturally based on context

## Daily Review vs Weekly Review

The GTD book by David Allen prescribes only the **Weekly Review** as a formal review practice. The book describes quick, moment-to-moment glances at your calendar and action lists throughout the day, but not a structured "daily review."

Our "daily review" command is an enhancement we added for more frequent orientation. The current order (daily before weekly when both are due) is our design choice - the GTD book does not address this since it only has one formal review type.
