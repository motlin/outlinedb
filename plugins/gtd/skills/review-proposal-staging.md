---
description: The prep-to-apply staging contract for daily-review tasks, including proposal and briefing schemas and the shared confirmation routine. Scheduling belongs to the DAG executor.
globs: ${CLAUDE_PLUGIN_ROOT}/commands/**
---

# Review Proposal Staging

The daily review's Phase 0 DAG (`${CLAUDE_PLUGIN_ROOT}/skills/dag-llm-tasks.md`) splits each interactive task into an autonomous **prep** half that fans out in parallel and an interactive **apply** half walked in fixed presentation order. The two halves never share memory — prep runs in a subagent, apply runs on the main thread later. They communicate **only through staged files on disk**. This skill is the on-disk contract: the directory layout, the schemas, and the shared apply routine. It is referenced by `dag-llm-tasks.md`, `commands/review/daily.md`, and the `refine-journal` / `refine-exercise` prep/apply commands.

The pattern mirrors the existing journal/capture staging pipeline (`${CLAUDE_PLUGIN_ROOT}/commands/journal.md`, `${CLAUDE_PLUGIN_ROOT}/commands/capture.md`): scanners stage JSON, a central step confirms, an executor applies. The difference here is that **the proposal carries the exact CLI ops to run on Accept**, so the walk applies accepted items verbatim without re-deriving them.

## Choose the presentation surface

For interactive reviews, prefer an existing local web app, then an Artifact, then self-contained static HTML. Choose by whether the page can return the user's decisions without copy-paste, not by page complexity. In this repository use `packages/web` (React and Hono); the ladder is at `https://workflowy.m4.notlin.com/ladder`. Local presentation keeps task content off claude.ai and works where that site is blocked. App actions still write to Workflowy through its API.

When no web app is available, use an Artifact only where claude.ai is reachable and both the page's `db` capability and the agent's `read_db` tool work. An Artifact uploads its content to claude.ai; privacy is the tie-breaker, especially for full work and personal task lists. Fall back to self-contained static HTML when neither two-way surface is available. Read-only reports and dashboards should prefer static HTML: local, offline, and nothing shared. Copyable JSON is a fallback transport for choices made in a page, not a reason to prefer it over a working two-way app.

**Long walks switch surfaces.** When a walk will put more than about 8 questions to the user, stop using `AskUserQuestion` and present all the items on one decision page instead, chosen by the ladder above (local web app, then Artifact, then static HTML). Count the questions the walk would ask, not the items scanned. Walks of 8 or fewer stay in `AskUserQuestion`. The commands that walk items (`skills/due-item-walk.md`, `commands/inbox.md`, `commands/review/daily/meetings.md`) apply this threshold.

Every UI a review depends on must have checked-in source, a reproducible generator/build, and tests. Never hand-build a replacement in a published Artifact. For the ladder, `rebalance-ui.mts` generates the local app link or launcher by default; `vp run --filter @outlinedb/web build` builds the React route. Explicit `--html` generates the tested Queue template for the fallback.

### Decision page

The local web app's generic decision page is the long-walk surface. It renders any staged list of questions at `/decisions/<slug>` one card at a time ("Card 7 of 55"), saves each answer as the user makes it, advances to the next unanswered card, and resumes at the first unanswered card on reload. Because every answer is on disk the moment it is made, `answers <slug>` shows partial progress if the user is interrupted before submitting. Use it in this order:

- Stage `.llm/gtd/review/decisions/<slug>.json` (create the directory first). Shape: `{"slug", "title", "intro"?, "groups": [{"heading", "link"?, "items": [{"id", "title", "body": ["plain text line"], "links": [{"label", "href"}], "options": [{"value", "label", "description"?}], "default": "<option value>" | null}]}]}`. The `slug` must match the file name and `[a-z0-9-]+`; item ids must be unique and must not be `submittedAt`. Body lines render as plain text, never HTML. Put each fact on its own body line; never join facts into one line with " · ", which wraps unreadably on a narrow card. `default` only marks an option as suggested; it is not an answer.
- An item may carry photos as `"images": [{"src": "<path>", "alt": "<text>"}]`; they render above the body lines as thumbnails that open the full image in a new tab. Omit the field (or leave it empty) for an item without photos.
    - Before staging, copy or convert each photo into `.llm/photos/<topic>-<yyyy-mm-dd>/` in the repo (create the directory first). The server reads photos from nowhere else.
    - `src` is the file's path relative to the repo's `.llm/photos/` directory, such as `<topic>-<yyyy-mm-dd>/<file>.jpg`.
    - Only `.jpg`, `.jpeg`, `.png`, `.webp` and `.gif` are allowed. Convert HEIC to JPEG first. An absolute `src`, or one with a `..` segment or another extension, fails the page load.
    - Write a short `alt` that says what the photo shows, so the card reads without it.
- An item may carry videos as `"videos": [{"src": "<path>", "poster": "<image path>"}]`; they render in the same row as playable inline players (a lone video is capped at 60% of the screen height so a portrait clip fits above the options). Omit the field for an item without videos.
    - `src` follows the same `.llm/photos/` rules as images, but only `.mp4`, `.mov`, `.m4v` and `.webm` are allowed. Any other `src`, or a `poster` that is not an allowed image path, fails the page load.
    - `poster` is optional; give it a still frame (extract one with `ffmpeg -ss 1 -i <video> -frames:v 1 <file>.jpg`) when the first frame is blank or misleading.
    - The server streams videos with byte ranges, so the user can seek without the whole file loading first.
- Get the URL from `node plugins/gtd/scripts/decision-page.mts url <slug>` and put it inside the `AskUserQuestion` that tells the user to open the page and answer.
- Wait until the user says they submitted. Do not poll.
- Read the choices with `node plugins/gtd/scripts/decision-page.mts answers <slug>`. It prints `{"<itemId>": {"choice", "note", "answeredAt"}, "submittedAt"}` and exits non-zero when nothing was saved. `choice` is an option value or `null`; `note` is free text that may refine or override the choice.
- Apply each decision exactly as the `AskUserQuestion` path would, including its persistence and verification. Ask about an unanswered item or an unclear note in a follow-up question rather than guessing. The page only records choices; every Workflowy write stays in the skill.

## Directory Layout

```text
.llm/gtd/review/
  proposals/<slug>.json     # one per prep-staged interactive task
  briefings/<slug>.json     # one per Auto task
```

- `<slug>` comes from the prep command after removing a trailing `-prep` or `-auto`. Prep and presentation link through their identical visible task names; the presentation entry inherits the prep slug. `Auto` prep tasks stage a briefing under their inferred slug and have no presentation node.
- Prep that only stages JSON makes **no** Workflowy writes, with two explicit exceptions. `refine-inbox` stages `🔍` suggestion nodes in Workflowy instead of a JSON file, while its name-matched `/gtd:inbox` presentation performs the moves. `birthdays-prep` advances stale next-occurrence fields with guarded `--expect-name` updates before staging its proposal, and reports those mechanical rolls in `autoApplied`; it never applies an interactive proposal during prep.
- Create the directories before staging:

```bash
mkdir -p .llm/gtd/review/proposals .llm/gtd/review/briefings
```

## Proposal Schema

A prep command for an interactive task writes `.llm/gtd/review/proposals/<slug>.json`:

```json
{
	"task": "refine-journal",
	"generatedAt": "2026-06-22T14:03:00-07:00",
	"status": "ready",
	"presentation": "Refine calendar journal",
	"summary": {
		"entriesReviewed": 31,
		"proposalsStaged": 12
	},
	"proposals": [
		{
			"nodeId": "<full-uuid-of-the-entry-node>",
			"header": "Feb 9",
			"before": "Ran 5k with Gary in the morning",
			"after": "🏃 Ran 5k with @FrankWilson in the morning #exercise",
			"changes": [
				{"type": "people", "icon": "👤", "detail": "Gary → @FrankWilson"},
				{"type": "hobby", "icon": "🎮", "detail": "running → #exercise"},
				{"type": "emoji", "icon": "😀", "detail": "add 🏃 prefix"}
			],
			"applyOps": [
				"./bin/run.js node update --id <full-uuid-of-the-entry-node> --name '🏃 Ran 5k with @FrankWilson in the morning #exercise'"
			]
		}
	]
}
```

### Top-level fields

| Field          | Meaning                                                                                                              |
| -------------- | -------------------------------------------------------------------------------------------------------------------- |
| `task`         | Task slug inferred from the prep command. Matches the filename.                                                      |
| `generatedAt`  | ISO-8601 timestamp with offset. Used for idempotency / staleness checks.                                             |
| `status`       | `ready` \| `needs-interactive` \| `empty` \| `error` (see below).                                                    |
| `presentation` | Human label the walk shows while presenting this task.                                                               |
| `summary`      | Free-form object of counts the walk folds into the final summary.                                                    |
| `proposals`    | Ordered array of per-item proposals (empty unless `status: "ready"`).                                                |
| `scannerState` | Optional, top-level (not per-proposal). State a self-tracking scanner persists on apply (see Advance Scanner-State). |

### `status` values

| Status              | Meaning                                                        | Walk behavior                                                                  |
| ------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `ready`             | Prep computed proposals; `proposals[]` is populated.           | Present them (batched).                                                        |
| `needs-interactive` | Task has no separable autonomous phase (graceful degradation). | Run the task **inline** at its presentation slot, as a fully interactive task. |
| `empty`             | Nothing to do (e.g. month already refined; idempotent re-run). | Skip silently; note in summary.                                                |
| `error`             | Prep failed.                                                   | Surface the error; offer to run inline.                                        |

### Per-proposal fields

| Field | Meaning |
| --- | --- |
| `nodeId` | Full UUID of the Workflowy node this proposal mutates. Never a short id (short ids 404 on writes). |
| `header` | Short label for the `AskUserQuestion` header (e.g. the entry date `"Feb 9"`). |
| `before` | **Full** original text. Never truncated. |
| `after` | **Full** proposed text. Never truncated. |
| `changes` | Array of `{ type, icon, detail }` describing each change (see icon table). |
| `ambiguity` | Optional `{ prompt, options[] }` when prep could not decide. Replaces the standard Accept/Reject options for that item. |
| `applyOps` | Array of exact CLI command strings the walk runs **verbatim** on Accept, never re-deriving them. Any `node update --name` op **must** carry `--expect-name '<before>'` (see below). |
| `hints` | Optional array of advisory Clef label hints the prep confirmed, `{label, kind, score, source}`: `label` is `@Name` or `#tag`, `kind` is `person` or `tag`, `score` is the verify-pass probability (0 to 1), `source` is `clef-flash` or `clef`. Copied from `ai suggest-labels --json`. Informational only: the walk may show them as context, but they are never an apply target and never change `applyOps`. Only people hints ship today (`refine-journal-prep`). |
| `chained` | Optional `{ task, before, after, applyOps }` staged when an earlier-presented task also proposes a rewrite of the same node. Its ops are keyed on that task's `after`; apply picks it over the fallback when the node's current name equals `chained.before`. Only `refine-exercise` uses it today (see `${CLAUDE_PLUGIN_ROOT}/commands/refine-exercise-apply.md` → Resolve chained ops). |

#### One id per proposal

`nodeId` is the **only** bare node id a proposal may carry. Every other id belongs inside an `applyOps` string, already bound to its flag (`--parent-id <uuid>`). A second bare id field is read by whoever applies the proposal as a write target, and it is usually the wrong node.

The concrete trap: `refine-inbox` names the `📍 Move to:` child of a `🔍 Refinement` suggestion `moveToNodeId` (see `${CLAUDE_PLUGIN_ROOT}/commands/refine-inbox.md`). That node holds the destination **path as text** — it is not the destination parent, and it is deleted along with its suggestion node during apply. Staging it moves the item under its own suggestion, or 404s once the suggestion is gone. Destinations resolve by path or from `.llm/gtd/metadata/` at apply time, never from a staged id.

Inert per-task fields (counts, labels, `fingerprint`, `inbox`) are fine; only id-shaped fields are barred.

### Change icons

| Icon | Type        | Description                                   |
| ---- | ----------- | --------------------------------------------- |
| 👤   | `people`    | Name → @Name                                  |
| 🎮   | `hobby`     | Activity → #hobby-tag                         |
| 🏷️   | `category`  | Add category tag (e.g. #exercise)             |
| ✏️   | `typo`      | Spelling/grammar fix                          |
| 😀   | `emoji`     | Add emoji prefix                              |
| ⚠️   | `ambiguous` | Needs user input (carry an `ambiguity` block) |

### `applyOps` are authoritative

Prep stages the **exact** commands so the walk never re-computes a refinement (re-deriving in a different context risks divergence). Each op is a complete `node …` invocation with the full UUID and final text already escaped for the shell (entries with apostrophes use `'"'"'` escaping inside the single-quoted `--name`). Writes go through the CLI only — never edit SQLite directly. If a proposal has no `applyOps`, Accept is a no-op (used for confirm-only gates that the apply command handles specially) — **except** any proposal carrying an `ambiguity` block. Present its question and choices even without proposal-level `applyOps`; the chosen option supplies its own ops or determines the command the walk builds (see Batch-present below).

#### Stale-write guard (`--expect-name`) — mandatory on every name update

Prep and apply are separated in time; between them the user (or another task) may edit the node, so the staged `before` can drift from the node's live text. Applying a stale `after` verbatim would then **overwrite the newer text and lose data** (e.g. replacing a long, hand-expanded journal entry with a short refined stub). To make that impossible, **every `node update … --name '<after>'` op MUST also pass `--expect-name '<before>'`** — the exact, fully-escaped `before` string from the proposal:

```bash
./bin/run.js node update --id <full-uuid> --name '<after>' --expect-name '<before>'
```

`--expect-name` makes the CLI refuse the write (non-zero exit, no mutation) unless the node's **current** name equals `<before>`. So a drifted node is a loud, safe no-op instead of silent data loss. The walk treats that refusal as a **stale skip**: do not retry it blind, surface it (`⏭️ skipped <header> — changed since prep`), and leave the item for the next run. When the walk builds an op itself (emoji picker "Other", "Accept with note"), it must likewise append `--expect-name '<before>'`.

## Briefing Schema

An `Auto` task does its autonomous work during fan-out, then stages a briefing fragment instead of a confirmable proposal. It has no presentation entry and never prompts. Write `.llm/gtd/review/briefings/<slug>.json`:

```json
{
	"task": "birthdays",
	"status": "ready",
	"lines": ["🎂 Jane Doe turns 40 on Fri — card mailed, gift TBD", "🎂 No other birthdays in the next 14 days"],
	"autoApplied": ["Created 'Mail birthday card for Jane Doe' under Next Actions"]
}
```

| Field         | Meaning                                                             |
| ------------- | ------------------------------------------------------------------- |
| `task`        | Task slug inferred from the prep command.                           |
| `status`      | `ready` \| `empty` \| `error`.                                      |
| `lines`       | Briefing lines folded verbatim into the final summary.              |
| `autoApplied` | Actions the task already performed autonomously (for transparency). |

## Shared Apply Routine

Every `*-apply` command (`refine-journal-apply`, `refine-exercise-apply`, `email-calendar` apply, …) runs the **same** shape. Factor it here; the apply commands stay thin and only describe their task-specific presentation wording.

### Read the staged proposal

Read `.llm/gtd/review/proposals/<slug>.json` for the command's inferred task slug. Branch on `status`:

- `empty` → return empty without prompting; the DAG executor advances the prep date.
- `needs-interactive` → run the task's interactive logic **inline** (graceful degradation) and return success only after verification.
- `error` → surface the error and return failure; the date stays unchanged.
- `ready` → continue with the batch-present loop below.

### Batch-present via AskUserQuestion

Present `proposals[]` in **batches of up to 4** using `AskUserQuestion` — one question per proposal. Never truncate `before`/`after`.

Check for an `ambiguity` block before comparing `before` and `after` or checking for `applyOps`. Present an ambiguity proposal using `ambiguity.prompt` and `ambiguity.options` rather than a before/after diff. Never skip it as a zero-diff no-op: `before == after` can mean prep is waiting for the user's answer, such as a dictation clarification.

For a proposal without an `ambiguity` block, the question text includes the full `before`, the full `after`, and the `changes[]` rendered as `<icon> <detail>` lines. Use `header` for every question header.

### Everything the user approves goes inside the question

The user reads the `AskUserQuestion` body, not the scrolling console and not the filesystem. So:

- **Never** point at an external artifact to approve in bulk — no "I wrote the 40 proposals to `/tmp/proposals.md`, tell me which to accept", no "accept items 3-17", no console dump followed by "look good?". If it is not in the question body, it was not shown.
- **Never** exceed 4 proposals per `AskUserQuestion` call. More rounds is the correct cost.
- **Always show the resolved `after`**, never a template. An emoji proposal's `after` line renders the actual recommended emoji (`👦 @Alice had a playdate…`), never `<emoji>` or a placeholder — the user is picking between concrete rendered strings, and a placeholder makes the choice unreadable.
- The staged emoji is the **first** option and is labeled as the recommendation; the remaining `ambiguity.options` follow, and `AskUserQuestion` adds "Other" for a custom emoji.

Options per proposal:

- **Accept** — run this proposal's `applyOps` verbatim.
- **Reject** — skip; make no changes.
- **Accept with note** — accept but the user types a modification; apply the user's edited text instead of the staged `after`.

A task may add its own options on top of these; `email-calendar-apply` adds **Reject and delete**, which rejects and then trashes the source email.

If a proposal carries an `ambiguity` block, use its `prompt` as the question and its `options` as the choices **instead of** Accept/Reject. The chosen option determines the final text. Two cases:

- **People (or similar) ambiguity** — the `options` are the candidate resolutions (e.g. `@FrankWilson` / `@EvanMiller` / `Skip`). Each option carries its own `applyOps`, so the chosen option's ops run verbatim (and `Skip` makes no change).
- **Emoji picker** — when the ⚠️ proposal is an emoji proposal (`changes[]` is emoji-only / the entry merely lacks a leading emoji), present `ambiguity.options` as the **4 contextual emoji choices**; `AskUserQuestion` auto-adds "Other" so the user can type a custom emoji. Prep omits `applyOps` for these because the final text depends on the choice (per the no-`applyOps` allowance above), so the walk **prepends** the chosen emoji (or the "Other" free-text) to `before` and builds the command itself:

    ```bash
    ./bin/run.js node update --id <full-uuid> --name '<chosen-emoji> <capitalized-before>'
    ```

    Before building the command, apply `${CLAUDE_PLUGIN_ROOT}/skills/refinement-text-rules.md` to the visible text after the emoji: capitalize the first word (`🚗 Drove home`, not `🚗 drove home`) and clear proper nouns/initialisms (`New York`, `PDF`) while leaving ordinary mid-sentence verbs alone. Escape any apostrophes in the final text with `'"'"'` inside the single-quoted `--name`.

### Apply accepted ops

If a user explains that a flagged phrase is intentional, follow **Remember explanations in the matching reference file** in `${CLAUDE_PLUGIN_ROOT}/skills/refinement-text-rules.md`. Do not treat explanatory free text as replacement node text or an emoji. For a non-people term, ask the explicit vocabulary-save question with the exact proposed entry and destination; keeping the original text and saving vocabulary are separate decisions. Preserve the active presentation policy and record only the rejection in any decline ledger.

After each batch's answers, immediately run the `applyOps` for every Accepted proposal **verbatim** (or the user's edited command for "Accept with note"). Then present the next batch. Applying per-batch (not at the end) keeps the work incremental and crash-safe.

If an op exits non-zero with a `does not match --expect-name` message, the node changed since prep read it (see the Stale-write guard above): count it as a **stale skip**, report it inline (`⏭️ skipped <header> — changed since prep`), and do **not** re-run the op without `--expect-name`. It resurfaces next run against fresh text.

### Advance Scanner-State

If the staged file carries a top-level `scannerState` object, persist it to the task's state node `Metadata > ⚙️ Scanner State > <task>` **after** the accepted ops have been applied — a scanner cursor advances only once the entries it covers exist, so a run that creates nothing (everything rejected, or `status: "empty"`) leaves the state untouched and the work resurfaces next run. Read the JSON child's full UUID (writes 404 on short ids), then overwrite it with the staged state as **compact single-line JSON**: Workflowy treats a newline in `--name` as a node boundary, so a multi-line write shatters the state into sibling children.

```bash
CHILD_ID=$(./bin/run.js node get --path "Metadata,⚙️ Scanner State,<task>" --depth 1 --json --fields children \
  | jq -r '.children[0].id')
NEXT_STATE=$(jq -c '.scannerState' .llm/gtd/review/proposals/<slug>.json)
./bin/run.js node update --id "$CHILD_ID" --name "$NEXT_STATE"
```

The `otter-journal-scanner` state (`{cursor, session_start, last_synced_otid, reached_beginning}`) is the shape this mechanism was modeled on. `otter-journal` is Auto and advances its cursor directly in create mode. This generic step remains for interactive apply tasks that stage top-level `scannerState`.

### Return the apply result

After the last batch and any task-specific state update, return success, empty, skipped, or failure to the DAG executor. The executor owns scheduling and runs the task's precomputed `advance.applyOp` only for success or empty. Task-specific progress such as scanner state still advances during apply, after the accepted operations are verified.

### Idempotency

A re-run after a completed apply reads `status: "empty"` (prep found nothing new) and skips without re-applying. Never apply the same `applyOps` twice.

## Verification

- **Schema shape-check:** run the validator on each staged file before the walk consumes it. It exits non-zero and names the offending proposals on a stray id, a short-id `nodeId`, a `node update --name` op missing `--expect-name` (a `node create` needs no guard), a non-`ready` status carrying proposals, a missing required field, a malformed `hints[]` entry, or an `email-calendar` proposal without a non-null ledger `key` or its source message fields (`account`, `mailbox`, `messageUid`) (see `${CLAUDE_PLUGIN_ROOT}/commands/email-calendar-prep.md`):

    ```bash
    node ${CLAUDE_PLUGIN_ROOT}/scripts/validate-proposal.mts .llm/gtd/review/proposals/<slug>.json
    ```

    A file that fails validation is a prep bug: fix the prep command rather than hand-editing the artifact.

- **Dry-run staging:** a prep `--dry-run` writes the `.json` but makes **zero** `node update`/`node create` calls — only `.llm/gtd/review/` is touched. `birthdays-prep` is the guarded-write exception described above and must stage every roll in `autoApplied`.
- **applyOps fidelity:** the walk runs `applyOps` verbatim; a stubbed-Accept walk over a fixture asserts the exact staged commands ran and the executor received success.
