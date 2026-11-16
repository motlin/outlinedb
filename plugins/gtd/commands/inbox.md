---
description: GTD inbox processing — file refined inbox items (those carrying a 🔍 Refinement suggestion) to their GTD destinations via a batched confirm-and-move loop. Run after /gtd:refine-inbox. Use when the user wants to process, clear, or empty their inbox, or reach inbox zero.
---

# GTD Inbox Processing

Process **refined** items from your inbox following GTD principles. This command handles Phases 3-4 (Synthesize + Execute) for items that already have `🔍 Refinement` suggestions.

**Prerequisite**: Run `/gtd:refine-inbox` first to analyze items and write suggestions.

## Do not use the built-in task list

Track all progress through `.llm/` files, Workflowy nodes, and inline status updates. Do **not** create Claude Code built-in tasks (`TaskCreate` / `TaskUpdate` / `TodoWrite`) to mirror the phases or per-item work in this command — they clutter the display and are never cleaned up.

(Note: launching **subagents** via the `Agent` tool / `subagent_type` is unrelated to the built-in task list and is expected.)

## Workflow

### Load Inbox Data

Launch the inbox-loader agent to get current inbox items:

```text
Agent tool:
- subagent_type: "general-purpose"
  model: "sonnet"
  prompt: "CLAUDE_PLUGIN_ROOT=${CLAUDE_PLUGIN_ROOT}. Read ${CLAUDE_PLUGIN_ROOT}/prompts/refinement/inbox-loader.md and follow it. Load all inbox items from Workflowy and cache to .llm/gtd-inboxes.json"
```

Wait for it to complete.

**Check for Inbox Zero:**

```bash
ITEM_COUNT=$(jq '[.inboxes[].items | length] | add' .llm/gtd-inboxes.json)
```

If `ITEM_COUNT` is 0, celebrate "Inbox Zero!" and exit.

If the loader returns `status: "error"` with a `Broken inbox registration` message, stop and show the message: a link under Metadata > 📥 Inboxes points at a missing node, so an inbox would be skipped. Do not process a partial inbox; ask the user to repoint the link and reload.

**Same-title siblings.** Read each inbox's `probableDuplicates` from `.llm/gtd-inboxes.json`. Every group is a probable duplicate: two or more open items in the same inbox with the same visible title. When presenting any item in a group, prefix the question with `Probable duplicate of '<title>' (N copies)` and offer **Delete** as the duplicate's suggested action for every copy after the first. Never delete or merge a copy without the user's answer.

### Partition Items by Refinement Status

Partition inbox items into two groups:

- **Refined**: Items WITH a `🔍 Refinement` child node
- **Unrefined**: Items WITHOUT a `🔍 Refinement` child node

```bash
# Get items with refinement children (refined)
jq -c '[
  .inboxes | to_entries[] |
  .key as $inboxIdx |
  .value.name as $inboxName |
  .value.items | to_entries[] |
  select(.value.children | any(.name | startswith("🔍 Refinement"))) |
  {inboxIndex: $inboxIdx, inboxName: $inboxName, itemIndex: .key, item: .value}
]' .llm/gtd-inboxes.json > .llm/gtd-refined-items.json

# Get items without refinement children (unrefined)
jq -c '[
  .inboxes | to_entries[] |
  .key as $inboxIdx |
  .value.name as $inboxName |
  .value.items | to_entries[] |
  select(.value.children | all(.name | startswith("🔍 Refinement") | not)) |
  {inboxIndex: $inboxIdx, inboxName: $inboxName, itemIndex: .key, item: .value}
]' .llm/gtd-inboxes.json > .llm/gtd-unrefined-items.json

REFINED_COUNT=$(jq 'length' .llm/gtd-refined-items.json)
UNREFINED_COUNT=$(jq 'length' .llm/gtd-unrefined-items.json)
```

If `REFINED_COUNT` is 0:

```text
No refined items found in inbox.
Run /gtd:refine-inbox to analyze items and write suggestions.
```

Exit early.

### Parse Refinement Suggestions

For each refined item, parse the suggestions from child nodes.

**Refinement structure:**

```text
Call John about project
├── <original child 1>           <- preserved
├── <original child 2>           <- preserved
├── 📝 Goal: <point the user made> (12m)   <- transcript notes from a meeting
└── 🔍 Refinement                <- aggregate node
    ├── 📜 Provenance: user://input
    ├── ➕ Added: <time ...>Mon, Jan 5, 2026</time>
    ├── 🏠 Context: #home #call
    ├── 👤 Person: @JohnSmith (found "John")
    ├── 💡 Project: #home-renovation (high confidence)
    ├── 📅 Due: Fri, Jan 3, 2025
    ├── 🗣️ Agenda: raise with @JohnSmith #agenda   <- only on agenda topics
    ├── 📤 Delegate: @JohnSmith -> Work > 📤 Delegate    <- only on meeting-derived handoffs
    ├── 📍 Move to: Personal > ☑️ Next > Work
    │   └── 📊 Confidence: high
    ├── 🔀 Alternative: Personal > 🏗️ Home Renovation   <- optional second home
    └── ✏️ Text: Call @JohnSmith about #home-renovation #call
```

For each item, extract `refinementNodeId`, `destinationPath` (from `📍 Move to:`), `confidence` (from `📊 Confidence:` sub-child), `suggestedText` (from `✏️ Text:`), `provenance` (from `📜 Provenance:`), `alternativePath` (from `🔀 Alternative:`, or null), `evidence` (from `✅ Evidence:`, or null), `isAgenda` (true when a `🗣️ Agenda:` row exists), `delegation` (from `📤 Delegate:`, as `{person, path}` with `person` null for `unknown`, or null when the row is absent), and `notes` (the names of the item's own direct children starting with `📝`, in order, or an empty array). Write the array to `.llm/gtd-parsed-items.json`.

**Handling missing data:**

- No `📍 Move to:` -> Skip item (cannot move without destination)
- No `📊 Confidence:` -> Treat as `low` confidence
- No `✏️ Text:` -> Keep original item text
- No `📜 Provenance:` -> Set to null
- `📍 Move to:` names `📋 Meeting agendas` (id: `meetingAgendasId` from `.llm/gtd/config.json`, asking once and saving it when missing) or a node under it -> an older refinement; replace it with the bottom tier of the Work `📌 Tasks (asap)` ladder (per `${CLAUDE_PLUGIN_ROOT}/skills/asap-tiers.md`) and mark the item `isAgenda`
- `📍 Move to:` names `📄 Drafts` or a node under it -> an older refinement; replace it with the bottom tier of the matching `📌 Tasks (asap)` ladder (Work for a Work `📄 Drafts`, Personal for a Personal one, per `${CLAUDE_PLUGIN_ROOT}/skills/asap-tiers.md`) and append `#drafts` to `suggestedText` when it does not already carry it.
- `🔀 Alternative:` names `📄 Drafts` or a node under it -> an older refinement; set `alternativePath` to null
- `📍 Move to:` is `Close-out table, match and complete` -> a close-out table; take it out of the batch loop and walk it as **Close-out tables** below describes

### Never ask how to file the inbox

**The item count is never grounds to ask.** As soon as the refinement suggestions are parsed, present item 1. Never open with a listing of the proposed moves followed by a presentation-mode question — "How should I file them?", "file all as proposed / walk one at a time / group by destination?", "want me to auto-accept the high-confidence ones?". The batch-of-4 loop below, one `AskUserQuestion` per item, is the only mode.

**Exception: more than about 8 questions.** When the loop would ask more than about 8 questions, present all items on one decision page instead of `AskUserQuestion`. This is a surface switch, not a how-to-file question, so do not ask the user about it. See "Choose the presentation surface" in `${CLAUDE_PLUGIN_ROOT}/skills/review-proposal-staging.md`.

These openers are all banned, however phrased:

- "Here are the 10 proposed moves — file all as proposed, or walk them one at a time?"
- "Most of these are high confidence; should I just apply those and only ask about the rest?"
- "That's a lot of items — want to do Personal now and Work tomorrow?"
- any "that's a lot" / "this is tedious" editorializing about the count.

Printing a one-line count as context for item 1 is fine. Printing a count _and stopping_ is not.

The only correct first move after parsing the refinement suggestions is to present item 1.

### Review & Execute in Batches (Phases 3-4 interleaved)

**Critical pattern: Review 4 items, then immediately execute moves/deletes for those 4 before reviewing the next batch.** This ensures progress is saved even if the session is interrupted. Never accumulate all decisions before executing.

**For each batch of 4 items, use AskUserQuestion:**

Show the suggested destination as its full path from the root (see `${CLAUDE_PLUGIN_ROOT}/skills/destination-paths.md`; no `…` elision, target title last). Present each item with its suggested destination and confidence. Always include these option types:

- **Accept** — move to suggested destination
- **Skip** — leave in inbox for later
- **Delete** — remove from inbox entirely
- The "Other" option (auto-added by AskUserQuestion) lets the user specify a different destination or action

Never offer Someday as an option, and never suggest it when the user picks "Other". An undated future task ("read this in the future", "maybe look into X") is still a task — its destination is the bottom tier of the matching `📌 Tasks (asap)` ladder. When a `📍 Move to:` suggestion names a Someday node, replace it with that bottom tier before presenting the item.

```text
Question: "'Buy groceries' -> ☑️ Next Actions (medium confidence)"

Options:
- "Accept" (☑️ Next Actions)
- "Skip (leave in inbox)"
- "Delete"
```

**Promote a tier.** A refined item bound for a `📌 Tasks (asap)` ladder always lands on its **bottom** tier, and that default stays — but the user regularly moves an item up one rank, so make that a click. Before presenting a batch, read each ladder a batch item is bound for, once per ladder, from the real bucket (never a mirror; resolve it as `${CLAUDE_PLUGIN_ROOT}/commands/review/daily/rebalance.md` does under **Read both ladders**):

```bash
./bin/run.js node get --id <asap-bucket-uuid> --depth 2 --json \
  --fields name,id,shortId,children,completedAt > .llm/gtd/inbox-ladder-<work|personal>.json
node ${CLAUDE_PLUGIN_ROOT}/scripts/asap-tiers.mts choices .llm/gtd/inbox-ladder-<work|personal>.json
```

`choices` prints `filingChoices(readLadder(bucket))`: `bottom` (the Accept tier), `promote` (the tier directly above the bottom, or null on a one-tier ladder), and `summary`, a one-line occupancy readout such as `1st 2/2 · 2nd 3/4 · 3rd 8/8 · 4th 12 (bottom)`. Re-read after each batch executes, since the batch changed the occupancy.

- Put `summary` in the question text of every asap-bound item, so a typed tier ("2nd") is an informed pick.
- Add a **Promote** option labelled with the tier (`3rd tier`) right after Accept (and after File in both when present) whenever `promote` is non-null, with the tier's occupancy in its description — `3rd (8/8)`. A full tier is still a valid choice: filing there never moves any other item, so never warn that something will be bumped and never ask a follow-up to confirm it.
- `AskUserQuestion` allows 4 options. When Do it now, File in both, or Delegate already fills the fourth slot, drop Promote and keep Skip and Delete; the ladder summary in the question still makes "3rd" a two-character answer.
- Any tier the user names (Promote, or "Other" answers like "3rd tier", "2nd", "3rd + mirror to agendas") replaces the suggested tier. Run `planInsertion(ladder, tier)` for a tier other than `promote` to get its `targetId` and any `createTiers`. Filing only inserts the item; it never moves another item out of a full tier. Over-cap tiers are left for the user to fix in `/gtd:review:daily:rebalance`.

```text
Question: "'Renew the car registration #errands' -> 📌 Tasks (asap) > 4th (high confidence) | 1st 2/2 · 2nd 3/4 · 3rd 5/8 · 4th 12 (bottom)"

Options:
- "Accept" (📌 Tasks (asap) > 4th)
- "3rd tier" (📌 Tasks (asap) > 3rd, 5/8)
- "Skip (leave in inbox)"
- "Delete"
```

**Never file an item only into 📋 Meeting agendas.** A topic that lives only there gets lost, because nothing but a meeting ever surfaces it. Every agenda item is filed as a task, on its asap tier or in the due-dates bucket, carrying `#agenda` and the `@person`; that tag is often enough on its own. Never offer `📋 Meeting agendas` as a primary destination.

**File in both.** When the item has an `alternativePath` or is `isAgenda`, add a **File in both** option right after Accept. It files the item at the primary destination exactly as Accept does and then creates a mirror of it at the second destination:

- The second destination is `alternativePath` when one was staged, otherwise (for an agenda item) the Work `📋 Meeting agendas` node (id: `meetingAgendasId` from `.llm/gtd/config.json`, asking once and saving it when missing).
- Name both places in the option description, e.g. `File in both` (`📌 Tasks (asap) > 4th` + mirror in `📋 Meeting agendas`).

```text
Question: "'Ask @Bob about build server permissions #agenda' -> 📌 Tasks (asap) > 4th (high confidence)"

Options:
- "Accept" (📌 Tasks (asap) > 4th)
- "File in both" (📌 Tasks (asap) > 4th + mirror in 📋 Meeting agendas)
- "Skip (leave in inbox)"
- "Delete"
```

Treat these "Other" answers as File in both: naming two destinations ("both 1 and 2", "3rd + mirror to agendas"), or naming `📋 Meeting agendas` for an agenda item. The first-named ladder or due-dates destination is the primary; the other is the mirror. A named tier ("3rd") overrides the suggested tier for the primary.

**Which copy is the original.** The original is always the item itself, moved by item-mover to the primary destination — the asap-ladder or due-dates copy, which the daily review surfaces and ranks. Its children, provenance, and completion state live there. The mirror is a new node at the second destination that points back to the original; completing the task means completing the original.

**Mirror command.** The mirror is a live Workflowy mirror, created with `node mirror`. After item-mover has moved the item, resolve the second destination's ID (the Meeting agendas UUID above, or `./bin/run.js node get --path "<alternativePath segments, comma-separated>" --depth 0 --json --fields id` for an alternative), and mirror the item there:

```bash
./bin/run.js node mirror --node-id <ITEM_ID> --parent-id <SECOND_DESTINATION_ID> --position bottom --json
```

A mirror shows the original's text, tags, and children, so apply `✏️ Text:` to the item before mirroring it and do not edit the mirror. Verify with `./bin/run.js node get --id <mirrorId>` that `mirror.isMirror` is true and the mirror landed under the second destination. To undo a mirror, run `./bin/run.js node mirror --node-id <mirrorId> --delete`, which leaves the original untouched.

**Delegate to @person.** Offer this option only when the item carries a `delegation` from the refiner. The refiner sets it only on meeting-derived handoffs ("Assign X", "Ask X to", "X will"). From a transcript it is unclear whether the handoff already happened in the meeting, and to whom. So the question asks that outright and names the source meeting. Put the option right after Accept:

- Label it with the person (`Delegate to @Bob`), and name the Delegate node in its description. When `person` is null, label it `Delegated in the meeting` and ask for the name via "Other". Resolve any typed name to a canonical `@mention`, following **Unknown people** below.
- Accept keeps its usual meaning: the handoff has not happened yet, so the item is a task for the user.
- On pick, file the item at `delegation.path`, the direct `📤 Delegate` child of that root. item-mover accepts it as a `waitingFor` destination. Keep the `@mention` in the item text so the handoff stays findable by person.

```text
Question: "'Ask @Bob to draft the rollout plan' (from meeting: Weekly sync) -> 📌 Tasks (asap) > 4th (medium confidence). Was this delegated to @Bob in the meeting?"

Options:
- "Accept" (not delegated yet: 📌 Tasks (asap) > 4th)
- "Delegate to @Bob" (delegated in the meeting: Work > 📤 Delegate)
- "Skip (leave in inbox)"
- "Delete"
```

**Transcript notes.** The daily review's meeting walk can file an item with `📝` children holding everything the user said about it in the meeting. When `notes` is non-empty, put a digest of them in the question, after the destination line: one short fragment per note, in order, joined with `·`, tags and `<time>` markup stripped. Keep the labels (`Goal`, `Metric`) so the digest reads as structure. When the notes are too many to fit, show the first several and end with `+N more`. The digest informs the filing decision; the notes themselves move with the item unchanged.

```text
Question: "'Propose monorepo health metrics to @Alice' -> 📌 Tasks (asap) > 4th (high confidence) | Notes: Goal: track build time per team · Metric: flaky-test rate weekly · Open question: who owns the dashboard · +3 more"

Options:
- "Accept" (📌 Tasks (asap) > 4th)
- "Skip (leave in inbox)"
- "Delete"
```

**Do it now.** When an item is something Claude can finish entirely as Workflowy edits through the CLI (rename, move, tag, or complete an existing node; create or restructure nodes; delete a stale node), add a **Do it now** option and list it first, ahead of Accept. Describe the concrete edits in the option description so the user knows what will happen. Do not offer it when the item needs anything outside Workflowy (email, calendar, web, purchases, a phone call) or a decision only the user can make.

```text
Question: "'Rename the 🏗️ Home project to 🏡 House' -> ☑️ Next Actions (high confidence)"

Options:
- "Do it now" (rename node 🏗️ Home -> 🏡 House, then remove this inbox item)
- "Accept" (☑️ Next Actions)
- "Skip (leave in inbox)"
- "Delete"
```

When the user picks Do it now, perform the edits immediately through the CLI, never by writing SQLite. Verify each edited node with `./bin/run.js node get --id <nodeId>`. Then delete the inbox item with `./bin/run.js node delete --id <itemId>`. If any edit fails, leave the inbox item in place and report the failure. Count these as "done" in the running total.

**Already done.** When `destinationPath` is `Already done, complete it`, the refiner read a local config file or repo and found the change already present. Put the `✅ Evidence:` row in the question and list **Complete it** first, ahead of Accept; Accept files it at `alternativePath` when one exists, otherwise drop Accept. When chosen, delete the `🔍 Refinement` node, run `./bin/run.js node complete --id <itemId>`, and verify with `node get`. Count these as "done" in the running total.

```text
Question: "'Allow the gh command in Claude settings' -> Already done (high confidence) | ~/.claude/settings.json: permissions.allow has Bash(gh:*)"

Options:
- "Complete it" (already present; mark this inbox item complete)
- "Accept" (📌 Tasks (asap) > 4th)
- "Skip (leave in inbox)"
- "Delete"
```

**Close-out tables.** An item whose `destinationPath` is `Close-out table, match and complete` is a table of notes already marked Done, Filed, or Jira, and each row names an open ladder task to complete. Never file the table itself as a task. Walk each close-out item before item 1 of the batch loop, on its own decision page whatever its row count:

- Read the matches the refiner staged in `.llm/gtd/refine-inbox/close-out-<itemId>.json` (schema in **Close-Out Table Check**, `${CLAUDE_PLUGIN_ROOT}/prompts/refinement/item-refiner.md`). When the file is missing, run that check yourself against the item to rebuild it.
- Stage the page per **Decision page** in `${CLAUDE_PLUGIN_ROOT}/skills/review-proposal-staging.md`, slug `close-notes-<yyyy-mm-dd>`, one card per row, id `row-<n>`, titled with the row text. Body lines, one fact each: `Close as: <status>`, `Jira: <key> <summary>` when there is a ticket, `Match (<tier or path>, <confidence>): <task name>`, and `Why: <why>`. Link the matched task (`https://workflowy.com/#/<last 12 hex of taskId>`) and the Jira ticket when it has a URL.
- A matched row's options are **Complete it** (`complete`, description naming the Jira key when there is one) and **Keep open** (`keep`), default `complete` for a `high` match and `keep` otherwise. An unmatched row says `No open task matched` in its body and offers **Nothing to close** (`none`); the user names the right task in the card's note.
- Apply each answer:
    - `complete`: when the row has a Jira ticket, first add it to the task as a child, `./bin/run.js node create --parent-id <taskId> --name '🎫 Jira: <a href="<url>"><key></a> <summary>' --position bottom` (plain `<key> <summary>` without a URL), so the link travels with the task into the journal. Then `./bin/run.js node complete --id <taskId>` and verify with `node get` that `completedAt` is set. A task already completed or deleted since refinement is a stale skip: report it, do not re-match it blind.
    - `keep` or `none`: no change. A note that names a task (a link, short id, or title) replaces the match: resolve it, confirm it in a follow-up question, then apply `complete` to it.
- Once every row is answered and applied, delete the `🔍 Refinement` node and then the inbox item with `./bin/run.js node delete --id <itemId>`, and remove the staged `close-out-<itemId>.json`. With rows still unanswered, leave the item in the inbox. Count each completed task as "done" in the running total.

**Unknown people.** Show each `⚠️ Invalid @mention:` row, and any name the people-tagger could not resolve, inside the item's question. When the user answers with a real identity ("yes Carol Smith, Acme"), ask one follow-up `AskUserQuestion` offering to add that person to `Metadata > 👥 People`, per "Adding a newly named person" in `${CLAUDE_PLUGIN_ROOT}/skills/people-metadata.md`. Create the entry before the batch executes, then file the item with the canonical `@mention` in place of the invalid one; any filing detail in the same answer ("3rd tier") still overrides the suggested destination.

**After each batch of 4 reviews, execute immediately:**

- **Do it now**: Already performed when chosen (see above); nothing left to execute
- **Complete it**: Already performed when chosen (see above); nothing left to execute
- **Deletes**: Run `./bin/run.js node delete --id <itemId>` directly
- **Moves**: Launch item-mover agent with the batch's confirmed moves
- **Promotions** (Promote or a named tier): include the item in the batch's moves with the promoted tier as its destination
- **Delegate**: Include the item in the batch's moves with `delegation.path` as its destination and the confirmed `@mention` in its text
- **File in both**: Include the item in the batch's moves to its primary destination, then mirror it into the second destination with `node mirror` once item-mover returns
- **Skips**: Do nothing (item stays in inbox)
- **User-specified overrides**: Use the user's custom destination path instead of the suggestion

For moves, item-mover handles:

- Updating the item's text from `✏️ Text:` (if different from original)
- Deleting the `🔍 Refinement` aggregate node (cleanup)
- Moving the original item (with all its children) to the destination

**Build confirmed moves for each batch:**

```json
[
	{
		"itemId": "xxx",
		"refinementNodeId": "zzz",
		"suggestedText": "Call @JohnSmith about #project-name #call",
		"destinationPath": "Personal > ☑️ Next > Work",
		"provenance": "things3://DJHa8FkpUnPSwBSKVZMWqw"
	}
]
```

**Launch item-mover agent per batch:**

```text
Agent tool:
- subagent_type: "general-purpose"
  model: "sonnet"
  prompt: |
    CLAUDE_PLUGIN_ROOT=${CLAUDE_PLUGIN_ROOT}. Read ${CLAUDE_PLUGIN_ROOT}/prompts/refinement/item-mover.md and follow it.
    Execute confirmed moves:
    <JSON array of confirmed moves for this batch>
```

**Running total**: After each batch, show a running summary:

```text
Batch 3 complete: 1 done, 1 moved, 1 deleted, 1 skipped (12/73 processed)
```

### Summary & Report

After `item-mover` completes, print:

- Processed counts grouped by destination, plus people added to the roster and projects created.
- Unrefined items by name with a `Run /gtd:refine-inbox` hint, or `Inbox Zero achieved!` if none.

**Log to Session Memory:**

> Run `./bin/run.js node create --help` to verify available flags before constructing commands.

```bash
TODAY=$(date +%Y-%m-%d)

# Log under today's date node, creating it if missing (--create-path is idempotent)
./bin/run.js node create --parent-path "Metadata,🧠 Session Memory,$TODAY" \
  --name "Inbox processed: 5 items moved" --create-path --position bottom
```

If inbox reached zero, log clearing:

```bash
TODAY=$(date +%Y-%m-%d)
./bin/run.js node create --parent-path "Metadata,🧠 Session Memory,$TODAY" \
  --name "inbox-cleared: Personal 📥 Inbox" --create-path --position bottom
```

## Related Commands

- `/gtd:refine-inbox` - Analyze items and write refinement suggestions (Phases 1-2)
- `/gtd:capture` - Capture new items to inbox from external sources
