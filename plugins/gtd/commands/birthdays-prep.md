---
name: birthdays-prep
description: Prep half of the daily birthday and anniversary briefing — match today's relationship dates, roll passed occurrences forward, and stage the unhandled backlog for the apply walk. Autonomous only; never prompts.
---

# Birthdays — Prep

Read people under `Metadata > 👥 People`. Two fields carry a **next-occurrence** date: `🎂 Birthday:` and `💍 Anniversary:`. The year stored in those fields is not the event year — it is when the event next falls. Calculate age from the companion `👶 Date of birth` field and years married from `💒 Married on`. If the companion field is absent, omit the count rather than guessing.

This half never prompts. It stages `.llm/gtd/review/proposals/birthdays.json`; `/gtd:birthdays-apply` presents it.

## Match today by month and day

Match today's events by **month and day only**, ignoring the stored year.

Record every match in one of three arrays:

- `today` — hits for today's month and day, labeled `Today`.
- `imminent` — events 1-3 days out. Each entry carries its ISO `date`, its `weekday`, and a `label`: `Tomorrow` at one day out, the weekday name (`Wed`) at two or three.
- `upcoming` — events 4-14 days out, with their dates.

Apply announces `today` and `imminent` together, first, through `AskUserQuestion`, and leaves `upcoming` as a quieter printed list. The window reaches three days out because the review is often run in the evening rather than the morning, so a milestone falling tomorrow needs same-day prominence or the user reads it for the first time when it is already too late to act. A relationship date read as a buried aside is a date the user missed, which is the failure this whole task exists to prevent.

Write `generatedFor` (the ISO date this briefing describes) into the staged JSON. A long review can cross midnight, and the briefing is only valid for the day it was computed; the apply half compares `generatedFor` against the current date and re-runs this prep when they differ.

## Mark deceased people as remembrances

A person with a `🪦 Date of death` field keeps their birthday and anniversary: it is still an important day, usually for someone close to the user. Keep matching, rolling, and staging those dates exactly as for anyone else, but tag every entry for that person with `"deceased": true` so apply frames it as a remembrance rather than a celebration.

- Phrase the count in the conditional: `"remembrance": "would have turned 74"` for a birthday, `"would have been their 50th anniversary"` for an anniversary. Compute it from `👶 Date of birth` / `💒 Married on` as usual; omit it when the companion field is absent.
- Stage `nextOfKin`: the living people this date matters to, read from the deceased person's `👥 Relationship:` mentions and from people whose `👥 Relationship:` names the deceased (a surviving spouse, a parent, the user's own parent). Skip anyone who also has a `🪦` field. An empty list is fine; never guess.

## Roll passed occurrences forward

A next-occurrence date whose day has passed is stale: it will never match again, and the person silently drops out of the briefing forever. This task **owns** rolling those forward — nothing else does, so a skipped roll-forward leaves fields stale indefinitely.

For every `🎂 Birthday:` and `💍 Anniversary:` field whose stored date is before today, advance it one year and rewrite the `<time>` element with the correct weekday label for the new date. Feb 29 in a non-leap year falls back to Feb 28. Guard each write with `--expect-name` so a hand-edited field is a loud skip, never a silent overwrite:

```bash
./bin/run.js node update --id <full-uuid> --name '🎂 Birthday: <time startYear="2027" startMonth="7" startDay="15">Thu, Jul 15, 2027</time>' --expect-name '<the exact current text>'
```

Roll **after** matching today, so an event happening today is still reported as today before its field moves to next year.

The year rolls are the one exception to this half making no Workflowy writes. Report each one in the staged `autoApplied` list.

## Stage only what this run just rolled

Rolling a date forward is bookkeeping; it does not mean the occasion was handled. Some passed dates still need something from the user — a card that never got mailed, a call never made, a gift outstanding.

**A field whose stored year is already in the future was rolled by an earlier run, and that run already surfaced the occurrence. It is handled. Never stage it.** The rolled-forward year is itself the record of handling — it is the same signal the walk would otherwise ask the user to repeat by hand, one person at a time. Treating "occurred in the last 365 days" as the criterion instead ignores that signal and stages the entire roster as false backlog; that is exactly how a single run produced 68 bogus questions about dates that had all been dealt with.

So an occurrence is unhandled backlog only when **both** hold:

- this run rolled it forward — it appears in this run's `autoApplied` list, meaning the system is seeing the passed date for the first time; and
- it is not already recorded in `.llm/gtd/review/relationship-dates-handled.json`.

When `autoApplied` is empty, `proposals[]` is empty. There is no other path to a non-empty backlog.

Each staged proposal carries the person, the field, the occurrence date, how many days ago it was, the relationship from the `👥 Relationship:` field, and the `deceased` / `remembrance` / `nextOfKin` fields when the person has died — a sibling's anniversary is not a coworker's birthday, and the walk needs that to frame the question.

Order them most recent first.

## Flag stale data

If a next-occurrence field is unparseable, contradicts its companion `👶 Date of birth` / `💒 Married on` field, or is missing on a person who has the companion field, stage it as a data defect rather than guessing a date.

### Resolve estimated years from journal anchors

A `👶 Date of birth` or `💒 Married on` field marked `(birth year est.)` / `(est.)` is usually resolvable, not permanently unknown. The calendar journal records ordinal occasions — "Alice's first birthday", "@Alice 's 6th birthday at the bowling alley" — and each one back-solves the year from the date node it sits under. Two independent anchors agreeing is a confirmation; one is a proposal.

For each person carrying an estimated year, search the journal for their name alongside an ordinal ("first", "1st", "6th", "10th") and read the enclosing date node. When the anchors confirm the stored year, stage a proposal to drop the `(est.)` qualifier. When they contradict it, stage a data defect with both anchors named. Never rewrite the year on a single ambiguous hit.

## Output

Write `.llm/gtd/review/proposals/birthdays.json` per `${CLAUDE_PLUGIN_ROOT}/skills/review-proposal-staging.md`, carrying `generatedFor`, `today`, `imminent`, `upcoming`, `autoApplied`, and `proposals[]`. Then enforce the handled-file rule mechanically, before returning — it was missed once when applied by reading alone:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/filter-handled-relationship-dates.mts .llm/gtd/review/proposals/birthdays.json
```

It drops every proposal whose `<person>:<field>:<occurrence>` key is already in `.llm/gtd/review/relationship-dates-handled.json` under any decision (`still-owed` counts), rewrites the file in place, and prints each dropped key. If it empties `proposals[]` and nothing else remains, restage as `empty`. Stage `empty` only when nothing matches today, nothing is imminent, nothing needed rolling, and no unhandled dates remain. Return verified success or empty; return failure on unreadable or malformed source data. Never update the task's own schedule date — the DAG executor owns that.
