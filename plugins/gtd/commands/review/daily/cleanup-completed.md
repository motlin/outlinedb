---
description: Clean up completed items under both ✅ Tasks roots — for each one, un-complete it and move it into the 📅 Calendar on its completion date (the journal), or delete it permanently. Use when the user wants to clear finished tasks out of the next-actions trees or run the cleanup-completed phase of the daily review.
---

# Clean Up Completed Tasks

Completed items linger under `✅ Tasks` in both roots (`Personal > ☑️ Next (Personal)` and `Work > ☑️ Next (Work)`), inside the `⏰` bucket, the `📌` tiers, or loose beside them. Every one is either a record of something done, which belongs in the journal, or noise, which should go. This phase asks which, one item at a time.

## Do not use the built-in task list

Track progress inline and in `.llm/` files. Do not create `TaskCreate` / `TaskUpdate` / `TodoWrite` tasks.

## Safety

- Never act on an item the user has not answered for. No batch default, no auto-delete.
- Delete is permanent, so it is never the promoted answer and never preselected.
- Surface every failed write instead of continuing past it, and never suppress output of a write.
- Resolve every target from the real roots, never from a mirror (see the mirror rule in `file-tasks.md`).

## Collect

Fetch both roots deep enough to reach the tiers, then collect the completed items:

```bash
./bin/run.js node get --path "Personal,☑️ Next (Personal)" --depth 6 --json \
  --fields id,name,completedAt,children > .llm/gtd/review/completed-personal.json
./bin/run.js node get --path "Work,☑️ Next (Work)" --depth 6 --json \
  --fields id,name,completedAt,children > .llm/gtd/review/completed-work.json
node ${CLAUDE_PLUGIN_ROOT}/scripts/collect-completed-tasks.mts \
  Personal=.llm/gtd/review/completed-personal.json \
  Work=.llm/gtd/review/completed-work.json > .llm/gtd/review/completed-rows.json
```

Each row carries `root`, `id`, `name`, `completedAt`, `completedDate` (the local calendar date), `path` (where it sits), and `childCount`. Only the top-most completed item of a subtree is a row; its children travel with it. `📋 Meeting agendas` is outside the `✅ Tasks` wrapper and is never collected.

Silent when there are no rows.

## Walk

Sort the rows by `completedDate`, oldest first, and present only the first 12 this run. The rest wait for later runs, which keep taking the oldest 12 until the backlog is caught up. Each presented row gets one question, with these outcomes:

- **Journal** — promoted when the item records something done that the user would want to remember (an errand, a conversation, a purchase, a filed form). Un-complete it, then move it under the root's `📅 Calendar` date node for `completedDate`.
- **Delete** — permanent removal, for noise (a reminder to self, a duplicate, a trivial check). Confirm before deleting any row with `childCount > 0`.
- **Skip** — leave it completed and untouched; it returns tomorrow.

Show the cleaned item name (markup and due `<time>` stripped), `completedDate`, and `path` in the question. Past a handful of rows, follow the long-walk rule in `daily.md` and use a decision page; the page holds the same 12 rows, never the whole backlog.

## Apply: Journal

Find the date node whose `<time>` element matches `completedDate`. Older days are moved out of the root's `📅 Calendar` into `📅 Calendar > 🗃️ Archive > <year> > <month>`, so look in both places:

```bash
./bin/run.js node get --path "<Personal|Work>,📅 Calendar" --depth 1 --json --fields id,name
./bin/run.js node get --path "<Personal|Work>,📅 Calendar,🗃️ Archive,<YYYY>,<Month>" --depth 1 --json --fields id,name
```

Use the archived day node when it exists. If the date node is missing from both, create it with name `<time startYear="Y" startMonth="M" startDay="D">Ddd, Mmm D, YYYY</time>`: under the archive month node when that month is already archived, otherwise directly under the Calendar node (the date format is described in `plugins/workflowy/skills/workflowy-html.md`). Resolve its full UUID, and reuse it for every later row with the same `completedDate` instead of creating another. Then un-complete before moving, so the journal never holds a completed node:

```bash
./bin/run.js node uncomplete --id <rowId>
./bin/run.js node move --node-id <rowId> --parent-id <dateNodeId> -p bottom
```

If the item still carries a due-date `<time>` element, leave the text alone; the user edits entries in the journal, and the journal scanners treat the entry as past activity. An item with open children keeps them as they are.

## Apply: Delete

```bash
./bin/run.js node delete --id <rowId>
```

## Report

Report counts for journaled, deleted, and skipped, plus how many completed rows were left unpresented for later runs, and list any failure. A failed move after a successful `uncomplete` leaves an incomplete item in the task tree, so retry the move or tell the user that item's name explicitly.

## Standalone use

Run the import barrier (`/gtd:daily-import`) first if the cache may be stale, since a stale cache lists items that were already moved.
