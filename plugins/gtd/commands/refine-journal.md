---
name: refine-journal
description: Refine calendar journal entries (people, hobby, category, typo, emoji tags) in the recent live months, with archive backfill on request. Standalone wrapper that chains the prep and apply halves. Use when the user wants to refine, tag, or clean up their calendar journal / past activity log outside the daily review.
---

# Refine Journal

This command chains two halves, so the daily review's Phase 0 DAG can run the autonomous compute in parallel and defer the interactive confirmation:

- **`/gtd:refine-journal-prep`** — load metadata, scan the recent live window (current and prior calendar month, plus one archive month in archive mode), compute people/hobby/category/typo/emoji refinements, and stage them to `.llm/gtd/review/proposals/refine-journal.json`. Mutates no nodes; does not advance Scanner-State.
- **`/gtd:refine-journal-apply`** — read the staged file, walk the batches-of-4 confirmation loop, apply accepted updates, and advance Scanner-State. The daily-review executor owns scheduling.

For a standalone manual run, invoke them in order: run `/gtd:refine-journal-prep`, then `/gtd:refine-journal-apply`.

## Archive backfill is opt-in, and this is where you ask for it

Prep defaults to **recent mode** — the current and prior live calendar months only. The backwards archive walk runs only when the invocation asks for it, and the daily review never does; almost every archive proposal was "this old entry lacks a leading emoji", which buried the handful of real fixes on recent entries.

To backfill history, say so when invoking this command (`/gtd:refine-journal archive`, or name a month). Prep then also scans the next month backwards from `last_completed_month`, and apply gates that block behind its own confirmation before touching anything.

Prep never calls `op`, and the daily import barrier pre-scores only the live window, so the archive month's Clef people hints need its token from you. Before running prep in archive mode, score that month in the foreground: `direnv exec . op run -- ./bin/run.js ai suggest-labels --parent-id <archive-month-id> --since <archive-yyyy-mm> --kind person --verifier clef --threshold 0.84 >/dev/null`. Skip it and prep tags the archive month without hints.

The on-disk contract both halves share is documented in `${CLAUDE_PLUGIN_ROOT}/skills/review-proposal-staging.md`.
