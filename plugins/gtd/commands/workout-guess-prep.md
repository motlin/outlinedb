---
name: workout-guess-prep
description: 'Prep half of the workout guess — learn the program episode order from the #exercise history in Personal > 📅 Calendar, guess the workout for today and every earlier unlogged day since the last one, and stage them to .llm/gtd/review/proposals/workout-guess.json. Autonomous only; mutates no nodes and does not advance state.'
---

# Workout Guess — Prep

Guess the workout journal entries the user has not logged yet, and **stage** them for `/gtd:workout-guess-apply`. The user works through structured programs (program hashtag, phase, week, day, workout name) one session per day, so the next session is predictable from their own history. Stage proposals to `.llm/gtd/review/proposals/workout-guess.json` per `${CLAUDE_PLUGIN_ROOT}/skills/review-proposal-staging.md`, then stop.

## Prep contract (read this first)

This command runs inside a Phase 0 prep subagent:

- **Autonomous only.** Never call `AskUserQuestion` / `TaskCreate` / `TaskUpdate` / `TodoWrite`. A day the script cannot predict is staged as an `ambiguity` proposal, never asked here.
- **No node mutation.** Make **zero** `node create` / `node update` calls. The only output is the staged JSON file under `.llm/gtd/review/`.
- **No state advance.** Do not advance the task's review date; the DAG executor owns scheduling.
- **`--dry-run`** is a no-op that still stages; prep already makes no writes.

## Why it runs after the calendar journal refinements

Place it last in `Serial: Calendar journal`, after `Refine #exercise` when that task exists, otherwise after `Refine calendar journal`. Otter and journal ingestion can create the day's entries first, so a workout logged by an earlier task in the chain is seen and not re-guessed. Staged rewrites from those tasks are not applied yet, but the guesser parses raw text, so an unformatted entry with workout details still counts as logged.

## Load the personal format spec

Program names, hashtag casing, and the canonical line shape are personal and live in the gitignored `.llm/gtd/exercise-formats.md`, never in this plugin:

```bash
cat .llm/gtd/exercise-formats.md
```

From it derive two script arguments:

- `--programs` — the comma-separated program hashtags the spec lists, in its casing (`'#ProgramX,#ProgramY'`). Only entries for these programs count as sessions, and their casing wins.
- `--template` — the spec's canonical line rewritten with placeholders `{program}`, `{phase}`, `{week}`, `{day}`, and `{workout}`. Wrap each structured field with its separator in `[...]` so a program or pass that does not record that field drops it. A spec line `💪 #ProgramX phase X, week Y, day Z, Workout Name #exercise` becomes `'💪 {program} [phase {phase}, ][week {week}, ][day {day}, ]{workout} #exercise'`.

If the file is missing or lists no programs, stage `status: "empty"` with `summary.lastLogged: null` and stop. Never invent a format.

## Load the exercise hashtags from metadata

The user also jumps to programs the spec does not list. Every exercise hashtag already in Workflowy metadata (each `🎮 Hobbies Registry` entry whose name carries `#exercise`, current or archived) marks its day as logged, so such a day gets no guess. Read the cached registry; the DAG's `metadata-sync` has already refreshed it:

```bash
jq -r '[.. | objects | select(.name? and (.name | type == "string") and (.name | test("#exercise\\b"; "i")))
  | .name | gsub("<[^>]+>"; "") | capture("(?<tag>#[A-Za-z0-9][\\w-]*)").tag
  | select(ascii_downcase != "#exercise")] | unique | join(",")' .llm/gtd/metadata/hobbies-registry.json
```

Pass the result as `--exercise-tags`. If the registry is missing, pass an empty string; the `--programs` tags and `#exercise` still count.

## Export the calendar tree

History spans the live calendar and its `🗃️ Archive` (decade, year, month, day). Export ids, names, and children only, to a file — never into context:

```bash
mkdir -p .llm/gtd/review/proposals
./bin/run.js node get --path "Personal,📅 Calendar" --depth 7 --json --fields id,name,children \
  > .llm/gtd/review/workout-guess-calendar.json
```

## Run the guesser

`${CLAUDE_PLUGIN_ROOT}/scripts/guess-workouts.mts` is the whole algorithm, and it is pure: it reads the export and prints the staged file. Never re-derive or hand-edit its guesses.

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/guess-workouts.mts \
  --tree .llm/gtd/review/workout-guess-calendar.json \
  --today "$(date +%Y-%m-%d)" \
  --programs '<tags from the spec>' \
  --template '<template from the spec>' \
  --exercise-tags '<tags from metadata>' \
  --rest-days .llm/gtd/review/workout-guess-rest-days.json \
  --generated-at "$(date +%Y-%m-%dT%H:%M:%S%z)" \
  > .llm/gtd/review/proposals/workout-guess.json
```

What it does, so the staged output can be explained:

- **Logged days.** An entry carrying a listed program hashtag plus any workout detail (phase, week, day, or a workout name) marks its day as logged.
- **Stubs.** A bare program hashtag with no workout detail (`#ProgramX`, or `💪 #ProgramX #exercise` after refinement) means the user worked out but did not say which workout. Its day is guessed like an unlogged day, and the proposal fills the stub in place with `node update --expect-name` instead of creating a duplicate entry.
- **Sessions.** Every direct child of a day node (or an entry carrying its own `<time>`) that has `#exercise` and a listed program hashtag. Raw formats are tolerated: missing emoji, lowercase tags, colons, trailing periods, spelled-out numbers, Roman-numeral phases, iteration notes, and free-text commentary after the workout name.
- **Unlogged days.** Every day after the last session through today that has no `#exercise`, listed-program, or `--exercise-tags` entry at all and is not in the rest-days ledger. A day with a different `#exercise` entry (a run, say) or any known exercise hashtag (an unlisted program) is logged and gets no guess.
- **Prediction.** The successor most often observed after the last session's slot in earlier history. Failing that, the program structure: the next day of the week, then week + 1 day 1, then the next phase's first day, each only if history has seen it, with the workout name taken from history for that slot. Each later day's guess chains on the previous guess.
- **Ambiguity.** When nothing can be predicted, it stages one `ambiguity` proposal for that day and stops the chain; the later days resurface after the user answers.
- **Cap.** At most `--max-days` (default 7) proposals; `summary.remainingDays` counts the rest.
- **Ops.** Each proposal's `applyOps` is a `node create` under the existing day node, or, when the day node is missing, one nested `node create --json` under `📅 Calendar` that creates the day node (its `<time>` element computed by the script, never hand-typed) with the entry inside. Both use `--position bottom`. `nodeId` is the day node, or the calendar when the day node is created.

## Validate

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/validate-proposal.mts .llm/gtd/review/proposals/workout-guess.json
```

A failure is a script bug: fix the script, never the artifact.

Return a one-line summary (last logged date, unlogged days, proposals staged, status) and stop.
