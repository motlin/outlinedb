---
description: Deprecated legacy focus helper — suggest what to work on next from Next Actions, filtered by location, energy, and available time. Legacy/unmaintained; reach for this only when explicitly invoked.
---

# GTD Focus Helper

> Legacy command, unmaintained. Use only when explicitly invoked.

Decide what to work on next based on current context, energy, and available time.

## Configuration

Use the `read-metadata` skill to discover GTD paths from the Workflowy Metadata node.

## Workflow

### Gather Context

Use AskUserQuestion to understand current situation:

**Question 1: Where are you?** Options:

- "🏠 Home"
- "🏢 Office"
- "📱 Mobile/Out"
- "🌐 Anywhere (has computer)"

**Question 2: Energy level?** Options:

- "⚡ High - ready for deep work"
- "🔋 Medium - can do routine tasks"
- "🪫 Low - need easy wins"

**Question 3: Time available?** Options:

- "⏱️ 5 minutes"
- "⏱️ 15 minutes"
- "⏱️ 30 minutes"
- "⏱️ 1+ hours"

### Check Calendar Constraints

```bash
TODAY=$(date +%Y-%m-%d)
HOUR=$(date +%H)
./bin/run.js utils path-to-id --path "📅 Calendar,$TODAY" --data-source cache | xargs -I{} ./bin/run.js node list --parent-id {}
./bin/run.js utils path-to-id --path "📅 Calendar,$TODAY" --data-source cache | xargs -I{} ./bin/run.js node list --parent-id {}
```

Note any upcoming meetings or commitments that constrain available time.

### Fetch Next Actions

```bash
./bin/run.js utils path-to-id --path "☑️ Next Actions" --data-source cache | xargs -I{} ./bin/run.js node list --parent-id {}
./bin/run.js utils path-to-id --path "☑️ Next Actions" --data-source cache | xargs -I{} ./bin/run.js node list --parent-id {}
```

### Filter and Score

Based on gathered context, filter and score tasks:

**Location Filter:**

- Home: Prioritize personal tasks, home-context items
- Office: Prioritize work tasks
- Mobile: Filter to tasks doable without computer
- Anywhere: No location filter

**Energy Filter:**

- High: Prioritize complex, creative, or challenging tasks
- Medium: Balanced mix
- Low: Prioritize simple, routine, or quick tasks

**Time Filter:**

- 5 min: Only <2min quick wins or very short tasks
- 15 min: Short tasks, email, quick calls
- 30 min: Standard tasks, meetings prep
- 1+ hour: Deep work, projects, complex tasks

**Quick Wins:** Scan for `<2min` patterns - these are always good options for low energy or short time.

### Present Recommendations

Show top 3-5 filtered tasks with reasoning:

```text
🎯 FOCUS SUGGESTIONS

Based on: 🏢 Office, ⚡ High energy, ⏱️ 30 min

Recommended:
- 💼 Review PR #234 (Work)
   Deep work task, matches your high energy

- 💼 Prepare demo slides (Work)
   Creative task, good for focused time

- 🏠 Research laptop options (Personal)
   Can do from office, good thinking task

Quick Wins Available:
⚡ Approve expense report (<2 min)
⚡ Reply to Slack message (<2 min)

📅 Note: Team standup in 45 minutes
```

### Offer Actions

Use AskUserQuestion:

- "What would you like to do?"
- Options:
    - "[Task 1 name]" → Provide details and focus tips
    - "[Task 2 name]" → Provide details and focus tips
    - "Show more options" → Expand list
    - "I'll pick my own" → Exit

## Scoring Logic

Each task gets a score based on context match:

```text
Score = LocationMatch(0-2) + EnergyMatch(0-2) + TimeMatch(0-2) + QuickWinBonus(0-1)
```

**LocationMatch:**

- 2: Perfect match (work task + office, personal task + home)
- 1: Compatible (anywhere context)
- 0: Mismatch

**EnergyMatch:**

- 2: High energy + complex task, or Low energy + simple task
- 1: Medium match
- 0: Mismatch (low energy + complex task)

**TimeMatch:**

- 2: Task fits available time
- 1: Task might fit
- 0: Task definitely doesn't fit

**QuickWinBonus:**

- 1: Contains <2min marker
- 0: No marker

## Context Detection Hints

Look for patterns in task names:

- `@home` or `@house` → Home context
- `@office` or `@work` → Office context
- `@phone` or `@call` → Can do anywhere
- `@computer` or `@laptop` → Needs computer
- `@errand` or `@out` → Mobile/out context
- `<2min` or `quick` → Quick win

## Output Format

Keep it scannable and actionable:

```text
🎯 FOCUS SUGGESTIONS

Context: 🏠 Home | 🪫 Low Energy | ⏱️ 15 min

Top Picks:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- ⚡ Reply to Alex's text
   Quick win, low effort
   📍 Personal > ☑️ Next (Personal)

- 📺 Watch training video
   Passive, good for low energy
   📍 Work > ☑️ Next (Work)

- 📝 Review grocery list
   Simple planning task
   📍 Personal > ☑️ Next (Personal)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

⏰ No calendar constraints for next 2 hours

What would you like to work on?
```
