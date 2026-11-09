---
description: Rebalance both 📌 asap ladders — surface tiers 1-2 as today's goals, then propose push-downs out of over-cap tiers, pull-ups into empty high tiers, and a new bottom tier when the landing zone passes 2^k. Every move is chosen by the user; the local page writes immediately and Monitor receives each edit over WebSocket. Use when the user wants to review, rerank, or tidy the asap priority ladder, set goals for the day, or run the rebalance phase of the daily review.
---

# Rebalance the Asap Ladders

Read each root's `📌 Tasks (asap)` ladder and bring it back into shape. Filing an item into a tier never moves any other item (see `${CLAUDE_PLUGIN_ROOT}/skills/asap-tiers.md`), so a tier the user filed into while full stays over cap until this phase reads it. This is the only phase where items leave an over-cap tier, and the user is the one who moves them.

**Every action here is chosen by the user.** Push-downs, pull-ups, completions, and the split that extends the ladder are chosen in the ladder page. The local app applies each gesture immediately. Nothing is demoted, promoted, or moved on its own, and no item is ever chosen because of where it sits in the tier -- ranking inside a tier is the user's judgment, not a position.

Scope is **both** roots linked from `Metadata > ☑️ Next Actions` -- Work and Personal -- discovered by link resolution, never hardcoded.

## Do not use the built-in task list

Track progress through `.llm/` files and inline status updates. Do **not** create Claude Code built-in tasks (`TaskCreate` / `TaskUpdate` / `TodoWrite`) for the per-tier work here.

## Run before anything files onto the ladder

In the daily review this phase runs after the Morning Overview and Distribute Project Tasks, and **before** Process Inbox, File Loose Tasks, and the Recurring Review's due walk. Those phases all put new items onto the ladder; a rebalance that runs after them is stale the moment it finishes, and one that runs before them hands them a ladder whose caps mean something. When invoked standalone, run `/gtd:review:daily:relink` first so nothing is sitting on a `Metadata` link node.

## Read both ladders

Resolve the roots from the metadata anchor, then each root's `📌` bucket, exactly as `${CLAUDE_PLUGIN_ROOT}/commands/review/daily/file-tasks.md` does under **Discover the roots** -- `linkTargets[0].id` of each child of `d81ba063-5604-49a5-bb87-0d0fe59d0a48`, then the `📌`-prefixed child of that root's `✅ Tasks` wrapper. **Never read a ladder off a mirror.** The buckets are mirrored under `Personal > 🔄 Review > 🔄 Daily Review > Set goals for today`, and a mirror's children look right while its id is wrong for every write. Confirm `mirror.isMirror` is false on the bucket you fetch.

```bash
mkdir -p .llm/gtd/review
./bin/run.js node get --id <asap-bucket-uuid> --depth 2 --json \
  --fields name,id,shortId,children,completedAt > .llm/gtd/review/ladder-<work|personal>.json
node ${CLAUDE_PLUGIN_ROOT}/scripts/asap-tiers.mts rebalance .llm/gtd/review/ladder-<work|personal>.json \
  > .llm/gtd/review/rebalance-<work|personal>.json
```

`rebalance` runs `planRebalance(readLadder(bucket))` and prints one report per ladder:

- `dayPlan` -- tiers `1st` and `2nd` with their items.
- `pushDowns` -- every capped tier (every tier that has a tier below it) over its `2^k`, with **all** of its occupants, `excess` (the minimum that must leave), and the tier below (`toTier` / `toId`).
- `pullUps` -- the run of empty tiers starting at `2nd`, each fed from the first non-empty tier below the run, with that tier's items as `candidates`. `1st` is never a pull-up target.
- `extend` -- the bottom tier once it holds more than `2^k`: the new tier to create, `minimumToMove`, and all of its occupants.

A tier that is missing from the bucket counts as empty with `id: null`. Create it with `node create --parent-id <bucket-uuid> --name '<label>' --position bottom` only when the user explicitly adds it in the local page, before moving anything into it. Never compute a cap or an excess by hand.

If both reports have empty `pushDowns`, empty `pullUps`, and `extend: null`, print the day plan (below) and return -- there is nothing to rebalance.

## Surface the day plan

Tiers `1st` and `2nd` are the goals for the day. Print them for both roots before proposing anything, every run, even when the ladder is in shape:

```markdown
**Today's goals -- Work** 1st (2/2): Ship the rollup RFC · Fix the TV page ordering 2nd (3/4): Draft the Q3 platform plan · Review Alice's design doc · Upgrade the Gradle plugins

**Today's goals -- Personal** 1st (0/2): (empty) 2nd (2/4): Book the dentist · Renew passport
```

Strip HTML for display and render embedded links as markdown. Do not ask whether to work on these; the review is orientation, not execution.

## Use the local ladder page for every rebalance

Follow **Choose the presentation surface** in `${CLAUDE_PLUGIN_ROOT}/skills/review-proposal-staging.md`. Use the existing local web app first:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/rebalance-ui.mts
```

Open the printed `/ladder` URL. `REBALANCE_WEB_APP_URL=http://localhost:5175` selects a local dev server; `--output .llm/gtd/review/rebalance.html` generates a small launcher without exporting task names. The route is built from checked-in React source with `vp run --filter @outlinedb/web build`. Preserve its root tabs, range selection, touch handles, tier buttons, per-row Done and immediate persistence.

The app applies the user's gestures through local API endpoints immediately. Never replay those writes with the CLI. Observe `/api/v1/ladder/events` and refresh `/api/v1/ladder` plus the live bucket exports to verify outcomes. A disconnected event stream or successful click is not verification. Record only verified changes; report failed requests by item and let the user retry. Adding a tier uses the existing node-create endpoint and refreshes the ladder before it becomes a move target. No task data is uploaded to claude.ai.

### Watch writes with Monitor

Start Monitor with `ws: <ladder-origin>/api/v1/ladder/events`, using `ws://` for HTTP or `wss://` for HTTPS. For the local development server, the source is `ws: ws://localhost:5175/api/v1/ladder/events`. Each successful move or completion produces one JSON frame with `nodeId`, `name`, `fromTier`, `toTier`, `verb`, and `at`; Monitor turns each frame into a notification. Watch this channel during the review instead of polling. The notification reports an edit already applied by the server; never apply it again.

If the app or Monitor is unavailable, report the actual startup, connection, or tool failure. Start the local web app before continuing ranking. Do not switch to an Artifact submission, save document, or polling loop. Artifact CSP blocks fetch/XHR/WebSocket to the local app and external workers, so an Artifact page cannot act as a hybrid client.

## Interpret the page choices

Use the fresh `rebalance` reports to explain capacity and empty tiers in the page workflow. The reports are guidance, not authority to select items or execute repairs. The user can switch roots and edit either ladder; each gesture is written immediately.

- **Push-downs:** the page exposes every occupant and tier count. The user chooses which items move down; never pre-select the last `excess` items, infer the remaining moves from row order, or ask which items stay through a question tool.
- **Pull-ups:** the user moves items into empty tiers in the page, or leaves them empty. Do not separately walk candidates or ask a "Leave it empty" question. `1st` is never an automatic pull-up target; only an explicit page choice may move an item there.
- **Extensions:** the user adds a bottom tier and chooses its occupants in the page. The app creates only the requested tier and moves only the selected items. Never split the bottom tier on position or move unnamed items as an inferred complement.

Refresh both reports after verified edits. A move can change another tier's capacity status; surface any remaining over-cap or empty tiers and let the user make further page edits. Never force a repair or return to question-based ranking because the chosen arrangement leaves a violation.

### Every status line comes from a fresh read

Every interim status line (such as `2 moved · 6 to complete · 1 tier still over`) must meet the same bar as the final summary under **Finish**. Any claim about tier occupancy, counts, or "still over cap" comes from a fresh `GET /api/v1/ladder` or the current WebSocket-applied state. Count the moves the user has made or proposed in the page. Never compute one from the `rebalance` reports the phase opened with, and never subtract Monitor notifications from those opening counts by hand.

- **Re-read before you speak.** Before printing any count or cap claim, fetch `/api/v1/ladder` (or re-export both buckets and re-run `rebalance`) and derive the line from that result.
- **Include pending page moves.** If the user describes moves they have selected but not yet applied, recompute occupancy with those moves applied before saying a tier is over cap. Label it as projected, for example `1st 2/2 · 2nd 4/4 once the 3 pending moves land`.
- **Say nothing rather than something stale.** When a fresh read fails, report the failure and omit the count. Do not fall back to the opening snapshot.

### Size never changes the surface

The ban on question-based ranking covers the initial presentation, not only the repair after a page edit. A large excess is the case the page exists for, not a reason to fall back to questions.

- **Any excess goes to the page.** A capped tier over its `2^k` always reaches the ladder page as its `pushDowns` proposal, whether `excess` is 1 or most of the tier. Do not judge the count unworkable, and do not open with a question about how to choose. Open the page with the report's numbers and let the user pick.
- **Unranked sweeps get a bulk criterion, on the page.** A landing-zone tier filled by sweeps holds items nobody ranked, so naming them one by one is the wrong unit of work. Offer bulk criteria alongside the proposal -- a shared tag, age since creation, last-touched date -- each with the count it would move, so the user selects a whole group in the page with one range selection. The criterion is a way to group rows, not a selection: never move the matching items yourself, and never ask which criterion to use through a question tool.
- **Skipping is the user's call.** Do not offer "skip the rebalance" as the escape from a large tier; a tier left over cap is recorded as `skipped` and proposed again next run.

## Record the outcome

Append one line per ladder to `.llm/gtd/review/rebalance-log.jsonl` -- `{"date", "root", "pushedDown", "pulledUp", "extended", "skipped"}` -- so a later run can see whether a tier is chronically over cap. Do not write anything to Workflowy beyond the confirmed moves, tier creates, and explicit completions.

## Finish

Drain every background move and surface failures by item name. Then re-run `rebalance` on both ladders one last time, from fresh bucket exports as **Every status line comes from a fresh read** requires, and print one line per root: `✓ Work: 3 pushed down, 0 pulled up, 7th created (33 moved) -- all capped tiers within cap`, or name any capped tier still over cap and any empty `2nd`, because the user declined -- that is a legitimate outcome, not a failure, and the next run proposes it again.
