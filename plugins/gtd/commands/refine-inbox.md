---
name: refine-inbox
description: GTD inbox refinement — analyze inbox items and write 🔍 Refinement suggestions (destination, tags, people, project, due date, cleaned-up text) as children for review before /gtd:inbox executes the moves. Use when the user wants to refine, triage, or pre-sort their inbox, or refine one specific captured item.
arguments:
    - name: item
      description: Optional ID, shortid, or Workflowy URL of a specific item to refine (default all)
      required: false
    - name: batch-size
      description: Number of item-refiner agents to run in parallel (default 8)
      required: false
---

# GTD Inbox Refinement

This command analyzes inbox items and writes refinement suggestions as children in Workflowy, allowing you to review and edit suggestions before running `/gtd:inbox` to execute moves.

Two phases: **Load** (`inbox-loader` + `metadata-sync` in parallel) → **Refine** (`item-refiner` per item, fan-out with concurrency cap).

## Do not use the built-in task list

Track all progress through `.llm/` files, Workflowy nodes, and inline status updates. Do **not** create Claude Code built-in tasks (`TaskCreate` / `TaskUpdate` / `TodoWrite`) to mirror the phases or per-item work in this command — they clutter the display and are never cleaned up.

(Note: launching **subagents** via the `Agent` tool / `subagent_type` is unrelated to the built-in task list and is expected.)

## Close-out tables

An inbox item that is a table of notes or todos already marked `Done`, `Filed`, or `Jira` is a **close-out table**, not a new task: each row names an open `📌 Tasks (asap)` task to complete. The item-refiner detects it (see **Close-Out Table Check** in `${CLAUDE_PLUGIN_ROOT}/prompts/refinement/item-refiner.md`), matches every row to its open task, stages the matches in `.llm/gtd/refine-inbox/close-out-<itemId>.json`, and writes a refinement whose `📍 Move to:` is `Close-out table, match and complete`.

In either review below, present a close-out item as `'<item name>' → close-out table (<N> rows, <M> matched)` with only **Accept** and **Remove refinement**. Never offer **Change destination** for it and never suggest filing the table as a task. `/gtd:inbox` walks the rows.

## Mode 1: Single Item Refinement (with argument)

When an item ID, shortid, or URL is provided, refine only that specific item.

### Load Metadata

Launch metadata-sync to get projects, people, and contexts for tag matching:

```text
Agent tool:
- subagent_type: "general-purpose"
  model: "sonnet"
  prompt: "CLAUDE_PLUGIN_ROOT=${CLAUDE_PLUGIN_ROOT}. Read ${CLAUDE_PLUGIN_ROOT}/prompts/shared/metadata-sync.md and follow it. Sync GTD metadata to .llm/gtd/metadata/"
```

### Launch Single Refiner

Launch the item-refiner for the single item by ID:

```text
Agent tool:
- subagent_type: "general-purpose"
  model: "sonnet"
  prompt: "CLAUDE_PLUGIN_ROOT=${CLAUDE_PLUGIN_ROOT}. Read ${CLAUDE_PLUGIN_ROOT}/prompts/refinement/item-refiner.md and follow it. Refine item $ITEM_ID"
```

### Review Suggestion

After refinement completes, fetch the item to see the written suggestion:

> Run `./bin/run.js node get --help` to verify available flags before constructing commands.

```bash
./bin/run.js node get --id $ITEM_ID --depth 2 --json --fields id,name,note,children
```

Parse the `🔍 Refinement` child to extract:

- `refinementNodeId` - ID of the `🔍 Refinement` node
- `moveToNodeId` - ID of the `📍 Move to:` child. This node holds the destination **path as text**; it is not the destination parent. Use it only to rewrite the suggestion (`node update --name "📍 Move to: …"`), never as a `node move --parent-id` target, and never stage it in a proposals JSON — see the one-id rule in `${CLAUDE_PLUGIN_ROOT}/skills/review-proposal-staging.md`.
- `destination` - path from `📍 Move to:` child (text after the prefix)
- `confidence` - from `📊 Confidence:` sub-child
- `suggestedText` - from `✏️ Text:` child

Present for review, showing `<destination>` and every destination option as the full path from the root with the target title last, never elided (`${CLAUDE_PLUGIN_ROOT}/skills/destination-paths.md`):

```text
AskUserQuestion:
  Question: "'<item name>' → <destination> (<confidence> confidence)\nText: '<suggestedText>'"
  Header: "Review"
  Options:
  - "Accept" - keep suggestion as-is
  - "Change destination" - pick a different destination
  - "Remove refinement" - delete suggestion, keep item in inbox
```

**Handle response:**

- **Accept**: No changes needed.
- **Change destination**: Ask where it should go:

    ```text
    AskUserQuestion:
      Question: "Where should '<item name>' go?"
      Header: "Destination"
      Options:
      - "☑️ Next Actions"
      - "📅 Calendar / Tickler"
      - "📚 Reference"
    ```

    User can type a specific path via "Other" (e.g., "Personal > ☑️ Next > Work"). Apply correction:

    ```bash
    ./bin/run.js node update --id <moveToNodeId> --name "📍 Move to: <new destination>"
    ```

- **Remove refinement**: Delete the `🔍 Refinement` node:

    ```bash
    ./bin/run.js node delete --id <refinementNodeId>
    ```

### Report and Exit

After review, report:

```text
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REFINEMENT COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Refined 1 item: "<item name>"
Run /gtd:inbox to execute moves.
```

Exit - do NOT continue to synthesis or execution phases.

## Mode 2: Bulk Inbox Refinement (no argument)

When no argument is provided, refine all items in all inboxes.

### Load Data (Phase 1 - Parallel)

Launch both loader agents in parallel using the Agent tool:

```text
Agent tool calls (parallel):
- subagent_type: "general-purpose"
  model: "sonnet"
  prompt: "CLAUDE_PLUGIN_ROOT=${CLAUDE_PLUGIN_ROOT}. Read ${CLAUDE_PLUGIN_ROOT}/prompts/refinement/inbox-loader.md and follow it. Load all inbox items from Workflowy and cache to .llm/gtd-inboxes.json"

- subagent_type: "general-purpose"
  model: "sonnet"
  prompt: "CLAUDE_PLUGIN_ROOT=${CLAUDE_PLUGIN_ROOT}. Read ${CLAUDE_PLUGIN_ROOT}/prompts/shared/metadata-sync.md and follow it. Sync GTD metadata to .llm/gtd/metadata/"
```

Wait for both to complete.

**Check for Inbox Zero:**

```bash
ITEM_COUNT=$(jq '[.inboxes[].items | length] | add' .llm/gtd-inboxes.json)
```

If `ITEM_COUNT` is 0 or null, report "Inbox Zero - nothing to refine!" and exit.

### Refine Items (Phase 2 - Parallel)

Launch `item-refiner` agents in parallel, keeping 8 running at all times to avoid overwhelming the system.

**Concurrency limit:** Use `--batch-size` argument if provided, otherwise default to 8.

**Read item IDs (skip already-refined items):**

```bash
# Get item IDs, excluding items that already have a 🔍 Refinement child
jq -r '.inboxes[].items[] | select(.children == null or (.children | map(select(.name | test("🔍 Refinement"))) | length == 0)) | .id' .llm/gtd-inboxes.json
```

**Launch refiners with concurrency control:**

Maintain BATCH_SIZE concurrent `item-refiner` Agent calls; launch the next item as each finishes until the list is exhausted. One agent refines one item.

A refiner's hand-back is not proof it wrote anything. After the refiners finish, fetch each item and confirm it has exactly one `🔍 Refinement` child. Re-launch the refiner once for any item that has none; if it still has none, report that item by name as a failure rather than counting it refined.

```text
For each item ID, launch Agent tool:
- subagent_type: "general-purpose"
  model: "sonnet"
  prompt: "CLAUDE_PLUGIN_ROOT=${CLAUDE_PLUGIN_ROOT}. Read ${CLAUDE_PLUGIN_ROOT}/prompts/refinement/item-refiner.md and follow it. Refine item <ITEM_ID>"
```

**Refinement structure (preserves original children):**

```text
Call John about project
├── <original child 1>           <- preserved
├── <original child 2>           <- preserved
└── 🔍 Refinement                <- new aggregate node
    ├── 📜 Provenance: user://input
    ├── ➕ Added: <time ...>Mon, Jan 5, 2026</time>
    ├── 🏠 Context: #home #call
    ├── 👤 Person: @JohnSmith (found "John")
    ├── 💡 Project: #home-renovation (high confidence)
    ├── 📅 Due: Fri, Jan 3, 2025
    ├── 📍 Move to: Personal > ☑️ Next > Work
    │   └── 📊 Confidence: high
    └── ✏️ Text: Call @JohnSmith about #home-renovation #call
```

### Review Suggestions (Phase 3 - Interactive)

After all refiners complete, reload inbox data to see written suggestions:

```text
Agent tool:
- subagent_type: "general-purpose"
  model: "sonnet"
  prompt: "CLAUDE_PLUGIN_ROOT=${CLAUDE_PLUGIN_ROOT}. Read ${CLAUDE_PLUGIN_ROOT}/prompts/refinement/inbox-loader.md and follow it. Load all inbox items from Workflowy and cache to .llm/gtd-inboxes.json"
```

**Parse refined items:**

Extract items with `🔍 Refinement` children. For each, build a review record with:

- `itemId`, `itemName`
- `refinementNodeId` - ID of the `🔍 Refinement` node
- `moveToNodeId` - ID of the `📍 Move to:` child. This node holds the destination **path as text**; it is not the destination parent. Use it only to rewrite the suggestion (`node update --name "📍 Move to: …"`), never as a `node move --parent-id` target, and never stage it in a proposals JSON — see the one-id rule in `${CLAUDE_PLUGIN_ROOT}/skills/review-proposal-staging.md`.
- `destination` - path from `📍 Move to:` child
- `confidence` - from `📊 Confidence:` sub-child
- `suggestedText` - from `✏️ Text:` child

**Present in batches of 4 using AskUserQuestion** (show `<destination>` as the full path from the root, per `${CLAUDE_PLUGIN_ROOT}/skills/destination-paths.md`):

Create one question per item, up to 4 questions per call:

```text
AskUserQuestion (up to 4 questions):

  Question: "'<itemName>' → <destination> (<confidence> confidence)\nText: '<suggestedText>'"
  Header: "Item N/total"
  Options:
  - "Accept" - keep suggestion as-is
  - "Change destination" - pick a different destination
  - "Remove refinement" - delete suggestion, keep in inbox
  - "Accept all remaining" - accept this and skip rest
```

**Processing responses per batch:**

- **Accept**: No changes.
- **Accept all remaining**: Stop reviewing. Accept this item and all unreviewed items.
- **Change destination**: Collect item for destination follow-up after the batch.
- **Remove refinement**: Delete the `🔍 Refinement` node:

    ```bash
    ./bin/run.js node delete --id <refinementNodeId>
    ```

Continue with next batch of 4 until all reviewed or "Accept all remaining" selected.

**Destination follow-ups:**

For each item that needs a destination change, ask:

```text
AskUserQuestion:
  Question: "Where should '<item name>' go?"
  Header: "Destination"
  Options:
  - "☑️ Next Actions"
  - "📅 Calendar / Tickler"
  - "📚 Reference"
```

User can type a specific path via "Other" (e.g., "Personal > ☑️ Next > Work").

Apply correction:

```bash
./bin/run.js node update --id <moveToNodeId> --name "📍 Move to: <new destination>"
```

### Summary and Exit

Print counts (accepted, destinations changed, refinements removed) and `Run /gtd:inbox to execute moves.`

Exit - do NOT continue to synthesis or execution phases.

## Related Commands

- `/gtd:inbox` - Execute moves for refined items (Phases 3-4)
- `/gtd:capture` - Capture new items to inbox from external sources
