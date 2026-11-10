---
description: Reference for validating and executing the daily review's prep and presentation DAG, including inferred task identity, inherited scheduling, parallel and serial prep, auto tasks, and shared-state safeguards.
globs: ${CLAUDE_PLUGIN_ROOT}/commands/review/**
---

# DAG LLM Tasks

The daily review executes `Personal > 🔄 Review > 🔄 Daily Review > LLM Tasks:` as a dependency DAG. Tree placement defines execution phase, identical task names link prep work to presentation, and optional markers add only the information that placement cannot express.

## Canonical tree

```text
LLM Tasks:
  Import
    op run -- just daily
    ./bin/run.js cache sync-node --id <full-uuid> --recursive
    otter-api.sh warm-credentials
  Prep
    Serial: Calendar journal
      Otter journal <time...>
        /gtd:otter-journal-auto
        Auto
      Refine calendar journal <time...>
        /gtd:refine-journal-prep
    Process inbox <time...>
      /gtd:refine-inbox
    Time Machine exclusions <time...>
      /gtd:time-machine-exclusions-prep
  Presentation
    Refine calendar journal
      /gtd:refine-journal-apply
    Process inbox
      /gtd:inbox
    Time Machine exclusions
      /gtd:time-machine-exclusions-apply
```

The schema is strict:

- Root children are exactly `Import`, `Prep`, and `Presentation`.
- Every prep task has one `<time>` element and at most one plugin command. A task with no plugin command is inline: its child nodes are the whole instructions, scripts included as `code` text. Personal tasks belong inline in Workflowy, not as plugin commands.
- A paired presentation task has the identical date-stripped name and no date.
- The prep command supplies the artifact slug after removing a trailing `-prep` or `-auto`; an inline task's slug is the kebab-case of its name. Presentation inherits that slug.
- `Interval: <amount><unit>` is optional on prep and defaults to `1d`; units are `d`, `m`, and `y`.
- `File: <name>` on any task holds a script, its note being the exact file content. File names are unique across the tree; the planner writes each to `.llm/gtd/review/scripts/<name>` (executable) when run with `--files-dir`.
- `Auto` marks prep that completes without presentation. Auto task names must not appear under `Presentation`.
- `Serial: <name>` groups prep tasks that must run top-to-bottom. Other direct children of `Prep` are independent parallel branches.
- Do not add `Key:`, `#llm-task`, `prep`, `apply`, or marker emoji to task names or children; names, commands, placement, and optional markers already carry that information.

Run `${CLAUDE_PLUGIN_ROOT}/scripts/compute-llm-dag.mts` before execution. Its output is the authoritative `.llm/gtd/review/phase0-plan.json`; validation failure halts the review.

## Scheduling

Only prep nodes own schedules. The planner runs right after the import barrier, so its `planDate` is the import day. It compares each prep date to `planDate`, includes the linked presentation entry when prep is due, and precomputes the next date from `planDate` plus the task interval.

After verified success, the main executor runs the task's `advance.applyOp` from the plan verbatim. Task commands never advance their own date. Empty prep is successful; skipped, failed, and unverified work leaves the date unchanged.

Next dates come from `planDate`, never from the wall clock at apply time. A review session can stay open for hours or resume the next day, and a date taken from the clock would then skip past work whose data was fetched earlier. Never recompute a next date by hand.

Before running any `advance.applyOp`, compare the plan's `planDate` to the local date. When they differ, the session resumed on a later day and the fetched data is stale: re-run the import barrier, refetch the LLM Tasks tree, and recompute `phase0-plan.json` before advancing anything. Tasks already advanced drop out of the new plan as `future`; the remaining tasks get fresh prep against the new import.

This central ownership prevents prep and presentation dates from drifting and supports daily, weekly, monthly, and yearly prep/apply tasks with the same mechanism.

## Import barrier

Run every instruction under `Import` inline. Do not pipe the commands through `head` or `tail`. Confirm the API import reports its fetched and changed node counts and verify current data is present. Drain pending background writes before the import and before prep fan-out.

If freshness cannot be positively verified, halt.

## Prep fan-out

Before dispatching anything:

- First, list all running background agents.
- Then stop every prep controller left over from an earlier or aborted fan-out. Treat a controller that stops answering a status ping as still running until it is actually stopped.
- Finally, verify that no earlier prep controller remains, then dispatch the new set.

A restarted review otherwise stacks new controllers on top of live ones: the five-in-flight cap stops being real, and a controller presumed stuck can wake up hours later and overwrite the artifact a retry already staged — silently replacing the proposals the walk is mid-way through presenting.

Run metadata sync once before fan-out. Prep workers read the resulting `.llm/gtd/metadata/` cache and never rebuild it concurrently.

Dispatch one background controller per due branch from the plan:

- A `parallel` branch contains one independent task.
- A `serial` branch runs its due tasks in tree order, waiting for each before starting the next.
- Keep at most five prep controllers in flight.

**A subagent cannot answer a credential prompt, so prep workers must not invoke `op` at all.** Every credential the fan-out needs is resolved by the foreground import barrier — `op run -- just daily` for the `.envrc` refs, `otter-api.sh warm-credentials` for the Otter login — and prep workers read the resulting caches. This is the fix for two distinct prompts a background `op` call raises: a Claude Code permission prompt (the wrapped `timeout 90 op run -- …` form does not match an `op run -- …` allowlist rule, because prefix matching sees `timeout` first) and a 1Password desktop authorization prompt the user never sees. Unbounded, the latter blocks — the Otter scanner hung 22 minutes on it in one run, reported nothing, and had to be killed.

If a worker genuinely cannot avoid `op`, that is a gap in the barrier: fix the barrier to warm the credential rather than calling `op` from the subagent. Any such call that does remain must be wrapped in `timeout` (90s is enough once the barrier has warmed authorization); on timeout the worker returns a failure naming the credential, never retries silently, and the executor surfaces it rather than treating the branch as slow.

The rule covers **every `op` subcommand, not just `op run`** — `op read` raises the same authorization prompt and blocks the same way, and a rule phrased only as "wrap `op run`" does not match what a script like `otter-api.sh` actually executes. Prefer an in-script guard over caller discipline: a timeout inside the script holds no matter who invokes it, whereas a caller-side rule protects only the callers that remember it.

Each prep worker is autonomous, never prompts, and stages `.llm/gtd/review/proposals/<slug>.json`. Auto workers complete their autonomous work and stage `.llm/gtd/review/briefings/<slug>.json`.

## Presentation walk

Begin presentation as soon as prep controllers are running. Walk the plan's presentation array in order and wait only for the current task's staged result. Later slow work must not delay an earlier ready task.

Apply commands read their staged result and return one of:

- success: work is verified; the executor dispatches the task's date operation.
- empty: nothing needed attention; the executor dispatches the date operation without prompting.
- skipped: the user deferred the work; the date stays unchanged.
- failure: work or verification failed; halt and leave the date unchanged.

Continue reaping prep controllers and background date writes throughout the walk.

## Shared-state safeguards

- Run metadata sync once; prep workers only read it.
- Drain every pending write before an import or cache rewrite.
- Serialize tasks that write the same Workflowy subtree.
- Keep parallel branches on distinct write targets.
- Use the plan's presentation order, never completion race order.
- Report a pending task and elapsed time when its prep delays presentation.
- Fetch only required fields and redirect deep trees to `.llm/` rather than placing them in agent context.

## Completion

Drain prep controllers and every date write before relinking. Surface failures by task name. Summarize applied, empty, skipped, failed, and advanced tasks, then append auto briefing lines.
