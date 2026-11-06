---
description: Walk everything dated that needs handling today — overdue recurring review items in Personal > 🔄 Review, then one-shot due tasks from the Workflowy ⏰ buckets, Things 3, and Apple Reminders. Use when the user wants to run their recurring review, clear overdue items, or do the recurring portion of the daily review.
---

# Recurring Review

Two segments, walked back to back as one continuous question sequence:

- **Segment 1 — recurring items.** Items in `Personal > 🔄 Review` that come back on an interval. Handling one advances its date by its section's cadence.
- **Segment 2 — due items.** One-shot tasks that should be done once and go away, merged from the Workflowy `⏰ Tasks (due dates)` buckets, Things 3, and Apple Reminders. Handling one completes, reschedules, moves it to Workflowy, or drops it.

Both segments follow `${CLAUDE_PLUGIN_ROOT}/skills/due-item-walk.md` — presentation, showing each item's real context immediately before its question, the banned scoping questions, freeform handling, read-before-write, and the background dispatch protocol all live there. Read it before starting. Ask about one task per question, never two unrelated tasks together; one `AskUserQuestion` call may carry up to 4 questions, and only copies of the same task may share a question. The segments stay separate because their write-backs differ: a recurring item normally returns, while a one-shot task should not.

## Do not use the built-in task list

Track all progress through `.llm/` files, Workflowy nodes, and inline status updates. Do **not** create Claude Code built-in tasks (`TaskCreate` / `TaskUpdate` / `TodoWrite`) to mirror the per-item work in this command — they clutter the display and are never cleaned up.

(Note: launching **subagents** via the `Agent` tool / `subagent_type` is unrelated to the built-in task list and is expected.)

---

## Fetch every source before the first question

Both segments' sources are fetched here, in one front-loaded batch, before Segment 1 asks anything. They have no data dependencies on each other or on the walk, and one of them can halt the review: the Apple Reminders fetch goes through iMCP, and an iMCP outage discovered at walk time lands after hours of interactive Segment 1 work instead of before it. The helper can answer all morning and then die as Segment 2 starts, taking the run down at its last step. Fetching up front moves that halt to the cheapest possible moment. Launch the `reminders-fetcher` Agent call and the Bash fetches below concurrently in a **single assistant message**, then wait for all of them before computing anything.

**Apple Reminders** — launch `reminders-fetcher` as a `general-purpose` subagent (`model: "sonnet"`) whose prompt starts `CLAUDE_PLUGIN_ROOT=${CLAUDE_PLUGIN_ROOT}. Read ${CLAUDE_PLUGIN_ROOT}/prompts/fetchers/reminders-fetcher.md and follow it.` Save its JSON to `.llm/gtd/review/due-reminders.json`. If the fetcher returns `status: "imcp-unavailable"`, stop the review here per the halt rule in `${CLAUDE_PLUGIN_ROOT}/skills/imcp-recovery.md`. Nothing has been walked yet, so reconnecting and re-running costs the user nothing. When this command runs standalone rather than from `/gtd:review:daily`, run the **iMCP self-heal preflight** from `daily/overview.md` first so a stale helper is restarted before the fetch instead of dying partway through it.

**Review tree** (Segment 1):

```bash
mkdir -p .llm/gtd/review
./bin/run.js node get --path "Personal,🔄 Review" --depth 4 --json \
  --fields id,shortId,name,note,modifiedAt,priority,completedAt,mirror,children > .llm/gtd/review/tree.json
```

**Workflowy Next-Actions roots** (Segment 2) — resolve both roots from the metadata anchor, then dump each deep enough to reach the tasks:

```bash
./bin/run.js node get --id "$(jq -r .nextActionsId .llm/gtd/config.json)" --depth 1 --json \
  --fields name,shortId,id,children,linkTargets > .llm/gtd/review/next-actions-meta.json
```

Read `linkTargets[0].id` for each child to get each root's full UUID, then for each root:

```bash
./bin/run.js node get --id <rootUuid> --depth 5 --json \
  --fields id,shortId,name,note,modifiedAt,completedAt,priority,children > .llm/gtd/review/root-<work|personal>.json
```

Combine them into the collector's input shape — an array of `{rootKey, root}` — at `.llm/gtd/review/due-workflowy.json`.

**Things 3** (Segment 2):

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/fetch-things-due.mts > .llm/gtd/review/due-things.json
```

**Re-fetch the Workflowy sources after any data import** (`just daily`, `cache import-api`, a Segment 1 `#llm-task` that imports) — re-run the review-tree and Next-Actions fetches above to overwrite `tree.json` and `due-workflowy.json`, then recompute `overdue.json` and `due-items.json`. Stale data causes wrong "overdue by N days" math and already-resolved prompts. Things and Reminders are untouched by a Workflowy import and are **not** re-fetched: a reminder the user sets during Segment 1 through the **Set a reminder** outcome is an alarm for later today, not a due item for Segment 2 to walk.

---

## Resume from prior-run artifacts, never rebuild them

An item that was skipped, or that ended a previous run as **continued work** with no "done" ever given, usually comes back with its inputs already sitting on disk. The previous attempt fetched, exported, or computed something into `.llm/gtd/review/` before it stopped, and re-deriving that from scratch is the slowest possible way to pick the item back up.

So before doing any work on a row that a previous run already saw — `skipStreak >= 1`, or `overdueByDays > 0` on an item whose handling produces files (an `#llm-task`, an inventory, an export, an analysis) — look for what that run left behind, in this order:

- **Paths the item names.** An `#llm-task`'s child instructions usually say where output goes; check those paths first, exactly as written.
- **Files that match the item.** Search the review directory by the item's keywords and by recency, and read the first lines of anything that matches to confirm it belongs to this item and not a same-named sibling:

    ```bash
    ls -lt .llm/gtd/review/ | head -40
    ls -lt .llm/gtd/review/ | grep -i '<keyword from the title>'
    ```

- **The mid-run notes.** `.llm/gtd/review/mid-run-notes.md` may record how far the previous attempt got and what it was about to do next.

Then surface what you found **inside the question**, not only in the terminal: name each artifact with its date and size, say what it contains, and make the first option resume from it — "Continue from `inventory-drives-2026-09-05.csv` (71 rows)" — with the rebuild as a separate, unpromoted option for when the user says the data is stale. The context block already carries the item's children and note; the prior-run artifacts are one more line in that block and one more sentence in the `AskUserQuestion` body, because only the question text survives into the next session.

Two rules follow from this:

- **Do not re-run a fetch or export whose output already exists from a prior run** unless the user asks for a fresh one — a day-old file is still the cheaper starting point.
- **When you produce an artifact for an item that is not finished this run, name it after the item** (`inventory-drives-2026-09-05.csv`, not `out.csv`) and mention it in the mid-run notes, so the next run's search above finds it without guessing.

Finding nothing is a real answer and ends the search; say so in one line and build the inputs. Never assume the artifacts are gone because the item looks unfamiliar.

---

## Segment 1 — Recurring items

## Identify Overdue Items

Run the date math in a script — never re-derive it by hand. `compute-overdue.mts` parses each leaf item's `<time>`, finds the items due on or before today, orders them, and stages the exact `node update` that advances each one to today + its section's interval:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/compute-overdue.mts .llm/gtd/review/tree.json > .llm/gtd/review/overdue.json
```

The fetch must include `completedAt`: a finished recurring item keeps its stale `<time>`, and without that field the walk asks the user about work they already did (10 of 51 rows in one run). `compute-overdue.mts` drops completed items, but only if the field reaches it.

`overdue.json` is an ordered array (by section priority, then due date) where each row carries `section`, `shortId`, `id`, `name`, `due`, `overdueByDays`, `isLlmTask`, `missingLlmTag`, `nextDate`, `newName`, `applyOp` (the verbatim `node update` to run on "done"), `skipStreak` / `skippedSince` folded from the skip log, and `lengthen` (the staged move to the next longer cadence). It also carries the context each question needs — `url`, `note`, `modifiedAt`, `childCount`, `children` (title, note, own child count, url), and `links` (every http(s) URL in the item's name and note) — which is why the fetch above asks for `note,modifiedAt` at depth 4. Show it per **Show the item, do not just name it** in the walk skill. The script already skips `🗃️ Routine Archive`, completed items, **mirror nodes and their whole subtree**, and future-dated items; compares dates as ISO strings (avoiding the `new Date()` UTC-vs-local footgun); and clamps month rollovers (Jan 31 + 1 month → Feb 28). Pass `--print` instead of redirecting for a human-readable dump while debugging.

The fetch must ask for `mirror`, and the reason is not cosmetic. `Set goals for today` carries **mirrors of the four task buckets** as its children, so a walk that cannot see `mirror.isMirror` descends straight through them and reports one-shot `⏰ Tasks (due dates)` tasks as overdue **recurring** items. Those tasks are correctly filed; they are merely reflected. Acting on that misreading means stripping real due dates off real tasks. `compute-overdue.mts` skips any node whose `mirror.isMirror` is true along with everything beneath it, but only when the field reaches it.

Never file a task by moving it onto a mirror either: `node move --parent-id <mirror-uuid>` parents the node **under the mirror**, not under the node the mirror reflects, which drops a real one-shot task inside the recurring tree. Resolve destination buckets from the Next-Actions roots (`linkTargets[0].id`) and confirm `mirror.isMirror` is false before writing.

## A mirror row is never a misfiled recurring item

A `tree.json` fetched without `mirror`, a stale one from an earlier run, or a node pulled by hand mid-walk can still put a reflection in front of you. So check `mirror.isMirror` on the node before acting on any Segment 1 row that looks like a one-shot task, per **A mirror is a view of a task that lives elsewhere** in the walk skill.

A mirror whose original sits under `⏰ Tasks (due dates)` or `📌 Tasks (asap)` is a Next Action being reflected into the recurring tree, not a task that was filed in the wrong place. Present it read-only or skip it — **Segment 2 walks the original**, a few minutes later in this same run. Never strip its `<time>`, never advance a date on it, and never move the original out of its bucket.

**"This looks one-shot" is not grounds to re-file anything from inside Segment 1.** Advancing recurring dates is the whole of this segment's write authority. A row that reads like a one-shot task is one of three things, and none of them is a move to make here:

- a **mirror** of a task already correctly filed in a bucket — leave it alone; Segment 2 walks the original.
- a genuine one-shot sitting in `Personal > 🔄 Review` — a data defect. Say so and ask the user; filing loose tasks into the `⏰` and `📌` buckets is the `/gtd:review:daily:file-tasks` phase's job, not this walk's.
- a recurring item whose text merely reads like a one-shot — advance its date and move on.

Moving a node out of the recurring tree mid-walk is how correctly filed work goes missing, so the answer to "this does not look recurring" is a question to the user, never a `node move`.

The script assumes the canonical shape: section headers carry no date, intermediate groups carry no date, and the `<time>` lives on the **leaf item**. **If the data doesn't match — a `<time>` on an intermediate group, or a "leaf" whose children each carry their own date — stop and ask the user to fix the data in Workflowy** rather than reinterpreting it here.

A row with `needsInterval: true` (section `Every few years` or an unrecognized section) has `nextDate`/`applyOp` set to `null` — ask the user for the interval and build the date write per `${CLAUDE_PLUGIN_ROOT}/skills/review-date-updates.md`.

Walk `overdue.json` in array order — it is already sorted by section priority and then due date.

## Section Interval Mapping

The section → interval table lives in `compute-overdue.mts` (the executable source of truth) and is mirrored for reference in `${CLAUDE_PLUGIN_ROOT}/skills/review-date-updates.md`, which also documents the `<time>` element format and the CLI update commands.

## Hard external deadlines

For a row with non-null `hardDeadline`, show **Hard deadline: `hardDeadline.date` · Review by: `due` (`hardDeadline.leadDays` days early)** before asking. Also show the next actual deadline (`hardDeadline.nextDate`) and next review date (`nextDate`) when confirming completion. The item's `<time>` stores the actual deadline; the planner subtracts the lead time for inclusion in this walk and advances the external cadence from that deadline. Run `applyOp` verbatim only for the completed occurrence. If the next occurrence is already overdue, keep it visible instead of silently skipping cycles.

Promote **Done** and **Set a reminder**. Omit **Skip**, **Push it out**, and **Less often** from the offered outcomes, regardless of skip streak. Never use the generic `lengthen: null` fallback for a hard deadline. If the user explicitly asks to postpone, skip, retire, or change cadence, warn first: name the actual deadline, review date, requested date, and how much lead time is lost or whether the deadline will be missed. Obtain explicit confirmation of that consequence before applying the request. Postponing a reminder does not change the external deadline. Change that deadline only when the user confirms the external deadline itself changed; keep its marker and lead time intact.

## Weekday-anchored cadence

A recurring item with a `Next: <Weekday>` child (e.g. `Next: Saturday`) always comes back on that weekday. The planner reports it as `weekday` and lands `nextDate`, `applyOp`, and `lengthen.nextDate` on the first matching weekday within the week ending at the section's plain interval date, never on or before today: a weekly item done Wednesday returns that Saturday, a daily item rolls forward to the next Saturday. When the user says "advance to the next weekend, now and every time", add the marker as a child with `node create` instead of hand-editing one date. The marker cannot combine with `Hard deadline:`; the planner rejects malformed or duplicate markers.

## Recurring item options

When the item's action spans a list such as Things Today, an inbox, or a folder, follow **Walk a recurring item's list entry by entry** in the shared walk skill before offering the parent's Done. Enumerate the entries and ask about each separately with its context and `entry N/M`; never offer one bulk outcome for the list. Keep the parent in progress until every entry has a recorded decision and its writes are verified, then obtain the parent's Done confirmation and run its staged `applyOp` once. Keep unresolved work resumable without advancing the parent's date. The waiting, duplicate, and hard-deadline rules still apply to each entry.

For ordinary rows: Done / Set a reminder / skip / notes / retire, per the walk skill. Hard-deadline rows use the restrictions above. Before each question, `open` any external `links` the row carries (never the workflowy.com permalink — see the walk skill) and print its `note`, `modifiedAt`, and `children` — a recurring item like "Check wageworks balance" is answerable only from the running log in its subtree, and that log is what the last several entries look like. For a row a previous run already saw, also list what that run left in `.llm/gtd/review/`, per **Resume from prior-run artifacts, never rebuild them** above. On "done", run the row's staged `applyOp` **verbatim** — it is the complete `node update` that advances the `<time>`, already computed and shell-escaped.

When the row's notes or children describe steps Claude can perform, offer **Help me do it now** right after Done, per the walk skill's **Help me do it now** protocol.

Offer **Set a reminder** on every row — an item the user will do later today but would forget without an alarm is a reminder, not a skip. Follow the shared walk's **Set a reminder** protocol and record `remind`.

Record every outcome to the skip log, keyed by the row's `id`, per the walk skill's record step.

On **retire**, the user has explicitly said the recurring item should no longer exist. Delete it by full UUID:

```bash
./bin/run.js node delete --id <uuid>
```

Dispatch the delete as the item's outcome write. Do **not** run `applyOp` or otherwise advance the date. Continue to the next item and count this one as retired in the finish summary.

## Less often: the cadence outcome for a repeatedly skipped item

A recurring item's cadence **is** its section, so making it less frequent means moving it down the ladder — `🔄 Daily Review` → `🗓️ Weekly Review` → `Every 4 weeks` → `📅 Monthly Review` → `🗓️ Every 2 months` → `🗓️ Every 6 months` → `🎆 Annual Review`. `compute-overdue.mts` stages that whole move on every row as `lengthen`:

```json
{
	"section": "🗓️ Weekly Review",
	"sectionId": "<uuid of that section>",
	"interval": {"amount": 7, "unit": "d"},
	"nextDate": "2026-07-03",
	"newName": "<the item name with its time element advanced to nextDate>",
	"applyOp": "<node update writing newName> && <node move into sectionId>"
}
```

When a row has `skipStreak >= 2` and a non-null `lengthen`, add an explicit outcome labelled with the target cadence — **Less often → 🗓️ Weekly Review** — and show the streak in the question body (`Skipped 3 runs in a row since 2026-08-11.`). Place it above Done/Skip and above Retire. Repeatedly skipping a daily item usually means it should not be daily, not that it should be deleted, so **Retire is never the promoted answer to a streak**.

On that outcome, dispatch `lengthen.applyOp` **verbatim** — it advances the `<time>` by the new interval and moves the node into the new section in one chained command — and record the outcome as `lengthen`. Count it in the finish summary as a cadence change, not as a date advance.

`lengthen` is `null` when the item is already at the top of the ladder, when its section has no recognized interval, or when the target section is missing from the fetched tree. For an ordinary row, in that case ask the user for the new cadence and build the move by hand per `${CLAUDE_PLUGIN_ROOT}/skills/review-date-updates.md`.

## LLM tasks (#llm-task)

Items tagged with `#llm-task` contain executable instructions in their child nodes. Before walking through a section's regular items, batch the section's overdue `#llm-task` items through the same flow as the `/gtd:review:daily` LLM Tasks phase: list them up front — name, child instructions, and whether each is mandatory — and then **start executing without a skip prompt**. The listing is the plan-visibility moment, not a gate; every task runs by default and the user interjects if they want one dropped. Mandatory tasks always run and are never droppable. No due `#llm-task` items → nothing to list and nothing to run.

**Untagged items Claude runs.** A row with `missingLlmTag: true` (in `overdue.json` or `due-items.json`) has children that say Claude does it end to end — a CLI or script command, a slash command, or "Claude does this" — but its name lacks `#llm-task`. It is an `#llm-task` in all but tag: never put it on a batch decision page as a Done/Skip card. Append `#llm-task` (with a leading space) to its name with `node update --name` (keep the `<time>` element and the rest of the name intact), say so in the listing, and batch it with the section's `#llm-task` items.

Task **execution** stays foreground. If a task runs `cache import-api` / `just daily`, you MUST first drain all pending background date-writes — otherwise the import can clobber items whose API write has not yet landed. Only the post-task date advancement is backgrounded.

**Open-then-confirm tasks.** Some `#llm-task` items only instruct you to open a page/URL for a manual action the user completes themselves (e.g. redeeming credit-card rewards, reviewing a subscription's member benefits). For these, **open the page first** (`open <url>`) and **then** ask whether the task is actually done — opening the page is not the task. In the `AskUserQuestion` body, state both halves explicitly: what you already did (including the page you opened and any script you ran), and the exact manual step the user must perform, read from the item's child instructions. A status-only message such as "The benefits page is open for review" is not enough. Opening can succeed while the real action cannot (a financial submit the user must perform, a page that won't load, info not yet available), so never infer "done" from a successful `open`. Advance the date only on a real "done".

**Interactive-walk tasks.** Some `#llm-task` items are long interactive walks: their instructions ask the user about each file, video, photo, or album entry (e.g. sorting a TikTok album into categories, captioning favorite photos). A walk is still an `#llm-task`, so it never gets a Run now / Skip / Move card on the batch decision page; that card shape is only for a walk that is already kicked off and needs the user to answer for it. Handle them like this:

- Detect them from the child instructions: a per-item loop of questions or decision-page cards, or sorting/triaging a collection one entry at a time.
- Kick each one off up front with the other `#llm-task` items: run its prep (exports, copies, a NAS mount) in the background and stage the walk's own decision page, the page its instructions describe, with the first batch of entries on it. List it with the others as staged, with the page's URL.
- Before kicking off, check for an ssh session: run `[ -n "$SSH_CONNECTION$SSH_TTY" ] && echo ssh`. When it prints `ssh` and the walk shows media by running `open` (rather than on its decision page), anything opened plays on the Mac's screen and cannot be seen over ssh, so don't start it: log a skip per the skip-log rules and say why in the listing.
- Already kicked off — its page is staged from an earlier run or an earlier segment, or its prep is still running: don't restage it. Follow **Resume from prior-run artifacts, never rebuild them** above and pick up the existing page.
- Related setup steps that only serve the walk (e.g. a NAS sync) belong with it: kick them off, skip them, or move them together.
- Non-interactive `#llm-task` items keep the no-skip-prompt behavior above.

### Drafting instruction children

Whenever you write a new instruction child for an `#llm-task` item (converting an item, or adding a rule the user asked for), draft it to these rules:

- **Scope to the item's root.** Read which top-level tree the item lives under (Personal or Work) and word the instruction for that tree only. An item under Personal gets no Work nodes, Work paths, or Work people, and vice versa.
- **Backtick tags you mention but don't apply.** A tag the instruction refers to (a tag to search for, filter on, or leave alone) goes in backticks, like `` `#some-tag` ``, so it doesn't render as a live tag beside the item's own `#llm-task`. Only the tags the item actually carries stay bare.
- **No parenthetical examples.** State the rule; drop "(e.g. ...)" and "(like ...)" asides.
- **No rules that restate defaults.** Skip lines that repeat behavior every `#llm-task` already has, such as confirming before writes or not bulk-writing.
- **No all caps.** Use normal sentence case; never shout words like MUST or NEVER.

### Cross-project #llm-task launches

Some `#llm-task` items are not work for this session — their child instructions say to start a **separate** Claude session in another directory and run a command there. Each part of that launch has a failure mode that reads as success from this side, so treat all the rules below as mandatory.

**Launch into this session's own workspace, never the focused one.** A bare `herdr tab create` or `herdr pane split` lands in whatever workspace and pane the user happens to be looking at, which is almost never the daily review. Resolve your own ids first and pass them explicitly:

```bash
herdr pane current   # .result.pane.workspace_id and .result.pane.pane_id
herdr tab create --workspace <workspace_id> --cwd <target directory> --label <short-name> --no-focus
```

The result's `.result.root_pane.pane_id` is the new pane — capture it; the next step needs it.

**`--label` is required, not optional.** A tab created without one is labelled with its position number (`10`, `11`), which says nothing about what is running in it — and the review spawns several at once, so the user is left with a row of numbered tabs and no way to tell the Downloads cleanup from the Desktop one. Pass a short, lowercase name describing the work (`downloads`, `desktop`, `nextdns`). If you find yourself holding an unlabelled tab, fix it with `herdr tab rename <tab_id> <label>` rather than leaving it numbered.

For a split, use `herdr pane split --current` (or `--pane <pane_id>`) rather than letting it default. Hijacking the user's visible workspace mid-review is disruptive and awkward to undo.

**Start the agent with `herdr agent start`, never by typing into the shell.** A fresh tab is only a shell prompt — creating it does not start Claude. Use the dedicated command, which names the agent so every later call can address it by name:

```bash
herdr agent start <agent-name> --kind claude --pane <pane_id> -- --model opus
```

Everything after `--` is passed to the agent binary, which is where `--model` goes.

Do **not** drive the shell by hand instead. `herdr pane send-text <pane> 'claude --model opus' --enter` does not work: `send-text` takes no `--enter` flag, so the flag is typed into the prompt as literal text and the command never runs — leaving a pane that looks like it is about to start Claude and never does. If you do need to clear a botched prompt line, the key name is `ctrl+u` with a **plus**: `herdr pane send-keys <pane> ctrl+u`. Hyphenated spellings (`ctrl-u`, `C-u`) are rejected with `unsupported key`.

**Pass an explicit `--model`.** A new session picks its own default alias, not this one's, so a task can silently come up on a model it was never meant to run on. Launch with `--model opus` (or whichever alias the item's child instructions name) instead of inheriting whatever the new session defaults to.

**Invoke plugin commands with their full `plugin:command` namespace.** A slash command's name is the plugin name followed by its path under that plugin's `commands/` directory. A plugin named `nextdns` holding `commands/nextdns/report.md` therefore answers to the three-segment name `nextdns:nextdns:report` (typed with a leading slash), not the two-segment `nextdns:report`. That doubled segment is normal and easy to drop — dropping it is what produces `Unknown command`. Confirm the name resolves before sending it:

```bash
ls ~/.claude/plugins/cache/*/<plugin>/*/commands
```

**Verify the launch before calling the task done.** After submitting the prompt (`herdr agent prompt <agent-name> <text>`), read the new session's output back with `herdr agent read <agent-name>` or `herdr pane read <pane_id>` and confirm it is actually running. Two distinct failures show up here: `Unknown command:` means the slash-command name was wrong, and a bare shell prompt (`❯`) with your command sitting on it un-executed means the agent never started at all. A launched-but-failed agent is not a completed task — do not advance the item's `<time>` on a launch alone.

**Check the ledger before launching; record every launch in it.** Two review sessions once both launched the same task because nothing remembered the first launch, and the launched agents' reports were never read. Before creating a tab, run `node ${CLAUDE_PLUGIN_ROOT}/scripts/agent-launches.mts check <slug>`; on `true`, skip the launch (the task already ran this cycle) and do not advance its date again. After `herdr agent start` succeeds, run `node ${CLAUDE_PLUGIN_ROOT}/scripts/agent-launches.mts record <slug> <pane_id> <cwd>`, which writes `.llm/gtd/review/agent-launches.json` and prints the report path. Add this to the agent's prompt: write your final report to that path (`.llm/gtd/review/agent-reports/<slug>-<YYYY-MM-DD>.md`, relative to the review's repository root, using its absolute path). The review reads the reports in **Closing walk** of `work-together.md`.

## Directory-cleanup items are launches, not inventories

A recurring item whose work lives in **another directory that has its own `CLAUDE.md`** — "Clean up files in Downloads", "Clean up files on Desktop" — is a launch too, even though it carries no `#llm-task` tag. That directory's `CLAUDE.md` holds the cleanup rules, and only a session started there loads them. Recognize the shape from either signal:

- The item's name or children name a directory outside this repository (`~/Downloads`, `~/Desktop`).
- A child reads like `cd <directory> && claude`, or says to organize files "according to @CLAUDE.md".

Confirm with `ls <directory>/CLAUDE.md` before launching. If there is no `CLAUDE.md`, the item is ordinary: walk it per **Recurring item options** above.

When it matches, do **not** list, inventory, or triage the directory's files from the review session, and do not ask the user what to do with individual files. Launch a labelled herdr tab in that directory under every rule in **Cross-project #llm-task launches** above — `--cwd <directory>`, a `--label` naming the work (`downloads`, `desktop`), `herdr agent start`, an explicit `--model`, and the same launch verification — then prompt the new agent to clean up the directory according to the `CLAUDE.md` in its working directory. Launch every matching item before asking the user about any of them, so the sessions run in parallel.

## Command-shaped items: offer #llm-task + a herdr tab first

Some untagged recurring items are nothing but a shell command to run in a directory — a child reads `cd ~/projects/<repo> && just <recipe>`, or the name is a runnable command plus a path. Walking one by hand means the user copies the command into a terminal every cycle. Recognize the shape when the item's whole action is one command (or a short `&&` chain) with a working directory, and the item needs no judgment beyond running it. An item that also asks the user to read, decide, or perform a manual step is not command-shaped; walk it per **Recurring item options** above.

For a command-shaped item, make **Make it #llm-task + run in a herdr tab** the **first** option in the `AskUserQuestion`, above Done and Set a reminder, and quote the command and directory in the question body. The user has chosen it for every command-shaped item so far, so it is the promoted answer. The other outcomes stay available below it.

On that choice, do both halves:

- **Convert the item.** Append `#llm-task` (with a leading space) to the item's name with `node update --name`, keeping its `<time>` element and the rest of the name intact. Make sure the command and its directory live in a child node, since `#llm-task` instructions are read from children; if they were only in the name, create a child holding `cd <directory> && <command>`, drafted per **Drafting instruction children** above. Future runs then batch it through **LLM tasks (#llm-task)** above instead of asking.
- **Run it now in a labelled herdr tab** in this session's workspace, under every rule in **Cross-project #llm-task launches** above. For a plain shell command, the launch script satisfies the workspace, label, and placement rules in one call:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/launch-herdr-tab.mts --label <short-name> --cwd <directory> --no-focus -- <command...>
```

It prints `{paneId, ...}`. If the command itself starts a Claude session, use `herdr agent start` with an explicit `--model` instead, per the cross-project rules.

Verify the launch with `herdr pane read <paneId>` and confirm the command is running or produced output, not a bare shell prompt with the command un-executed. Advance the item's `<time>` with its staged `applyOp` only after that verification, and record the outcome as `done`. A failed launch leaves the date alone; say what failed and fall back to the ordinary options.

---

## Segment 2 — Due items

One-shot dated tasks from three sources. Runs immediately after Segment 1, with no phase boundary and no "shall we continue" prompt between them.

## Why these three together

They are the same kind of thing — a dated task that should be done once — stored in three systems that model dates differently. Walking them separately meant Workflowy's buckets were never walked at all, and items reached 90 days overdue while technically being on screen every morning.

## Compute the working set

All three inputs were staged by **Fetch every source before the first question** at the top of this command — `due-workflowy.json`, `due-things.json`, and `due-reminders.json`. If a Workflowy import ran during Segment 1, re-run the Workflowy fetches there first; never launch `reminders-fetcher` again here.

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/collect-due-items.mts \
  --workflowy .llm/gtd/review/due-workflowy.json \
  --things .llm/gtd/review/due-things.json \
  --reminders .llm/gtd/review/due-reminders.json \
  --recurring .llm/gtd/review/tree.json \
  > .llm/gtd/review/due-items.json
```

Each row carries `source`, `id`, `title`, `due`, `dueSource`, `overdueByDays`, `needsDate`, `group`, `url`, `skipStreak` / `skippedSince` folded from the skip log, and an `ops` object holding the verbatim `complete`, `reschedule`, and `drop` commands. It also carries the context each question needs — `note` (the Workflowy note, the Things note, the Reminders note), `modifiedAt`, `childCount`, `children` (title, note, own child count, url), and `links` (every http(s) URL in the title and note) — which is why the Workflowy fetch above asks for `note,modifiedAt` at depth 5. Show it per **Show the item, do not just name it** in the walk skill: `open` the row's external `links` (not its workflowy.com `url`), print the children, and print all of it immediately before the `AskUserQuestion`. For a row a previous run already saw, add the prior-run artifacts per **Resume from prior-run artifacts, never rebuild them** above. Rows are sorted by due date with undated items last. Anything not yet due is already excluded. Pass `--print` for a human-readable dump while debugging.

**Source semantics the collector already resolved, so the walk doesn't have to:**

- Only the `⏰` bucket is collected. The `📌 Tasks (asap)` bucket has no dates and is out of scope.
- A task's children are sub-steps, notes, and provenance — never tasks in their own right.
- A Things task in the Today list without a deadline is dated to its Things **activation date** when that is earlier than today, otherwise to **today**, with `dueSource: "scheduled"`. Things putting it in Today is the due signal, and the activation date keeps a leftover repeating chore on the day it belongs to.
- Reminders `dueTomorrow` is excluded; this walk is for what is due now, not a preview.
- A Workflowy task in the `⏰` bucket with no `<time>` gets `needsDate: true` — see below.

## Cross-source duplicates

The collector groups due rows with matching normalized titles under their Workflowy survivor in `duplicateCopies`. Normalization strips markup and date elements, applies Unicode NFKC and lowercase, and collapses whitespace. Each copy retains its source, identity, context, skip history, and staged operations. Same-source rows are never merged. If several Workflowy rows match, leave them separate and resolve the ambiguity with the user before removing anything; a matching title is a candidate, not authorization to delete.

Present the survivor and its copies as **one question**, naming **Workflowy + Things 3**, **Workflowy + Apple Reminders**, or all three stores as applicable. Show each title, date, note, and identity so the user can distinguish similarly named tasks. Do not ask about nested copies again as separate rows.

Place **Drop the non-Workflowy copy, leave Workflowy live** first, ahead of Done and any skip-streak option. Follow the shared walk's `dropDuplicate` outcome: cancel each approved Things copy with its own `ops.drop`, or queue each approved Reminders deletion into the existing batch. Never run the Workflowy row's operations for this answer. Do not create another Workflowy node, complete the survivor, clear its date, move it, or reschedule it. Read back the external state and the unchanged live Workflowy row before logging success. If a Reminders deletion is pending, defer the handled record until batch verification succeeds.

**Skip** leaves all copies unchanged and records `skip` for each source key. If the user says the titles describe different tasks, walk them separately with the ordinary options. Any other requested outcome must name exactly which store's rows it changes; do not apply one row's Done or Drop to the entire group implicitly. Once duplicate removal succeeds, the survivor is handled for this run even if undated; do not immediately ask it for a date or present it again. Count verified removals as duplicate copies dropped, separately from completed tasks.

## Check recurring counterparts before offering a tier

Before asking about a recurring-shaped due row (chores, maintenance, medication), inspect its `recurringCounterparts`. The collector searches the full staged `tree.json` under `Personal > 🔄 Review` by normalized title, including future-dated items under **Every 6 months Review** and nested groups. It excludes completed, archived, and mirror subtrees. Never search only `overdue.json`: a recurring counterpart may be scheduled months from now. An absent `recurringCounterparts` field means the lookup was not run; recompute with `--recurring` before offering an asap tier. An empty array means no title match was found, not proof that no differently named counterpart exists.

Repeat each candidate's title, full path, Workflowy link, and `nextDate` in the question body, as well as the one-shot row's date and context. Say “next date not set” for a null date. If Segment 1 changed that item, use its verified new date, or re-fetch `tree.json` and recompute before asking. Title equality identifies candidates; ask the user to confirm that the recurring task covers this occurrence, especially when its next date is in the future or several candidates match.

For a recurring-shaped row, place **Delete this copy — the recurring item covers it** (only when a candidate exists) and **Make it recurring** above **Move to asap ladder** or any **Clear the date** outcome that asks for a tier. Use the shared walk's recurring outcomes below; never open the tier chooser first. Existing cross-source `duplicateCopies` take precedence and remain one question with **Drop the non-Workflowy copy, leave Workflowy live** first. Name the recurring candidate in that question too; deleting the Workflowy due copy requires a separate explicit decision and must never be implied by dropping its external duplicates.

A genuine external deadline still requires its deadline protections. A future recurring date does not establish that today's obligation is covered. When the user confirms this is one-shot work, retain the ordinary high-priority asap ordering and tier choice. A skip streak alone never authorizes deletion or a lower tier.

## Decision-page cards

When a segment's walk goes to the decision page (see **Decision page** in `${CLAUDE_PLUGIN_ROOT}/skills/review-proposal-staging.md`), each card's title already names the item, so the body carries only the deciding facts, one per line. For an overdue row, those are `overdue Nd` and, when `skipStreak >= 2`, `skipped N runs`. Leave out the `Due <date>` line and the `since <date>` suffix on the streak; the overdue count already says how late it is. Context lines (child count, note, prior-run artifacts, recurring counterparts) follow, each on its own line.

A row with `isLlmTask` or `missingLlmTag` set is never a card: Claude runs it per **LLM tasks (#llm-task)** above. The only exception is a walk that is already kicked off and needs the user's answer.

## Due item options

For rows with `duplicateCopies`, use **Cross-source duplicates** above before the ordinary options. For recurring-shaped rows, apply **Check recurring counterparts before offering a tier** first. For ordinary one-shot rows, first option is the most likely outcome, per the walk skill. That is **Done** on Workflowy and Things rows and **Move to Workflowy** on Reminders rows — a dated reminder has nothing the `⏰` bucket does not do better, so moving it is almost always the answer.

- **Dispatch to `<session>`** — on a Reminders row whose `note` holds a `dispatch-to: <name> [<ref>]` line, place this first, above **Move to Workflowy**. A Claude Code session set the reminder to resume its own work, so the answer is to hand it back, not to file it. Follow `/gtd:dispatch`, which already has the address from the note, then queue the reminder deletion (`ops.drop`) into the batched Reminders write once the send succeeds. Record `dispatched`.
- **Done** — run `ops.complete` verbatim only when the outcome itself is complete. Handing work to an external party is **Waiting on someone else**, not Done.
- **Waiting on someone else** — offer on every row when the user has finished their part but awaits an external outcome, such as a submitted claim, filed request, or sent question. Follow the shared walk’s **Waiting on someone else** protocol: ask for the check-back horizon, recommend a typical turnaround only when the item or subtree records one, and append a check-back `<time>` built by `buildTimeElement`. Move the incomplete node under the matching root’s direct `📤 Delegate` child; for Things and Reminders, create and verify the follow-up there before removing the external copy, batching Reminders deletion. Verify the final state before recording `waiting` against the original source key so its skip streak resets. Count it separately from Done. The morning overview already surfaces Delegate, so do not create a second reminder.
- **Help me do it now** — offer, right after the first option, when the row's notes or children describe steps Claude can perform: verify a charge, research a question, draft a message, or type it into a browser form. Follow the shared walk's **Help me do it now** protocol: do the steps as continued work instead of handing over a script, confirm before anything is sent or submitted, and end with the row's ordinary outcome (a submitted request is **Waiting on someone else**).
- **Move to asap ladder** — after the recurring-counterpart check and its promoted outcomes, on every ordinary Workflowy `⏰` row whose date has passed without external-deadline evidence, place this immediately after **Done**, above **Reschedule** and any longer-horizon option. The user used the date to signal **high priority**; its passing means the task still matters. Follow the shared walk's **Preserve priority in the asap ladder** protocol and record `clearDate`. Load the matching root's ladder and ask for `1st`, `2nd`, `3rd`, or `4th`, recommending `2nd` as the mid-high default. Reserve the bottom tier for an explicit decision to deprioritize. Use `planInsertion` from `${CLAUDE_PLUGIN_ROOT}/scripts/asap-tiers.mts` for the tier's `targetId`; filing never moves any other item, even into a full tier. Then run `ops.moveToAsap` verbatim. That op removes the `<time>` and initially lands on the bottom tier; move the task to `planInsertion.targetId` when the chosen tier differs, and verify its final tier before counting it handled.
- **Group under `<project>`** — on a Workflowy `⏰` row whose topic matches a project or group node already on that root's `📌` ladder (e.g. a repair task beside an on-ladder `🔧 Handyman` group), offer this as its own option right next to **Move to asap ladder**, naming the project and its tier in the label. Find candidates by reading the ladder with `readLadder` and checking the theme vocabulary in the gitignored `.llm/gtd/task-groups.md`; a title that merely shares a word is not a match. Never offer an off-ladder project (a direct child of `📁 Projects (in flight)` or anything outside the `📌` bucket) — anchoring a task there hides it from every ladder walk. The group already carries its tier, so ask no tier question. Run `ops.moveToAsap` verbatim to strip the `<time>`, then `./bin/run.js node move --node-id <id> --parent-id <projectUuid> -p bottom`. Verify the task sits undated under the project before recording `clearDate`.
- **Move to Workflowy** — offer on every **Things** and **Reminders** row; a Workflowy row is already home. The task is real and its date is real, but it lives in the wrong database. Follow the shared walk's **Move to Workflowy** protocol and record `moveToWorkflowy`. This keeps the date; **Clear the date** below removes a date that no longer serves as a deadline. The source mechanics are mandatory:
    - **Both sources** — create the task under the matching root's `⏰ Tasks (due dates)` bucket, with the row's `due` appended to the title as a `<time>` element built by `buildTimeElement` from `${CLAUDE_PLUGIN_ROOT}/scripts/collect-due-items.mts` — the same stamp the file-tasks sweeps apply, never a hand-built one. Resolve the bucket UUID from the staged `root-<work|personal>.json` (the `⏰` child under the `✅ Tasks` wrapper), not from memory. Things and Reminders rows carry `rootKey: null`, so default to **Personal** and offer **Work** only when the title reads as work. Carry the row's `note` across as a child node when it holds a link or context the title alone loses. Append a topic `#tag` the same way the file-tasks sweeps do, and nothing more.
    - **Things 3** — a create-and-complete pair in one background job, chained with `&&` so a failed create can never destroy the task: `./bin/run.js node create --parent-id <dueBucketUuid> --name '<title><time element>' --position bottom && <ops.complete verbatim>`. Verify the node landed in the bucket and `return status of to do id "<id>"` reads `completed` — never trust the exit code.
    - **Apple Reminders** — run the Workflowy create now and, once it has returned, queue the reminder deletion (`ops.drop`) into the batched Reminders write below. Verify the new node and verify through `reminders_fetch` that the reminder is gone before counting it moved.
- **Reschedule** — offer `Today`, `This week`, `This month`, and `Other`. Convert the choice to a date with `resolveTimeframe` from `collect-due-items.mts` (never by hand — "this week" means the upcoming Friday and the weekday must be computed), then build the command with `applyReschedule(item, iso)` from the same module and run it. **Never substitute `{{date}}` yourself.** The three sources need different representations — Workflowy takes a `<time>` element, Things and Reminders take an AppleScript `date "August 31, 2026"` string — and dropping HTML into an `osascript` call sets a garbage date instead of failing. `applyReschedule` picks the right one from the row's `source`.
- **Clear the date** — offer on Things and Reminders rows when the date is no longer needed. On Workflowy rows, label this outcome **Move to asap ladder** instead, using the same priority and insertion rules above; do not offer a duplicate clear-date option. Follow the shared walk's **Preserve priority in the asap ladder** protocol and record `clearDate`. The remaining source mechanics are mandatory:
    - **Things 3** — clear the due date in place with `delete due date of to do id "<id>"`. Leave the task in Things and do not ask for a Workflowy tier. Do **not** use `set due date … to missing value`: Things raises the same `Can't make missing value into type date (-1700)` error Reminders does, and the assignment silently accomplishes nothing. `delete due date` is the form that works. Verify with `return due date of to do id "<id>"`, which reads back `missing value` once it is cleared — never trust the exit code.
    - **Apple Reminders** — `set due date of r to missing value` fails with `Can't make missing value into type date (-1700)`. Ask for a Workflowy asap tier, create the task there, then queue the reminder deletion in the batched Reminders write. Verify the new Workflowy node and verify through `reminders_fetch` that the reminder is gone before considering it handled.
- **Set a reminder** — offer this on **every** row. The task is real and needs doing today, but the user will forget it without an alarm. Follow the shared walk's **Set a reminder** protocol and record `remind`. One source mechanic is mandatory: on an **Apple Reminders** row the alarm already exists, so never create a second one through Fantastical — set the requested time on the existing reminder by queuing it into the batched Reminders write below.
- **Drop** — run `ops.drop`. For Workflowy this deletes the node; for Things and Reminders it cancels or deletes the task. Confirm before dropping anything with `childCount > 0`.
- **Skip** — write nothing.

Record every outcome to the skip log, keyed `<source>:<id>` (`things:ABC123`, `workflowy:<uuid>`, `reminders:<title>`), per the walk skill's record step.

### Apple Reminders writes freeze — batch them, never write one per item

Reminders accepts a small number of AppleScript writes and then stops responding: `osascript` hangs until the timeout kills it, exits non-zero (124), and applies nothing. Reads through `reminders_fetch` keep working the whole time, which is what makes it confusing — the data is reachable, only writes are frozen. Quitting and relaunching Reminders.app clears it, but only for the next few writes.

So do **not** write a reminder per walk item. Instead:

- First, walk every reminder row and collect the user's decisions in memory. Workflowy and Things writes still happen immediately; only Reminders is deferred. A **Move to Workflowy** answer therefore splits: its Workflowy create runs now, and its reminder deletion joins this batch.
- After the last item, quit and relaunch Reminders.app (`osascript -e 'tell application "Reminders" to quit'`, `pkill -9 -x Reminders` if it survives, `open -a Reminders`, sleep ~10).
- Then apply every reminder change in **one** `osascript` file with a generous `timeout` (180s), using handlers that look each reminder up by name and return a per-item status line.
- Finally, **verify with `reminders_fetch`, never with the script's exit code.** A batch that times out part-way still applies everything it reached, so diff the incomplete list against the decisions and retry only the stragglers individually.

Two behaviors that look like failures and are not:

- A **recurring** reminder does not disappear when completed — it rolls forward to its next occurrence. `Take the NAD plus` completing out of Aug 17 and reappearing dated Aug 23 is success, not a no-op.
- `trash` and Finder's AppleScript `delete` both exit 0 while silently failing on filenames containing emoji or fullwidth punctuation. `mv` to `~/.Trash` is the reliable path when clearing files.

Never report a reminder handled on the strength of an exit code. Every one of these paths has returned 0 while doing nothing.

### Materialize AppleScript whose queries before iterating

For **every AppleScript `whose` query these reviews iterate, including Things**, fetch the matches before entering the loop: `set matches to (get every reminder whose ...)`, then `repeat with r in matches`. Never use `repeat with r in (reminders whose ...)`. That form leaves `r` as a deferred `item N of every reminder whose ...` reference: each dereference re-runs the filter, so a changing result set can raise `Can't get object (-1728)` even while the reminder still exists. This is the same class of failure as Things' dynamic-list `Invalid index (-1719)`; keep the Things fetcher's existing ID snapshots and `to do id` lookups.

Use a per-item `try`, count failures, and report each failed item's position and error. This read-only example shows the required loop structure:

```applescript
tell application "Reminders"
    set matches to (get every reminder whose completed is false)
    set failureCount to 0
    set itemNumber to 0
    repeat with r in matches
        set itemNumber to itemNumber + 1
        try
            log (get name of r)
        on error errorMessage number errorNumber
            set failureCount to failureCount + 1
            log ("Item " & itemNumber & " failed (" & errorNumber & "): " & errorMessage)
        end try
    end repeat
    return "Matched " & (count matches) & "; failed " & failureCount
end tell
```

For writes, use this structure inside the batched handlers above, narrow the query to the user's approved decisions, and put the approved operation inside the `try`. Materializing matches does not authorize changes or guarantee that an item still exists. Retain per-item status lines, surface a nonzero failure count in the review summary, and verify writes through `reminders_fetch`; never turn caught errors into silent skips or claim the batch succeeded because the loop finished.

## Push it out: the cadence outcome for a repeatedly skipped task

Each row carries `skipStreak` and `skippedSince`. When `skipStreak >= 2`, show the streak in the question body. For work with an external but movable deadline, promote a **longer horizon** above the ordinary reschedule. `resolveTimeframe` accepts `Next month` and `Next quarter` alongside the usual timeframes, so build the write exactly as a reschedule: resolve the label, then `applyReschedule(item, iso)`.

For an ordinary one-shot Workflowy row whose date has passed without external-deadline evidence, keep **Move to asap ladder** immediately after **Done**, including when it has a skip streak. Preserve its high priority with the tier choice above. A streak alone does not establish an external deadline or justify lowering priority. For Things and Reminders work with no deadline, keep **Clear the date** available.

**Drop stays available and stays unpromoted.** A streak means the date was wrong, not that the task is dead.

## Items missing a date

Apply the cross-source duplicate and recurring-counterpart checks before asking for a missing date. A row with `needsDate: true` is a Workflowy task filed into the `⏰` bucket without a `<time>`. The bucket means "this has a deadline", so a missing date is a data defect, not a valid state. Present these at the end of the segment and ask for a date using the same `Today` / `This week` / `This month` / `Other` options. Running `ops.reschedule` on an undated node appends the new element rather than swapping one.

Do not silently leave a task undated. An undated task in the due-dates bucket is invisible to every future run of this walk, which is exactly how the backlog formed.

## Finish

Drain all outstanding background writes per the walk skill, then print one summary line covering both segments — e.g. `✓ 12 recurring dates advanced, 3 cadences lengthened, 2 retired, 1 reminder set · 9 due items completed, 4 rescheduled, 2 pushed out, 3 moved to Workflowy, 1 date cleared, 2 reminders set, 2 dropped` — or list failures by item name instead of reporting success.
