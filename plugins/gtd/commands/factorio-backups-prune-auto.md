---
name: factorio-backups-prune-auto
description: Auto task for the daily review — archive the Factorio Prints Firebase backup dumps from their GCS bucket to the NAS, prune NAS-verified dumps past retention from the bucket, and stage a briefing fragment. Fully autonomous; no confirmation gate.
---

# Factorio Backups Prune — Auto

Keep the `gs://facorio-blueprints-backups` bucket small without losing a backup. The bucket gains a ~1.4 GB `<ISO timestamp>_facorio-blueprints_data.json.gz` dump every day; the NAS at `/Volumes/Public/NAS/Factorio/facorio-blueprints-backups/` is the long-term archive. The live prep task carries `Auto`, so this stages a briefing fragment instead of a confirmable proposal.

## Auto contract

- **Fully autonomous.** Never call `AskUserQuestion` / `TaskCreate` / `TaskUpdate` / `TodoWrite`.
- **Run the script once and stage its output.** Never copy, verify, or delete by hand, and never widen what the script deletes.
- **Idempotent.** A re-run finds every dump archived and nothing past retention, and stages `status: "empty"`.

## Run the prune

Create the briefing directory, then run the script with its stdout as the briefing:

```bash
mkdir -p .llm/gtd/review/briefings
```

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/prune-factorio-backups.mts > .llm/gtd/review/briefings/factorio-backups-prune.json
```

Allow up to 30 minutes: each missing dump is a 1.4 GB download onto the NAS. The script:

- Lists the bucket's data dumps with `gcloud storage objects list` (project `facorio-blueprints`, account `factorio.prints@gmail.com`). The tiny `*_rules.json.gz` files are never touched.
- Copies every dump the NAS lacks with `gcloud storage cp`, then checks its size on the NAS.
- Applies the retention rule: keep every dump from the last 45 days plus the first dump of each calendar month.
- Deletes the rest only when the NAS copy exists with the identical byte size. A missing or size-mismatched copy leaves the dump in the bucket and is reported.
- Deletes through the Storage JSON API with `gcloud auth print-access-token`, pinned to the listed object generation, because a hook on this machine blocks `gcloud storage rm`. Never fall back to `gcloud storage rm` or `gsutil rm`.

When the NAS is not mounted the script does nothing and reports a successful no-op; the dumps wait in the bucket for a later run.

Pass `--dry-run` to preview the copies and deletes without making them. Do not stage a dry run as the briefing.

## Read the result

The script prints the complete briefing (schema in `${CLAUDE_PLUGIN_ROOT}/skills/review-proposal-staging.md`) and exits non-zero exactly when `status` is `error`:

```json
{
	"task": "factorio-backups-prune",
	"status": "ready",
	"lines": ["🗄️ Factorio backups: copied 7 to the NAS, deleted 6 from the bucket (7.66 GiB freed), 156 kept"],
	"autoApplied": ["Copied 2026-11-05T17:04:34Z_facorio-blueprints_data.json.gz to the NAS"]
}
```

- `ready`: one or more dumps were copied or deleted, and everything is verified.
- `empty`: nothing to copy or prune, or the NAS is not mounted.
- `error`: a listing, copy, or delete failed, or a dump has no identical-size NAS copy. Each one is its own `⚠️` line. Anything already copied or deleted is still listed in `autoApplied`.

Leave the staged file exactly as the script wrote it. If the script printed nothing usable (a crash before the briefing), stage `status: "error"` with the stderr text instead.

## Summary

Return verified success for `ready`, empty for `empty`, and failure for `error`, with the briefing's first line as the one-line status. The DAG executor advances the prep date only after success or empty; an error leaves the date unchanged so the next daily review retries.
