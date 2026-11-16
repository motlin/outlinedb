---
name: item-refiner
description: |
    Orchestrate end-to-end refinement of one inbox item, given its node ID. Applies the Phase A tagger prompts inline one after another, collects their JSON, applies the Phase B composers in order (destination then text), then writes a single 🔍 Refinement suggestion node as a child of the item. Use to refine an individual inbox item; the /gtd:refine-inbox orchestrator launches one per item.
---

Coordinates all taggers for a single inbox item and writes refinement suggestions to Workflowy.

**Inputs via Prompt:**

- `itemId`: The Workflowy node ID of the inbox item to refine

## Fetch Item Data

First, fetch the item with its children:

> Run `./bin/run.js node get --help` to verify available flags before constructing commands.

```bash
ITEM=$(./bin/run.js node get --id "$ITEM_ID" --depth 3 --json --fields id --fields name --fields note --fields completedAt --fields children 2>/dev/null)
ITEM_NAME=$(echo "$ITEM" | jq -r '.name')
```

## Run Inline, Serialize the CLI

Apply every tagger and composer prompt yourself, in this conversation. Do not launch subagents for them: nested subagents hand back launch acknowledgements that look like results, so refiners wrote nothing or hung for most of an hour waiting on notifications.

- For each prompt: read it, follow its focus and output contract against the `ITEM` you already fetched, and record its JSON. Read `${CLAUDE_PLUGIN_ROOT}/skills/refinement-tagger.md` once up front; its fetch step is already done, so reuse `ITEM` instead of re-fetching per tagger.
- Serialize the CLI: run one CLI call at a time. It holds the SQLite cache lock while it runs, so never issue CLI calls as parallel Bash tool calls, never background them with `&`, and never pipe one CLI call into another. Other refiners may be running beside you; if a call fails on a busy/locked database, wait briefly and retry it once.
- Read-only `jq` over `.llm/gtd/metadata/` files needs no lock and can be batched freely.

## Close-Out Table Check

Before anything else, decide whether the item is a **close-out table**: a list of notes or todos the user already dealt with, each row marked with a status such as `Done`, `Filed` / `Filed today`, or `Jira` / `Tracked in Jira` (often with a ticket key or link). The rows may be the item's children, lines of its note, or an HTML table in its name. Titles like "notes and todos to close" are a strong hint, but the status markers are what count. Such an item is not a new task: each row names an existing open task on a `📌 Tasks (asap)` ladder that should be matched and completed.

When it is one, skip the Already-Done check, Phase A, and Phase B, and instead:

- Read both ladders from their real buckets, the way `${CLAUDE_PLUGIN_ROOT}/commands/review/daily/rebalance.md` does under **Read both ladders**, with depth deep enough to reach tasks inside project groups. Also read the `⏰` due-dates buckets, since a row's task may be dated.
- For each row, find the open task it describes. Match on meaning, not exact text: the row is usually a paraphrase. Prefer a standalone task over a context child (`From:` lines, transcript `📝` notes) with the same text; when only a child matches, match its task. Record no match rather than a weak guess.
- Stage `.llm/gtd/refine-inbox/close-out-<ITEM_ID>.json` (create the directory first):

    ```json
    {
    	"itemId": "<full uuid of the inbox item>",
    	"itemName": "<inbox item name>",
    	"rows": [
    		{
    			"row": "<row text, verbatim>",
    			"status": "Done | Filed today | Tracked in Jira | <marker as written>",
    			"jira": {"key": "ABC-123", "summary": "<ticket title if given>", "url": "<ticket URL if given, else null>"},
    			"match": {
    				"taskId": "<full uuid>",
    				"taskName": "<task name>",
    				"path": "<full path from the root, target title last>",
    				"confidence": "high | medium | low",
    				"why": "<one line: what tied the row to this task>"
    			}
    		}
    	]
    }
    ```

    `jira` is null when the row carries no ticket; `match` is null when no open task fits.

- Write the refinement with only these children, then run the usual verification:

    ```text
    🔍 Refinement
    ├── 📜 Provenance: <scheme>://<id>      <- when known
    ├── 🧾 Close-out: <N> rows, <M> matched to open tasks
    └── 📍 Move to: Close-out table, match and complete
        └── 📊 Confidence: high
    ```

Return `status: "refined"` with `destination.path` `Close-out table, match and complete`. `/gtd:inbox` reads the staged file and walks the rows on a decision page.

## Already-Done Check

Before Phase A, decide whether the item describes a concrete change to a checkable local artifact: a config file (`~/.claude/settings.json`, a dotfile, `~/.config/...`), or a repo (a file, a script, a dependency, a git branch). If it does, inspect the artifact's current state read-only (`cat`, `jq`, `grep`, `git -C <repo> log`) and decide whether the change is already present.

- **Present**: record `alreadyDone: {evidence: "<path>: <what is already there>"}`. Phase B still runs, but the refinement's `📍 Move to:` becomes `Already done, complete it` with `📊 Confidence: high`, a `✅ Evidence:` row carries the evidence, and destination-guesser's path becomes the `🔀 Alternative:` so the user can still file it.
- **Absent, partial, or unreadable**: record nothing and refine normally. Never guess "already done" from memory or from the item's wording; only a read of the artifact counts.

Skip the check for items with nothing local to inspect (errands, calls, emails, web research, Workflowy edits).

## Phase A: Taggers (Inline, In Order)

Apply these seven prompts one after another, each producing one JSON object:

- `project-tagger` (${CLAUDE_PLUGIN_ROOT}/prompts/refinement/project-tagger.md) - Detect/suggest project tags
- `people-tagger` (${CLAUDE_PLUGIN_ROOT}/prompts/refinement/people-tagger.md) - Detect/suggest @Name mentions (see `${CLAUDE_PLUGIN_ROOT}/skills/refinement-text-rules.md`)
- `due-date-detector` (${CLAUDE_PLUGIN_ROOT}/prompts/refinement/due-date-detector.md) - Parse dates and urgency
- `url-linker` (${CLAUDE_PLUGIN_ROOT}/prompts/refinement/url-linker.md) - Extract URLs and provenance
- `context-tagger` (${CLAUDE_PLUGIN_ROOT}/prompts/refinement/context-tagger.md) - Suggest location/mode tags
- `tag-cleaner` (${CLAUDE_PLUGIN_ROOT}/prompts/refinement/tag-cleaner.md) - Classify existing tags: fix typos, propose registering new tags, drop one-off junk
- `agenda-detector` (${CLAUDE_PLUGIN_ROOT}/prompts/refinement/agenda-detector.md) - Detect meeting-discussion topics (still filed as tasks; 📋 Meeting agendas is only an optional mirror)

Keep each tagger's output to its own dimension, as if it could not see the others; reconciliation happens at fan-in (people-tagger's `@mention` wins over agenda-detector's `targetPerson`). A tagger you cannot complete is a refiner failure: report it by tagger name rather than writing a partial refinement.

## Fan-In: Collect Results

Write collected tagger results to temp file for Phase B agents:

```bash
cat > ".llm/gtd/refinement/$ITEM_ID.json" << 'EOF'
{
  "itemId": "<ITEM_ID>",
  "projectTagger": <PROJECT_TAGGER_OUTPUT>,
  "peopleTagger": <PEOPLE_TAGGER_OUTPUT>,
  "dueDateDetector": <DUE_DATE_OUTPUT>,
  "urlLinker": <URL_LINKER_OUTPUT>,
  "contextTagger": <CONTEXT_TAGGER_OUTPUT>,
  "tagCleaner": <TAG_CLEANER_OUTPUT>,
  "agendaDetector": <AGENDA_DETECTOR_OUTPUT>
}
EOF
```

## Phase B: Composers (Sequential)

Phase B composers depend on each other - apply them inline in order, finishing destination-guesser's JSON before starting text-composer. The same serialized-CLI rule applies.

### Apply destination-guesser

Apply destination-guesser and capture its JSON output:

```text
${CLAUDE_PLUGIN_ROOT}/prompts/refinement/destination-guesser.md -> returns JSON with {path, targetId, confidence, reasoning, alternative?}
```

This determines where the item should go based on Phase A tagger results.

**Agenda routing:** An agenda item is still a task; destination-guesser resolves it like any other and never returns 📋 Meeting agendas. Never write a `📍 Move to:` that names 📋 Meeting agendas or a node under it. The `🗣️ Agenda:` row is what lets `/gtd:inbox` offer an optional mirror there.

**Alternative destination:** When destination-guesser returns `alternative`, write its path as a `🔀 Alternative:` row right after `📍 Move to:`. It is what lets `/gtd:inbox` offer **File in both**. Omit the row when there is no `alternative`.

**Delegation flag:** When destination-guesser returns `delegation`, write a `📤 Delegate:` row after `🗣️ Agenda:`. Its value is `<@Name or unknown> -> <delegation.path>`. The row lets `/gtd:inbox` offer **Delegate to @person**. Omit it when there is no `delegation`. Only meeting-derived items carry the flag.

### Update tagger results with destination

After destination-guesser completes, append its output to the tagger results file:

```bash
# Add destination to the tagger results file
jq --argjson dest '<DESTINATION_OUTPUT_JSON>' '. + {destination: $dest}' \
  ".llm/gtd/refinement/$ITEM_ID.json" > ".llm/gtd/refinement/$ITEM_ID-with-dest.json"
```

### Apply text-composer

Now apply text-composer, which reads both Phase A results AND the destination from the updated file:

```text
${CLAUDE_PLUGIN_ROOT}/prompts/refinement/text-composer.md -> returns JSON with {composedText, changes, confidence}
```

**Agenda text:** When `agendaDetector.isAgendaItem` is true, ensure the composed `✏️ Text:` carries `#agenda` and the target `@person` mention so the filed task stays findable by person and tag, and any mirror in 📋 Meeting agendas matches the existing topic shape.

The text-composer reads `.llm/gtd/refinement/$ITEM_ID-with-dest.json` to get both Phase A tagger results and the destination.

## Phase C: Write Refinement to Workflowy

Delete any existing `🔍 Refinement` nodes and create the new one in a **single** Bash tool call:

```bash
ITEM_ID="<actual item id>"

# Delete existing refinement nodes
FRESH_JSON=$(./bin/run.js node get --id "$ITEM_ID" --depth 1 --json --fields id --fields name --fields children 2>/dev/null)
echo "$FRESH_JSON" | jq -r '.children[]? | select(.name | startswith("🔍 Refinement")) | .id' | while read -r OLD_ID; do
  [[ -n "$OLD_ID" ]] && ./bin/run.js node delete --id "$OLD_ID"
done

# Create new refinement node
./bin/run.js node create --parent-id "$ITEM_ID" --json '{
  "name": "🔍 Refinement",
  "children": [
    {"name": "📜 Provenance: <scheme>://<id>"},
    {"name": "➕ Added: [2026-01-05]"},
    {"name": "🏠 Context: <#tags>"},
    {"name": "👤 Person: <@Name>"},
    {"name": "💡 Project: <#tag> (<confidence> confidence)"},
    {"name": "📅 Due: <date>"},
    {"name": "✏️ Typo: #Jira → #jira"},
    {"name": "🏷️ New tag: #onewheel → add to 🎮 Hobbies Registry? (420 nodes)"},
    {"name": "🗑️ Drop tag: #s (one-off, resolves nowhere)"},
    {"name": "⚠️ Invalid @mention: @Bobb"},
    {"name": "🗣️ Agenda: raise with <@Name> #agenda"},
    {"name": "📤 Delegate: <@Name or unknown> -> Work > 📤 Delegate"},
    {"name": "✅ Evidence: <path>: <what is already there>"},
    {"name": "📍 Move to: <full path, or Already done, complete it>", "children": [
      {"name": "📊 Confidence: <high|medium|low>"}
    ]},
    {"name": "🔀 Alternative: <full path of alternative.path>"},
    {"name": "✏️ Text: <composed text with all tags>"}
  ]
}' --position bottom

# Verify exactly one refinement node
VERIFY=$(./bin/run.js node get --id "$ITEM_ID" --depth 1 --json --fields id --fields name --fields children 2>/dev/null)
COUNT=$(echo "$VERIFY" | jq '[.children[]? | select(.name | startswith("🔍 Refinement"))] | length')
echo "Refinement node count: $COUNT"
[[ "$COUNT" -eq 1 ]] && echo "OK" || echo "ERROR: expected 1 refinement node, found $COUNT"
```

Only include children that have actual values from Phase A/B results.

**Never report success without that verification printing `OK`.** The count check is the only proof the refinement landed; returning "refined" on an unverified write makes the orchestrator move on to `/gtd:inbox`, which then finds nothing to file.

**Children Order (inside 🔍 Refinement):**

| Order | Child                | Source                           |
| ----- | -------------------- | -------------------------------- |
| 1     | 📜 Provenance:       | From scanner (capture time)      |
| 2     | ➕ Added:            | From scanner (capture time)      |
| 3     | 🏠 Context:          | context-tagger                   |
| 4     | 👤 Person:           | people-tagger                    |
| 5     | 💡 Project:          | project-tagger                   |
| 6     | 📅 Due:              | due-date-detector                |
| 7     | ✏️ Typo:             | tag-cleaner (per typo)           |
| 7.1   | 🏷️ New tag:          | tag-cleaner (per newTag)         |
| 7.2   | 🗑️ Drop tag:         | tag-cleaner (per junk)           |
| 7.3   | ⚠️ Invalid @mention: | tag-cleaner (per invalidMention) |
| 7.5   | 🗣️ Agenda:           | agenda-detector (mirror offer)   |
| 7.6   | 📤 Delegate:         | destination-guesser (optional)   |
| 7.7   | ✅ Evidence:         | already-done check (optional)    |
| 7.8   | 🧾 Close-out:        | close-out table check (only row) |
| 8     | 📍 Move to:          | destination-guesser              |
| 8.1   | └── 📊 Confidence:   | destination-guesser (sub-bullet) |
| 8.5   | 🔀 Alternative:      | destination-guesser (optional)   |
| 9     | ✏️ Text:             | text-composer                    |

Emit one row per entry in each tag-cleaner array; omit the row entirely when the array is empty. `🏷️ New tag:` and `✏️ Typo:` are **proposals the user approves** — never pre-apply the registry write; item-mover handles accepted typos/drops in the text, and an accepted `🏷️ New tag:` is written to its registry during the `/gtd:inbox` execute phase.

**The 📊 Confidence Node:**

The `📊 Confidence:` node is a **child** of `📍 Move to:`, not a sibling. This associates the confidence with the destination suggestion:

```text
📍 Move to: Personal > ☑️ Next > Work
└── 📊 Confidence: high
```

Write destination-guesser's label verbatim — `high`, `medium`, or `low`, never a number or a percentage. During the execute phase, `/gtd:inbox` reads this sub-bullet: `high` may be auto-accepted, `medium` and `low` are confirmed with the user.

**The ✏️ Text Node:**

The `✏️ Text:` node contains the suggested updated text for the original item (with all tags applied):

```text
✏️ Text: Buy a notebook for @Alex #buy #errands
```

**Move Behavior:**

Original item children are preserved. The item-mover updates the item name from `✏️ Text:`, moves the item to the destination, and deletes the `🔍 Refinement` node.

**Output Format:**

Return a summary JSON for the parent orchestrator:

```json
{
	"itemId": "xxx",
	"itemName": "Call John about project",
	"refinementNodeId": "zzz",
	"suggestionsWritten": 7,
	"status": "refined",
	"destination": {
		"path": "Personal > ☑️ Next > Work",
		"targetId": "abc123",
		"confidence": "high"
	},
	"suggestedText": "Call @John about #project-name #call",
	"provenance": "things3://abc123"
}
```
