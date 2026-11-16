---
name: refine-journal-apply
description: Apply staged journal refinements, then advance refine-journal Scanner-State and return a verified result to the daily-review scheduler.
---

# Refine Journal — Apply

The interactive half of the journal refinement split. It reads what `refine-journal-prep` staged and walks the user through confirmations — no matching rules live here. Mirrors how `inbox` applies the `🔍` suggestions that `refine-inbox` wrote.

## Prerequisite

Run `/gtd:refine-journal-prep` first (in the daily review it runs automatically as a Phase 0 prep subagent). It stages `.llm/gtd/review/proposals/refine-journal.json`.

## Do not use the built-in task list

Track progress through `.llm/` files, Workflowy nodes, and inline status updates. Do **not** create Claude Code built-in tasks (`TaskCreate` / `TaskUpdate` / `TodoWrite`) to mirror per-entry work. (This command advances a Workflowy `Scanner State` node, not the built-in list.) Launching subagents via the `Agent` tool is unrelated and fine.

## Run the shared apply routine

Follow the **Shared Apply Routine** in `${CLAUDE_PLUGIN_ROOT}/skills/review-proposal-staging.md` for slug `refine-journal` — read the staged file, branch on `status`, batch-present `proposals[]` in batches of up to 4 via `AskUserQuestion`, and apply each batch's accepted `applyOps` verbatim before presenting the next. The skill is authoritative for the presentation format, the Accept / Reject / Accept-with-note options, ambiguity handling, and shell escaping. Two refine-journal specifics:

- On `status: "empty"`, still advance Scanner-State, then return empty. The DAG executor advances the prep date.
- On `status: "needs-interactive"`, run the full interactive refinement inline, then advance state and return success after verification.
- On `status: "error"`, surface the error and return failure.

### Recent first, then ask before the archive block

Each proposal carries a `scope` (`"recent"` or `"archive"`). In recent mode — which is what the daily review always runs — prep stages no archive proposals at all, so the walk is just the recent block. Archive proposals appear only from an explicit standalone archive-mode run.

- **Recent block.** Present every `scope: "recent"` proposal (batches of 4), applying accepted ops as usual.
- **Archive gate.** If any `scope: "archive"` proposals are present, ask once via a single `AskUserQuestion` whether to refine the `N` archive entries from `summary.archiveMonth` now (options: do them now / skip the archive this run). Put the month and count in the question text.
    - **Accepted** → present the archive block (batches of 4) and apply as usual, then advance the archive cursor in Scanner-State (below).
    - **Skipped** → make no archive writes and **do not** advance the archive cursor (`months_completed` / `last_completed_month` / `current_month_in_progress` stay put) so the same month is offered again next run. Still record recent-live coverage and return success.

If the staged proposals carry no `scope` (older prep output), treat them all as `recent` for backward compatibility.

### Long blocks go on a decision page

When a block (recent or archive) holds more than 8 proposals, present it on the decision page instead of `AskUserQuestion` batches (see **Decision page** in `review-proposal-staging.md`). Never hand-build the page with inline `jq`; the checked-in generator stages it and maps the answers back:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/stage-refine-journal-page.mts stage --scope recent   # or --scope archive
node ${CLAUDE_PLUGIN_ROOT}/scripts/decision-page.mts url <slug>
```

`stage` prints `{slug, ids}`. Each card shows the rewrite as a diff under a short title (`<date>: <change kinds>`), the change notes as body lines, and either Accept / Keep as written or the `ambiguity` options (the staged pick first, alternate emoji or people after it). Put the URL in the `AskUserQuestion` that tells the user to open the page, and wait until they say they submitted. Then resolve the answers:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/stage-refine-journal-page.mts resolve --slug <slug>
```

It prints `{apply, declined, followUp, unanswered}`:

- **`apply`** — run each card's `ops` verbatim; a `--expect-name` refusal is a stale skip as usual.
- **`declined`** — append these rows to the decline ledger as-is (they already carry `declinedAt`).
- **`followUp`** — answers with a note, or options that stage no text. Settle each via `AskUserQuestion` (Accept with note, a vocabulary explanation, or the exact wording), building any op with `--expect-name '<before>'`.
- **`unanswered`** — ask about each in a follow-up question; never guess.

### Offer vocabulary persistence for intentional terms

Follow **Remember explanations in the matching reference file** in `${CLAUDE_PLUGIN_ROOT}/skills/refinement-text-rules.md` when a user explains a flagged phrase. For a non-people term, explicitly offer **Keep as written and add to journal-vocabulary.md** or **Keep as written without saving vocabulary**, showing the exact proposed entry and destination in the question. An explanation in "Other" needs this follow-up too. Save only the approved vocabulary entry; reserve `people-disambiguation.md` for people's names, homonyms, and name spellings. Both keep choices reject the rewrite and enter the rejection ledger below, without the explanation. If an approved vocabulary write fails, report the failure rather than claiming it was saved.

### Offer to record vocabulary emoji picks

After the user answers a ⚠️ emoji picker for an entry that names a holiday, observance, religious or community event, class, ceremony, or place, offer once via `AskUserQuestion` to record the emoji pick in the emoji table of `.llm/gtd/journal-vocabulary.md` so the next matching entry gets it without a picker. Show the exact proposed row (term, emoji, today's date) in the question, with options to save it or skip saving. Skip the offer when the term already has a row. Keep every term and emoji in that gitignored file, never in `plugins/`. If the write fails, report the failure rather than claiming it was saved.

### Record every Reject in the decline ledger

A rejected refinement must never come back — the user should not have to say "keep as written" twice for the same entry. Model this on the email-calendar decisions ledger: every explicit rejection is persisted, and prep drops anything already recorded.

- **Where.** `.llm/gtd/review/refine-journal-declined.json` — a JSON array; create it as `[]` if it does not exist.
- **What counts as a Reject.** The **Reject** option on a normal proposal; the **Skip** option on a people-style ambiguity; and, on an emoji picker, an "Other" answer that is not an emoji but a keep-it-as-is instruction ("keep as written", "no emoji", "skip"). Accept, Accept with note, and a chosen emoji are not rejections and are never recorded.
- **What to append.** One `{nodeId, before, after, declinedAt}` object per rejected proposal: the proposal's full `nodeId` (full UUID), its full `before` text byte-for-byte (U+00A0 included — prep matches it against live text), its staged `after` (or `null` for an emoji picker, which stages no single `after`), and an ISO-8601 timestamp with offset. Never truncate `before` or `after`. Keep this schema unchanged: do not add the user's explanation, rationale, term definition, or vocabulary metadata.
- **When.** Append right after each batch's answers, alongside running that batch's accepted `applyOps` — not at the end — so an aborted walk still keeps the rejections it collected.
- **Ledger-write failure** is a run failure: surface it and return failure rather than finishing with a rejection unrecorded.

A stale skip (`--expect-name` mismatch) is **not** a rejection — do not record it; it resurfaces next run against fresh text.

### Presentation fidelity

- **Never truncate.** Every confirmation (a question or a decision-page diff) must show the **complete** `before` and `after` text, not an edits-only diff or an abbreviated snippet — the user cannot judge a change out of context.
- **Media lookups.** For any watched-media (📺 / 🎬 / `#watched`) proposal, look up the show/movie's actual season number, episode number, and title via web search and present the full enriched `after` (`SxxEyy "Title"`, straight quotes) for confirmation — do this consistently, not only when the entry looks ambiguous.
- **Decode HTML entities** (`&quot;`→`"`, `&amp;`→`&`, `&#39;`→`'`) and never introduce curly/smart quotes when composing or editing the `after`.

## Advance progress (apply only)

After the last batch, advance task-specific tracking. This happens only here, never in prep, so an aborted prep never skips a month:

- **Scanner-State** under `Metadata > ⚙️ Scanner State > refine-journal`: read the JSON child, then:
    - **Recent-live coverage — always.** Record `recent_live_months_reviewed`, `recent_live_reviewed_at` (use staged `generatedAt`), and `recent_live_entries_reviewed` (from `summary.recentLiveEntriesReviewed`). This happens whether or not the archive block ran, because the recent window was always presented. Do **not** add current/prior live months to `months_completed`; that array is only the backwards archive cursor.
    - **Archive cursor — only if the archive block was accepted and applied.** If the user accepted the archive gate, add `summary.archiveMonth` to `months_completed`, set `last_completed_month` to it, clear `current_month_in_progress`, and bump `total_entries_updated` by the number applied. If the archive block was skipped (or there were no archive proposals), leave the archive cursor untouched so the month resurfaces next run.
    - Write the compact single-line JSON back via the CLI.

Return success or empty after Scanner-State is persisted. The DAG executor owns the review date.

## Summary

Output a brief summary folded into the daily review:

- Archive month applied (archive mode only)
- Recent live months reviewed
- Total entries reviewed (from `summary.entriesReviewed`)
- Total entries updated / rejected (recorded to the decline ledger) / stale-skipped
- Breakdown by change type (people tags added, hobbies tagged, typos fixed, emojis added)

## Idempotency

A re-run after a completed apply reads `status: "empty"` (prep found nothing new) and skips without re-applying. Never run the same `applyOps` twice.
