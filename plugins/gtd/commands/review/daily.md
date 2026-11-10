---
description: Daily review orchestrator — run the full morning routine in order: execute due automated LLM tasks, relink orphaned items, review meeting follow-ups, give the morning overview, distribute project tasks into each project's .llm/todo.md, rebalance the asap ladders, process the inbox, file loose tasks, clean up completed tasks, group related tasks, walk every dated item that needs handling today, list everything skipped with a chance to check off what got done, and close by offering to work through the most pressing items together. Use whenever the user asks to do, start, or run their daily review or morning GTD routine.
---

# Daily Review

Run the full daily review: execute overdue LLM tasks, tidy misfiled items off the navigation links, get oriented with the morning overview, push project-shaped tasks out to their projects' task lists on disk, set the day's goals by rebalancing the asap ladders, empty the inbox, file loose tasks, group related ones into projects, walk everything dated that needs handling today, list everything skipped so the ones done since can be checked off, and close by offering to do the most pressing work together.

The phases run in dependency order — each one's output feeds the next, ending with the walk that asks what's actually done and then the offer to do the work that remains:

```text
LLM Tasks → Relink → Meetings → Overview → Distribute → Rebalance Ladders → Process Inbox → File Loose Tasks → Clean Up Completed → Group Tasks → Recurring Review → Skipped Today → Work Together
                                                               (producers of ladder and dated tasks) ────────────────────────────↗
```

The Meeting Follow-up Review, Morning Overview, Distribute Project Tasks, Rebalance Ladders, File Loose Tasks, Clean Up Completed, Group Related Tasks, Recurring Review, and Work Together phases delegate to `/gtd:review:daily:meetings`, `:overview`, `:distribute`, `:rebalance`, `:file-tasks`, `:cleanup-completed`, `:group-tasks`, `:due`, and `:work-together`, each of which already carries the "do not use the built-in task list" rule — don't create built-in tasks (`TaskCreate` / `TaskUpdate` / `TodoWrite`) for the LLM Tasks or Skipped Today phases either.

## When a skill breaks, fix the skill first

This rule covers **actual breakage only**: a script that errors or exits non-zero, a command that does the wrong thing, a wrong assumption baked into these docs that makes a step produce wrong results. If you hit one of those **while running the review**, stop the review and fix the skill first, then resume. Do not work around it inline and press on. Fixing the skill is red/green TDD (write the failing test, fix, run `vp check` / `vp test` per the project precommit checklist), and it takes priority over finishing the day's review, because every future run benefits. This is distinct from a data/MCP failure (see [Handling failures](#handling-failures)); that path is about pausing and asking, this one is about the tooling itself being wrong.

It does **not** cover anything the review could finish without. An improvement idea is not breakage, however good it is, and it never stops the walk — it goes to the mid-run notes file, next.

### Commit before resuming

The fix is not done until it is committed. A passing suite with the change still sitting in the working tree is an unfinished fix: the next session inherits an uncommitted diff it did not make, and the review resumes on top of it. After `vp check` / `vp test` pass:

- Run `git status --short` and `git rev-parse --abbrev-ref HEAD`.
- If HEAD is detached or on a branch you did not expect, surface it and resolve it before committing — do not commit onto a branch you cannot name.
- Commit the fix (the `git:commit` skill), then confirm `git status --short` prints nothing.
- Only then resume the review.

The same closing step applies to every plugin-file edit the review makes, whether from a broken skill, a mid-run-notes follow-up, or a meta-feedback apply: edit, verify, commit, clean tree, resume. Leaving plugin edits uncommitted is the failure mode this guards against.

## An improvement noticed mid-walk never stops the walk

An improvement idea that surfaces mid-walk — a preference the user states, a nicer way to present an item, a maybe-better option, a design question about how a phase works — is **not** a reason to stop, poll the user, or switch to editing skills. The walk continues to the next item. It is also not something to carry in context until the end of the run: by then the item name, the phase, and the user's exact words are gone, and the meta-feedback task receives a vague summary instead of a usable candidate.

**Append it to a file immediately, then present the next item.** The sink is `.llm/gtd/review/mid-run-notes.md`. Append one bullet per observation under a `## YYYY-MM-DD` heading (add today's heading if it is missing), carrying four labeled fields:

- **Phase** — which phase was running.
- **Trigger** — what the walk was doing, and the name of the item it was on.
- **Improvement** — the proposed change, concrete enough that a later reader who was not there can file it.
- **User words** — the exact quote when the user said something; `(none — assistant observation)` when it was your own idea.

```markdown
## 2026-08-31

- Phase: Recurring Review / one-shot due. Trigger: item "Renew passport" (Workflowy ⏰ bucket). Improvement: show the note's first line inline in the question instead of only the URL. User words: "I can't tell what this is without clicking through."
```

Append with `printf '%s\n' ... >>` or a heredoc — never rewrite the file — and present the next item in the same turn. `/gtd:meta-feedback-prep` reads this file as a first-class candidate source alongside the transcripts and archives it once its candidates are staged, so nothing written here is lost and nothing has to be remembered.

This is the same ban as [Never offer to pause or wrap up](#never-offer-to-pause-or-wrap-up) and `due-item-walk.md`'s "Never ask how to scope the walk", applied to ideas instead of volume: an improvement is not new information the user needs to rule on now, and the only correct next move is the next item. A design poll mid-walk ("want me to change how this phase works?") is the same forbidden question wearing a suggestion.

## A phase summary never ends the turn

A phase's summary, briefing, or opened page is not a stopping point. After it, start the next phase in the same turn. The user does not notice console output unless something else stops the turn, so a turn that ends on a summary stalls the review with nothing asking for their input. The turn ends only on an `AskUserQuestion`, a halt the rules here call for, or the final summary.

## Never offer to pause or wrap up

The review runs every phase to completion. Only a verified failure halts it, and only the user may choose to stop. Never raise the length of the run as a question, in any phrasing:

- "This session has run very long — continue or wrap up?"
- "There are N items left. Continue or pause?"
- "Do you want me to continue the last phases now, or finish this tomorrow?"
- "We're deep into the context budget — should I stop here?"
- any variant that offers to defer, postpone, or skip remaining phases, or that asks about elapsed time, item volume, session length, or context/usage budget.

These questions read as trying to skip steps. The user has already asked for the whole review by invoking it; volume is not new information they need to rule on. Keep working and let them interrupt if they want to stop. This applies to every phase, not just the recurring walk — `daily/due.md` bans the same openers inside its item loop.

## Never work around a failure

When a step fails (a command errors, a script exits non-zero, an MCP is down, a network call hangs, or the data cannot be verified as fresh), retry once or twice when that is reasonable. If it still fails, stop and surface the failure, then ask the user whether to fix it or explicitly skip it. An iMCP outage is the one case with a fixed answer: follow the halt rule in `${CLAUDE_PLUGIN_ROOT}/skills/imcp-recovery.md`, since only the user's `/mcp` can reconnect it. Do not:

- work around it by running sub-steps yourself (e.g. the recipe failed, so you run `import-api` by hand),
- proceed on a stale, partial, or degraded cache/dataset,
- treat "the process exited" or "exit code 0" as success. A piped `… | tail` reports tail's exit code, not the command's, and a process can exit 0 having synced nothing. Verify the actual result, never a proxy for it.

Continuing requires positive verification. Pressing on with degraded data corrupts every downstream step: a stale cache makes refinement skip the newest entries, dedup re-propose handled items, and dates advance on work that never happened. A stopped review the user can re-run is better than a completed one built on bad data.

### The import barrier must be verified

The `Import` barrier exists so the whole fan-out reads today's data. Before any prep fan-out:

- Run the import **without masking its exit code**. Do not pipe the barrier command through `tail`/`head` — redirect its output to a file, check `$?` on the unpiped command, then read the file. `${PIPESTATUS[0]}` is bash-only and expands to the empty string under this project's zsh, so it masks the very failure it is meant to catch (zsh's equivalent is the 1-indexed `${pipestatus[1]}`).
- **Positively verify the live API sync landed:** `cache import-api` printed its `Fetched N nodes … / +A added, ~U updated, =… unchanged, -D deleted` summary, the node count is sane, and today's data is actually present (e.g. today's calendar date node exists). Exit code alone is insufficient.
- If the import errored, stopped responding, or cannot be verified, stop — do not fan out on a stale cache. Fix the cause (or ask the user to) and re-run the barrier from the top.

## Automated Tasks

Run the mandatory import barrier, then execute due tasks from `Personal > 🔄 Review > 🔄 Daily Review > LLM Tasks:`. The tree is a dependency DAG: prep work fans out, serial groups preserve write ordering, and presentation follows a fixed order.

### Fetch and validate the plan

```bash
mkdir -p .llm/gtd/review
date -u +%Y-%m-%dT%H:%M:%SZ > .llm/gtd/review/run-started.txt
./bin/run.js node get --path "Personal,🔄 Review,🔄 Daily Review,LLM Tasks:" --depth 12 --json --fields name,note,shortId,id,children,completedAt > .llm/gtd/review/phase0-llm-tasks.json
node ${CLAUDE_PLUGIN_ROOT}/scripts/compute-llm-dag.mts .llm/gtd/review/phase0-llm-tasks.json --files-dir .llm/gtd/review/scripts > .llm/gtd/review/phase0-plan.json
```

The planner validates this plain structure before anything fans out:

```text
LLM Tasks:
  Import
  Prep
    Scan email for events <time...>
      /gtd:email-calendar-prep
      Interval: 7d
    Birthdays <time...>
      /gtd:birthdays-prep
    Serial: group name
      Otter journal <time...>
        /gtd:otter-journal-auto
        Auto
      Refine calendar journal <time...>
        /gtd:refine-journal-prep
  Presentation
    Scan email for events
      /gtd:email-calendar-apply
    Birthdays
      /gtd:birthdays-apply
    Refine calendar journal
      /gtd:refine-journal-apply
```

Prep and presentation pair by their identical date-stripped task names. The planner infers the artifact slug from the prep command by removing a trailing `-prep` or `-auto`; `/gtd:email-calendar-prep` therefore stages `email-calendar`. A prep task with no plugin command is inline: its children are the instructions, and its slug is the kebab-case of its name, so `Daily disk cleanup` stages `daily-disk-cleanup`. A `File: <name>` child holds a script in its note; the planner writes every one verbatim to `.llm/gtd/review/scripts/<name>` before anything runs, and instructions run it from there. `Interval` is optional and defaults to `1d`; supported units are `d`, `m`, and `y`. `Auto` is only for prep tasks that have no presentation entry. Presentation inherits its due state, slug, and interval from prep, so it carries no date. Placement already identifies prep versus presentation; `Key:`, `#llm-task`, `· prep`, `· apply`, marker emoji, and duplicate dates are invalid clutter.

The planner rejects unexpected root children, obsolete `Key:` markers, duplicate or unmatched task names, duplicate inferred slugs, invalid intervals, missing prep dates, dates on presentation tasks, and presentation entries for auto tasks. Any validation error halts the review.

Tasks elsewhere in `Personal > 🔄 Review` remain recurring-review tasks and use their section's cadence. They are not part of this DAG.

### Present the due plan

List every due prep task and its inherited presentation entry from `phase0-plan.json` before execution. Show the human name, instructions, Workflowy link, whether it is auto, and whether its branch is parallel or serial. Show the import barrier as done.

**Do not ask whether to skip anything — print the plan and start executing.** The listing above is the plan-visibility moment, not a gate. Every due task runs by default; the user reads the plan while the branches are already in flight and interjects if they want one dropped. When they do, skipping a prep task also skips its name-matched presentation, and auto tasks and the import barrier are mandatory and never skippable. If no tasks are due, say so and continue.

### Execute the plan

Follow `${CLAUDE_PLUGIN_ROOT}/skills/dag-llm-tasks.md` and `${CLAUDE_PLUGIN_ROOT}/skills/review-proposal-staging.md`:

- Run metadata sync once.
- Dispatch each `parallel` prep branch independently and each `serial` branch through one ordered controller, capped at five concurrent prep units.
- Start the presentation walk as soon as the branches are in flight. Block only for the current task's staged result.
- Treat `status: "empty"` as successful work with no prompt.
- After a paired apply succeeds, run that task's `advance.applyOp` from `phase0-plan.json` verbatim in the background.
- After an auto task succeeds, run its `advance.applyOp` the same way.
- On skip, failure, or unverified work, leave the date unchanged.
- Next dates come from the plan's `planDate` (the import day), not the time the apply runs. If `planDate` no longer matches the local date, re-run the import barrier and recompute the plan before advancing anything.

The executor owns date advancement. Prep, apply, and auto commands never update their own schedule. This keeps one date on the prep node and makes arbitrary intervals deterministic.

Interpret non-marker children as commands or instructions. `/gtd:...` invokes a plugin command; shell commands run in Bash; nested children add detail. `Interval`, `Auto`, and `File:` are markers, not instructions.

Do not create Claude Code built-in tasks (`TaskCreate`, `TaskUpdate`, or `TodoWrite`).

### Handling failures

Never silently skip a task. If a command, MCP, network call, validation, or verification fails, stop and surface the failure. Retry once or twice when reasonable, then ask the user whether to fix it or explicitly skip it. A skipped or failed task keeps its date.

An `otter-journal` error carrying `⚠️ Otter title needs review` flags is resolved with the user one flag at a time, per [Resolve a title flag](otter-journal-auto.md#resolve-a-title-flag). Each answer goes into `.llm/gtd/review/otter-confirmed-titles.json`. Then `/gtd:otter-journal-auto` is rerun, and its scanner creates the entries. When the user confirms a flagged attendee was there, that step also offers to tag them as an Otter speaker.

Drain every background date write before a cache import, before leaving this phase, and before relinking. Follow `${CLAUDE_PLUGIN_ROOT}/skills/review-date-updates.md` for dispatch and verification.

### Summarize

Drain the writes and report applied, skipped, failed, and advanced counts. Fold auto briefing lines from `.llm/gtd/review/briefings/` into the same summary.

## Relink Orphaned Children

Invoke `/gtd:review:daily:relink` — find any children that have accumulated on the GTD bucket navigation links under `Metadata`, diagnose what filed them there, then move them onto the real nodes their links point to. Runs here so it operates on the freshly-imported cache, and before the phases that assume tasks sit on the real roots.

Zero orphans is the expected result and prints nothing. **A non-zero count is a bug report, not a chore** — something upstream resolved a destination to a link node instead of its target. The phase reads each orphan's `createdAt` and provenance _before_ moving it, names the suspected writer, and logs the anomaly durably. Report that finding, not just a moved count.

## Meeting Follow-up Review

Invoke `/gtd:review:daily:meetings` to walk meetings ingested since last review, flag probable follow-ups (especially from direct manager), and drop confirmed items into Inbox.

## Morning Overview

Invoke `/gtd:review:daily:overview` — morning orientation (calendar, reminders, next actions, inbox), rendered as an HTML page and opened in the browser, never printed to the console. Continue into Distribute Project Tasks in the same turn.

## Distribute Project Tasks

Invoke `/gtd:review:daily:distribute` — match Inbox and `📌 Tasks (asap)` tasks to the projects under `Metadata > 📂 Project Directories`, confirm each one as its own question, append the accepted ones as self-contained tasks to `<project>/.llm/todo.md`, and open a labelled herdr tab in each receiving project that has no pane open.

**This phase runs before Rebalance Ladders and Process Inbox, and the order matters.** A distributed task leaves the ladder or the Inbox, so rebalance computes caps on the tasks that stay and refinement never spends effort on an item headed to disk. Silent when no task matches a project.

## Rebalance Ladders

Invoke `/gtd:review:daily:rebalance` — print tiers `1st` and `2nd` of both `📌 Tasks (asap)` ladders as today's goals, then propose the moves that bring each ladder back into shape: push-downs out of tiers over their `2^k` cap, pull-ups into an empty `2nd` (and `3rd`) from the tier below, and a new bottom tier once the landing zone passes `2^k`. **Every move is a proposal the user confirms** — nothing is demoted, promoted, or split automatically, and the items that leave a tier are the ones the user names, never the bottom-most ones.

**This phase runs here, and the order matters.** Process Inbox, File Loose Tasks, and the due walk all put new items onto the ladder, and filing never moves any other item, so a tier the user files into while full simply runs over cap. Rebalancing before them hands them a ladder whose occupancy readouts mean something; anything they push over cap waits for the user at the next rebalance. Silent when both ladders are already in shape, apart from printing the day plan.

## Process Inbox

Invoke `/gtd:refine-inbox`, then `/gtd:inbox` — refine each inbox item with a 🔍 Refinement suggestion, then walk the confirm-and-move loop that files them to their GTD destinations. Runs here because the Meeting Follow-up phase just dropped confirmed follow-ups into Inbox and nothing else in the review would ever pick them up. Filing them now means anything that lands with a date reaches the due walk in this same run. Silent-skip when all inboxes are empty.

## File Loose Tasks

Invoke `/gtd:review:daily:file-tasks` — normalize the Next-Actions trees, then sweep loose tasks under both roots (Work and Personal) into the `⏰ Tasks (due dates)` bucket or a priority tier of the `📌 Tasks (asap)` ladder, and sweep undated Things "Anytime" tasks into the personal ladder. Proposes a destination per task and walks them one at a time for confirmation. Relink already ran, so strays are on the real roots; silent-skip when no loose tasks and no Anytime backlog remain.

## Clean Up Completed

Invoke `/gtd:review:daily:cleanup-completed` — walk the 12 oldest completed items still sitting under the `✅ Tasks` wrapper of both roots (the rest wait for later runs) and ask, one question each, whether to journal it (un-complete it and move it into the root's `📅 Calendar` on its completion date), delete it permanently, or leave it. Nothing is changed unasked, and delete is never the promoted answer.

Runs after File Loose Tasks so the trees are normalized, and before Group Tasks so completed clutter never lands in a cluster. Silent when nothing is completed.

## Group Related Tasks

Invoke `/gtd:review:daily:group-tasks` — cluster the open tasks on each root's ladder by theme, match each cluster against existing project nodes, and walk every proposed grouping as its own question. A new group lands in the highest tier any member came from, with its children ordered by the tier they came from; a cluster that matches a project in flight moves under that project instead. Topics sitting both in `📋 Meeting agendas` and on the ladder are flagged as duplicates. The private grouping vocabulary lives in the gitignored `.llm/gtd/task-groups.md`.

Runs right after File Loose Tasks so nothing loose is left out of the clusters. Dated tasks in the `⏰` buckets are shown as related but never moved, because the due walk reads only the buckets' direct children. Silent when nothing clusters and nothing duplicates.

## Recurring Review

Invoke `/gtd:review:daily:due` — two segments walked back to back: overdue recurring review items in `Personal > 🔄 Review`, then one-shot due tasks merged from the Workflowy `⏰` buckets, Things 3, and Apple Reminders. The command fetches every source, Apple Reminders through iMCP included, before its first question, so an iMCP outage halts at the top of the phase rather than after the recurring walk.

**This phase runs after every producer, and the order matters.** File Loose Tasks and Process Inbox are both _producers_ of dated tasks — filing something as due today must be followed by the walk that asks whether it's done, not preceded by it. Running the walk earlier would hide everything the earlier phases just created for a full day.

**Note:** LLM tasks already processed in the LLM Tasks phase will have updated dates and won't appear as overdue here.

## Skipped Today

List every item skipped during this run on one decision page, so the user can check off the ones they have since done. Saying "did it" item by item during the walk takes too long; this page is where those answers land. The run start was written to `.llm/gtd/review/run-started.txt` at the top of the review (see [Fetch and validate the plan](#fetch-and-validate-the-plan)).

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/stage-skipped-page.mts --run-started "$(cat .llm/gtd/review/run-started.txt)" \
  > .llm/gtd/review/skipped-today.json
```

The script reads `.llm/gtd/review/skip-log.jsonl` for keys whose last outcome since the run start is `skip`, so an item skipped and then handled later in the run is left out. Rows Claude runs itself (`#llm-task`, or `missingLlmTag`) are left out too: a skip there means the task was blocked, not that the user owes it, so the page never asks the user about them. It looks each key up in the staged `overdue.json` and `due-items.json`, stages one card per item at `.llm/gtd/review/decisions/skipped-<date>.json` with **Did it** and **Still skipped**, and prints `{slug, items}`. Each manifest item carries its skip-log key, title, `segment` (`recurring`, `due`, or `null` for a key with no staged row), `source`, and the staged `done` command. Silent-skip when `items` is empty: the script writes no page.

Show the page per **Decision page** in `${CLAUDE_PLUGIN_ROOT}/skills/review-proposal-staging.md`: put the URL from `decision-page.mts url <slug>` in the `AskUserQuestion`, wait for the user to say they submitted, then read `decision-page.mts answers <slug>`.

- **Did it** — apply the same Done logic as the walk, per `${CLAUDE_PLUGIN_ROOT}/skills/due-item-walk.md`. Read the subtree first. A recurring item runs its manifest `done` (the row's `applyOp`) verbatim to advance its date; a `null` `done` means the row needs an interval, so ask for one as the recurring walk does. A due item runs its `done` (`ops.complete`) verbatim; batch Apple Reminders writes as `daily/due.md` requires. A `null` segment has no staged row, so look the item up and confirm with the user before writing. Verify each write, then record `done` with `compute-overdue.mts --record <key> --outcome done` so the skip streak resets.
- **Still skipped** or unanswered — write nothing and record nothing; the skip is already in the log and the item resurfaces next run.
- A note that changes the answer (a reschedule, a drop) — apply that outcome as the walk would, and record its outcome instead.

Runs after Recurring Review because that is where skips are recorded, and before Work Together so items marked done here are not offered as work.

## Work Together

Invoke `/gtd:review:daily:work-together` — with the ladders ranked and the dated items walked, offer to do real work on what is left, in three categories: items overdue, due now, or due within the week; the `1st` tier of both asap ladders; and items this run filed while their context is still fresh. Each candidate comes with the concrete help on offer (draft the email, write the code in its project directory, research the question) and is its own question. Accepted items are worked on the spot, one at a time.

**This phase runs last, and the order matters.** It needs the Recurring Review's and Skipped Today's handled outcomes so it never offers help on something the user just said is done, and the rebalanced `1st` tier so the ranking it reads is today's. Silent when no candidate has help Claude can actually give.

## No "remember to" loose ends in the final summary

The final summary reports only what happened. It never hands the user a list of things to remember, check later, or follow up on (unread agent reports, a stuck recording, an untagged speaker, a photo to delete, tomorrow's recurring items).

Before the final summary, resolve every open loose end one of two ways:

- Walk it with the user now, one `AskUserQuestion` per item.
- File it as a Workflowy task with a link to the relevant node and enough context to act on cold.

A loose end that is neither walked nor filed is not allowed to reach the summary. This is the same style as [Never offer to pause or wrap up](#never-offer-to-pause-or-wrap-up): the review closes everything it opened.
