<!-- markdownlint-disable-file MD025 -->

# OutlineDB

OutlineDB is an outliner at [app.outlinedb.com](https://app.outlinedb.com), compatible with workflowy.com. `outlinedb` is its CLI: it reads and writes the local cache and syncs it with workflowy.com through the upstream API.

Why this project merges several upstream data sources: see [docs/workflowy-data-sources.md](docs/workflowy-data-sources.md).

<!-- toc -->

- [OutlineDB](#outlinedb)
- [Usage](#usage)
- [Commands](#commands)

<!-- tocstop -->

# Usage

<!-- usage -->

```sh-session
$ npm install -g outlinedb
$ outlinedb COMMAND
running command...
$ outlinedb (--version)
outlinedb/0.1.0 darwin-arm64 node-v24.22.0
$ outlinedb --help [COMMAND]
USAGE
  $ outlinedb COMMAND
...
```

<!-- usagestop -->

# Commands

<!-- commands -->

- [`outlinedb ai embed`](#outlinedb-ai-embed)
- [`outlinedb ai eval-labels`](#outlinedb-ai-eval-labels)
- [`outlinedb ai qmd-embed`](#outlinedb-ai-qmd-embed)
- [`outlinedb ai qmd-search`](#outlinedb-ai-qmd-search)
- [`outlinedb ai search`](#outlinedb-ai-search)
- [`outlinedb ai suggest-labels`](#outlinedb-ai-suggest-labels)
- [`outlinedb backups archive`](#outlinedb-backups-archive)
- [`outlinedb cache import-account`](#outlinedb-cache-import-account)
- [`outlinedb cache import-api`](#outlinedb-cache-import-api)
- [`outlinedb cache import-backup`](#outlinedb-cache-import-backup)
- [`outlinedb cache import-backups`](#outlinedb-cache-import-backups)
- [`outlinedb cache import-local-state`](#outlinedb-cache-import-local-state)
- [`outlinedb cache seed-account-state`](#outlinedb-cache-seed-account-state)
- [`outlinedb cache status`](#outlinedb-cache-status)
- [`outlinedb cache sync-node`](#outlinedb-cache-sync-node)
- [`outlinedb cache temporal-rollback`](#outlinedb-cache-temporal-rollback)
- [`outlinedb cache vacuum`](#outlinedb-cache-vacuum)
- [`outlinedb calendar audit`](#outlinedb-calendar-audit)
- [`outlinedb calendar backfill-metadata`](#outlinedb-calendar-backfill-metadata)
- [`outlinedb calendar day`](#outlinedb-calendar-day)
- [`outlinedb calendar fix-photo-groups`](#outlinedb-calendar-fix-photo-groups)
- [`outlinedb calendar migrate-dates`](#outlinedb-calendar-migrate-dates)
- [`outlinedb dropbox auth`](#outlinedb-dropbox-auth)
- [`outlinedb dropbox download-backup`](#outlinedb-dropbox-download-backup)
- [`outlinedb dropbox list-backups`](#outlinedb-dropbox-list-backups)
- [`outlinedb files mirror`](#outlinedb-files-mirror)
- [`outlinedb gtd inboxes account`](#outlinedb-gtd-inboxes-account)
- [`outlinedb gtd inboxes load`](#outlinedb-gtd-inboxes-load)
- [`outlinedb gtd journal dedup`](#outlinedb-gtd-journal-dedup)
- [`outlinedb gtd metadata sync`](#outlinedb-gtd-metadata-sync)
- [`outlinedb gtd otter api COMMAND`](#outlinedb-gtd-otter-api-command)
- [`outlinedb gtd otter import`](#outlinedb-gtd-otter-import)
- [`outlinedb gtd otter sync`](#outlinedb-gtd-otter-sync)
- [`outlinedb gtd tasks load`](#outlinedb-gtd-tasks-load)
- [`outlinedb gtd tasks load-declined`](#outlinedb-gtd-tasks-load-declined)
- [`outlinedb help [COMMAND]`](#outlinedb-help-command)
- [`outlinedb internal login`](#outlinedb-internal-login)
- [`outlinedb internal logout`](#outlinedb-internal-logout)
- [`outlinedb internal probe STEP`](#outlinedb-internal-probe-step)
- [`outlinedb node changes`](#outlinedb-node-changes)
- [`outlinedb node complete`](#outlinedb-node-complete)
- [`outlinedb node create`](#outlinedb-node-create)
- [`outlinedb node delete`](#outlinedb-node-delete)
- [`outlinedb node get`](#outlinedb-node-get)
- [`outlinedb node list`](#outlinedb-node-list)
- [`outlinedb node mirror`](#outlinedb-node-mirror)
- [`outlinedb node move`](#outlinedb-node-move)
- [`outlinedb node schema`](#outlinedb-node-schema)
- [`outlinedb node search`](#outlinedb-node-search)
- [`outlinedb node uncomplete`](#outlinedb-node-uncomplete)
- [`outlinedb node update`](#outlinedb-node-update)
- [`outlinedb utils format-node`](#outlinedb-utils-format-node)
- [`outlinedb utils path-to-id`](#outlinedb-utils-path-to-id)

## `outlinedb ai embed`

Generate vector embeddings for all Workflowy nodes

```text
USAGE
  $ outlinedb ai embed [-b <value>] [-f] [-m minilm|mpnet|bge|openai-small|openai-large]

FLAGS
  -b, --batch-size=<value>  [default: 20] Number of nodes to process in each batch
  -f, --force               Regenerate embeddings for nodes that already have them
  -m, --model=<option>      Embedding model to use (generates for local models by default)
                            <options: minilm|mpnet|bge|openai-small|openai-large>

DESCRIPTION
  Generate vector embeddings for all Workflowy nodes

EXAMPLES
  $ outlinedb ai embed

  $ outlinedb ai embed --batch-size 50

  $ outlinedb ai embed --force
```

## `outlinedb ai eval-labels`

Measure Clef label suggestions on held-out tagged journal entries: strip each sampled entry's @mentions (to first names) and #tags (dropped, or kept as plain words with --tag-strip word), run the Clef-flash shortlist once and each arm's verify pass, and report shortlist recall, precision/recall per threshold, the threshold reaching the target precision, latency and cost from usage.input_tokens, per arm and label kind

```text
USAGE
  $ outlinedb ai eval-labels [--sample <value>] [--since <value>] [--arms flash|clef...] [--thresholds <value>]
    [--target-precision <value>] [--seed <value>] [--tag-strip drop|word] [--kind person|tag] [--people-context
    aliases|siblings...] [--disambiguation-file <value>] [--calendar-id <value>] [--metadata-dir <value>] [-j]

FLAGS
  -j, --json                         Output the report as JSON
      --arms=<option>...             [default: flash] Verify-pass models to compare: flash is Clef-flash, clef is full
                                     Clef
                                     <options: flash|clef>
      --calendar-id=<value>          Calendar root (full or short id); defaults to 📆 Calendar
      --disambiguation-file=<value>  [default: .llm/gtd/people-disambiguation.md] People-disambiguation markdown read by
                                     --people-context aliases
      --kind=<option>                Evaluate one label kind: keep the sampled entries that carry it, only their labels
                                     of that kind, and a pool of that kind
                                     <options: person|tag>
      --metadata-dir=<value>         [default: .llm/gtd/metadata] Directory holding people.json, hobbies-registry.json
                                     and tag-frequency.json
      --people-context=<option>...   [default: ] Experimental extra context (default none): aliases folds
                                     people-disambiguation hints into person descriptions, siblings adds the day's other
                                     entries (stripped the same way) to state
                                     <options: aliases|siblings>
      --sample=<value>               [default: 500] Entries to evaluate, split between people and tags
      --seed=<value>                 [default: 1] Sampling seed
      --since=<value>                [default: 2025-01] Earliest calendar month to sample from (YYYY-MM)
      --tag-strip=<option>           [default: drop] How to hide #tags from Clef: drop removes them, word keeps the
                                     tag's word as plain text so evidence like '#fasting day 1' survives
                                     <options: drop|word>
      --target-precision=<value>     [default: 0.9] Report the lowest threshold whose precision reaches this
      --thresholds=<value>           [default: 0.5,0.6,0.7,0.8,0.9,0.95] Comma-separated verify-score thresholds to
                                     report precision and recall at

DESCRIPTION
  Measure Clef label suggestions on held-out tagged journal entries: strip each sampled entry's @mentions (to first
  names) and #tags (dropped, or kept as plain words with --tag-strip word), run the Clef-flash shortlist once and each
  arm's verify pass, and report shortlist recall, precision/recall per threshold, the threshold reaching the target
  precision, latency and cost from usage.input_tokens, per arm and label kind

EXAMPLES
  op run -- outlinedb ai eval-labels --sample 500 --since 2025-01 --arms flash,clef --json
```

## `outlinedb ai qmd-embed`

Sync Workflowy nodes into qmd index and generate embeddings

```text
USAGE
  $ outlinedb ai qmd-embed [-f]

FLAGS
  -f, --force  Re-embed all documents (clear existing embeddings first)

DESCRIPTION
  Sync Workflowy nodes into qmd index and generate embeddings

EXAMPLES
  $ outlinedb ai qmd-embed

  $ outlinedb ai qmd-embed --force
```

## `outlinedb ai qmd-search`

Search Workflowy nodes using qmd hybrid search (BM25 + vector + LLM reranking)

```text
USAGE
  $ outlinedb ai qmd-search -q <value> [-j] [-l <value>] [-t <value>] [-d] [-m hybrid|vector|keyword]

FLAGS
  -d, --show-distance      Show relevance scores
  -j, --json               Output results in JSON format
  -l, --limit=<value>      [default: 5] Maximum number of results to return
  -m, --mode=<option>      [default: hybrid] Search mode
                           <options: hybrid|vector|keyword>
  -q, --query=<value>      (required) Search query
  -t, --threshold=<value>  Minimum score threshold (0-1, higher = more relevant)

DESCRIPTION
  Search Workflowy nodes using qmd hybrid search (BM25 + vector + LLM reranking)

EXAMPLES
  $ outlinedb ai qmd-search --query "project ideas"

  $ outlinedb ai qmd-search --query "meeting notes" --mode keyword

  $ outlinedb ai qmd-search --query "API design" --mode vector

  $ outlinedb ai qmd-search --query "tasks" --limit 10 --json
```

## `outlinedb ai search`

Semantically search through Workflowy nodes using vector embeddings

```text
USAGE
  $ outlinedb ai search -q <value> [-j] [-l <value>] [-t <value>] [-d] [-m
    minilm|mpnet|bge|openai-small|openai-large] [--mode vector|keyword|hybrid]

FLAGS
  -d, --show-distance      Show similarity distance scores
  -j, --json               Output results in JSON format
  -l, --limit=<value>      [default: 5] Maximum number of results to return per model
  -m, --model=<option>     Search using a specific model only (minilm or mpnet)
                           <options: minilm|mpnet|bge|openai-small|openai-large>
  -q, --query=<value>      (required) Search query
  -t, --threshold=<value>  Maximum distance threshold (lower = more similar, 0-2). Uses model-specific default if not
                           specified.
      --mode=<option>      [default: vector] Search mode: vector (default), keyword (FTS5), or hybrid (BM25 + vector RRF
                           fusion)
                           <options: vector|keyword|hybrid>

DESCRIPTION
  Semantically search through Workflowy nodes using vector embeddings

EXAMPLES
  $ outlinedb ai search --query "project ideas"

  $ outlinedb ai search --query "meeting notes from last week" --limit 10

  $ outlinedb ai search -q "tasks about refactoring" --threshold 0.3 # stricter matching

  $ outlinedb ai search --query "API" --model bge # use specific model

  $ outlinedb ai search --query "API" --json | jq

  $ outlinedb ai search --query "API" --mode hybrid # BM25 + vector fusion
```

## `outlinedb ai suggest-labels`

Score @mention and #tag suggestions for journal entries or inbox items with hosted Clef on Workers AI (a Clef-flash shortlist pass, then a verify pass), store them, and print the verify-pass suggestions at or above the threshold. Entries already scored against their current text are skipped unless --force

```text
USAGE
  $ outlinedb ai suggest-labels [--id <value>] [--since <value> --parent-id <value>] [--verifier clef-flash|clef]
    [--threshold <value>] [--kind person|tag] [--force] [--metadata-dir <value>] [-j]

FLAGS
  -j, --json                  Output [{nodeId, suggestions}] as JSON
      --force                 Rescore entries that already have fresh suggestions
      --id=<value>            Entry to score (full or short id)
      --kind=<option>         Score and print only this label kind (default: both)
                              <options: person|tag>
      --metadata-dir=<value>  [default: .llm/gtd/metadata] Directory holding people.json, hobbies-registry.json and
                              tag-frequency.json
      --parent-id=<value>     Score every entry under this calendar month (through its days) or Inbox (full or short id)
      --since=<value>         With --parent-id, score the entries on calendar days in or after this month (YYYY-MM) at
                              any depth under it, instead of its direct children and days
      --threshold=<value>     [default: 0.8] Print verify-pass suggestions scoring at least this probability
      --verifier=<option>     [default: clef-flash] Model for the verify pass; the shortlist pass always uses clef-flash
                              <options: clef-flash|clef>

DESCRIPTION
  Score @mention and #tag suggestions for journal entries or inbox items with hosted Clef on Workers AI (a Clef-flash
  shortlist pass, then a verify pass), store them, and print the verify-pass suggestions at or above the threshold.
  Entries already scored against their current text are skipped unless --force

EXAMPLES
  op run -- outlinedb ai suggest-labels --id 6b7118a90648 --json

  op run -- outlinedb ai suggest-labels --parent-id <month or Inbox id> --threshold 0.9 --json

  op run -- outlinedb ai suggest-labels --parent-id <month id> --verifier clef --force

  op run -- outlinedb ai suggest-labels --parent-id <calendar id> --since 2026-10 --kind person --verifier clef --threshold 0.84 --json
```

## `outlinedb backups archive`

Compress local backups: keep recent days as per-file .zst, fold older days into solid monthly archives

```text
USAGE
  $ outlinedb backups archive [--keep-days <value>] [--source Data|History]

FLAGS
  --keep-days=<value>  [default: 30] Days of backups to keep as individually compressed files before folding into
                       monthly archives
  --source=<option>    Limit to a single backup source
                       <options: Data|History>

DESCRIPTION
  Compress local backups: keep recent days as per-file .zst, fold older days into solid monthly archives

EXAMPLES
  $ outlinedb backups:archive

  $ outlinedb backups:archive --keep-days 60

  $ outlinedb backups:archive --source Data
```

## `outlinedb cache import-account`

Fetch the account state (account incl. entropy key, root metadata incl. tag colors and stars, settings, visible features) from the internal API into the typed temporal account tables

```text
USAGE
  $ outlinedb cache import-account [--json]

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Fetch the account state (account incl. entropy key, root metadata incl. tag colors and stars, settings, visible
  features) from the internal API into the typed temporal account tables

EXAMPLES
  $ outlinedb cache:import-account
```

## `outlinedb cache import-api`

Import all nodes from Workflowy API export endpoint

```text
USAGE
  $ outlinedb cache import-api [-d] [-v]

FLAGS
  -d, --dry-run  Show what would be imported without making changes
  -v, --verbose  Show detailed timing information

DESCRIPTION
  Import all nodes from Workflowy API export endpoint

EXAMPLES
  $ outlinedb cache:import-api

  $ outlinedb cache:import-api --dry-run
```

## `outlinedb cache import-backup`

Import a Workflowy backup file into the cache database

```text
USAGE
  $ outlinedb cache import-backup [-f <value>] [--latest] [--embeddings] [-b <value>] [-y] [--force]
    [--backup-system-time]

FLAGS
  -b, --batch-size=<value>  [default: 20] Number of nodes to process in each embedding batch
  -f, --file=<value>        Path to the backup file
  -y, --yes                 Skip confirmation prompts
      --backup-system-time  Stamp the import with a system time taken from the backup (its newest change, or noon UTC on
                            the filename date) instead of the clock, for replaying historical backups
      --[no-]embeddings     Generate embeddings after import
      --force               Take the snapshot verbatim: do not protect cached nodes newer than it, tombstoning anything
                            it omits
      --latest              Import the most recent backup file from current directory

DESCRIPTION
  Import a Workflowy backup file into the cache database

EXAMPLES
  $ outlinedb cache:import-backup --file backup.json

  $ outlinedb cache:import-backup --file /path/to/backup.workflowy.backup

  $ outlinedb cache:import-backup --file backup.json --no-embeddings

  $ outlinedb cache:import-backup --latest

  $ outlinedb cache:import-backup --file backups/Data/(me@example.com).2025-10-28.workflowy.backup.zst --backup-system-time
```

## `outlinedb cache import-backups`

Import all missing backups from Dropbox into cache

```text
USAGE
  $ outlinedb cache import-backups [--embeddings] [-b <value>] [--download] [--archive] [--backup-system-time] [--force]

FLAGS
  -b, --batch-size=<value>  [default: 20] Number of nodes to process in each embedding batch
      --[no-]archive        Compress and archive local backups before importing
      --backup-system-time  Stamp each import with a system time taken from its backup (see cache:import-backup)
      --[no-]download       Download missing backups from Dropbox first
      --[no-]embeddings     Generate embeddings after import
      --force               Take each snapshot verbatim: do not protect cached nodes newer than it, tombstoning anything
                            it omits (see cache:import-backup)

DESCRIPTION
  Import all missing backups from Dropbox into cache

EXAMPLES
  $ outlinedb cache:import-backups

  $ outlinedb cache:import-backups --no-embeddings

  $ outlinedb cache:import-backups --batch-size 50

  $ outlinedb cache:import-backups --no-download --no-archive --backup-system-time

  $ outlinedb cache:import-backups --backup-system-time --force
```

## `outlinedb cache import-local-state`

Copy the state no Workflowy backup can rebuild from an old cache database, opened read-only, into this one: every version of the account tables and file_blobs (so their history carries over). Run it on a new database before import-api and import-account, which then merge the current values on top

```text
USAGE
  $ outlinedb cache import-local-state --from <value> [--json]

FLAGS
  --from=<value>  (required) Old cache database to copy from (opened read-only)

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Copy the state no Workflowy backup can rebuild from an old cache database, opened read-only, into this one: every
  version of the account tables and file_blobs (so their history carries over). Run it on a new database before
  import-api and import-account, which then merge the current values on top

EXAMPLES
  $ outlinedb cache:import-local-state --from outlinedb.pre-rebuild.sqlite
```

## `outlinedb cache seed-account-state`

Read the account state (every account table's live rows plus the expanded keys) from the local cache and PUT it to /api/admin/account-state under the given Worker URL, seeding a Cloudflare deployment

```text
USAGE
  $ outlinedb cache seed-account-state --url <value> [--json] [--access-client-id <value>] [--access-client-secret
  <value>]

FLAGS
  --access-client-id=<value>      [env: CF_ACCESS_CLIENT_ID] Cloudflare Access service token client id (sent as
                                  CF-Access-Client-Id)
  --access-client-secret=<value>  [env: CF_ACCESS_CLIENT_SECRET] Cloudflare Access service token client secret (sent as
                                  CF-Access-Client-Secret)
  --url=<value>                   (required) Worker base URL to seed

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Read the account state (every account table's live rows plus the expanded keys) from the local cache and PUT it to
  /api/admin/account-state under the given Worker URL, seeding a Cloudflare deployment

EXAMPLES
  $ outlinedb cache:seed-account-state --url http://localhost:8787
```

## `outlinedb cache status`

Show cache database status and statistics

```text
USAGE
  $ outlinedb cache status [--json]

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Show cache database status and statistics

EXAMPLES
  $ outlinedb cache:status

  $ outlinedb cache:status --json
```

## `outlinedb cache sync-node`

Sync a specific node and optionally its children from the Workflowy API to the cache

```text
USAGE
  $ outlinedb cache sync-node [-i <value> | -p <value>] [-r]

FLAGS
  -i, --id=<value>    Node ID to sync
  -p, --path=<value>  Path to the node (comma-separated)
  -r, --recursive     Recursively sync all children

DESCRIPTION
  Sync a specific node and optionally its children from the Workflowy API to the cache

EXAMPLES
  $ outlinedb cache:sync-node --id 61111c3a-e939-d4dc-1a8c-6bf42551caa3

  $ outlinedb cache:sync-node --path Personal,Journal

  $ outlinedb cache:sync-node --path Work,Projects --recursive

  $ outlinedb cache:sync-node --id 39caff96-e338-0f20-55f2-65f9e140ba02 --recursive
```

## `outlinedb cache temporal-rollback`

Roll back all temporal tables to a previous point in time. This is a destructive operation for disaster recovery.

```text
USAGE
  $ outlinedb cache temporal-rollback --to <value> [--exclude
    node_content|node_metadata|calendar_metadata|calendar_levels|node_display_metadata|node_table_cell_sizes|node_embedd
    ings|mirrors|ai_metadata|node_label_suggestions|s3_files|changes_metadata|references_roots|backup_imports|api_import
    _timestamp|tree_transactions|calendar_layout_applies|file_blobs|whats_new_reads|account|root_preferences|account_set
    tings|tag_colors|stars|star_order|location_renames|enabled_features|visible_features|expanded_nodes|changelog_reads|
    surveys|saved_views|ai_assistants|ai_prompt_buttons...] [--dry-run] [-y]

FLAGS
  -y, --yes
      Skip confirmation prompt

  --dry-run
      Show row counts without executing

  --exclude=<option>...
      [default: ] Table to exclude from rollback (repeatable)
      <options: node_content|node_metadata|calendar_metadata|calendar_levels|node_display_metadata|node_table_cell_sizes|n
      ode_embeddings|mirrors|ai_metadata|node_label_suggestions|s3_files|changes_metadata|references_roots|backup_imports|
      api_import_timestamp|tree_transactions|calendar_layout_applies|file_blobs|whats_new_reads|account|root_preferences|a
      ccount_settings|tag_colors|stars|star_order|location_renames|enabled_features|visible_features|expanded_nodes|change
      log_reads|surveys|saved_views|ai_assistants|ai_prompt_buttons>

  --to=<value>
      (required) Target timestamp to roll back to (e.g., "2026-01-23 00:00:00")

DESCRIPTION
  Roll back all temporal tables to a previous point in time. This is a destructive operation for disaster recovery.

EXAMPLES
  $ outlinedb cache:temporal-rollback --to "2026-01-23 00:00:00" --dry-run

  $ outlinedb cache:temporal-rollback --to "2026-01-23 00:00:00" --exclude node_embeddings

  $ outlinedb cache:temporal-rollback --to "2026-01-23 00:00:00" --exclude node_embeddings --yes
```

## `outlinedb cache vacuum`

Reclaim dead pages from the cache database by running VACUUM, shrinking the file on disk

```text
USAGE
  $ outlinedb cache vacuum [--json]

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Reclaim dead pages from the cache database by running VACUUM, shrinking the file on disk

EXAMPLES
  $ outlinedb cache:vacuum

  $ outlinedb cache:vacuum --json
```

## `outlinedb calendar audit`

Find 📆 Calendar nodes that workflowy.com cannot use as days (name-only `<time>` or [YYYY-MM-DD] days, nested tagged days, duplicate dates, name-only years and months), and with --fix adopt the safe ones by writing their calendar metadata

```text
USAGE
  $ outlinedb calendar audit [--fix] [--root-id <value>] [--refresh] [-j]

FLAGS
  -j, --json             Output the findings as JSON
      --fix              Adopt each untagged day that has no tagged sibling for its date, renaming [YYYY-MM-DD] days to
                         a <time> first. Duplicates and nested days are only reported
      --refresh          Run cache import-api first so internal metadata is current
      --root-id=<value>  Audit this calendar root node (tagged calendar.root) instead of the account's 📆 Calendar

DESCRIPTION
  Find 📆 Calendar nodes that workflowy.com cannot use as days (name-only `<time>` or [YYYY-MM-DD] days, nested tagged
  days, duplicate dates, name-only years and months), and with --fix adopt the safe ones by writing their calendar
  metadata

EXAMPLES
  $ outlinedb calendar audit

  $ outlinedb calendar audit --json

  $ outlinedb calendar audit --fix
```

## `outlinedb calendar backfill-metadata`

Run workflowy.com's one-time calendar migrations: add calendar.timestamp, then calendar.dateId, to 📆 Calendar level nodes missing them, each only while root metadata lacks its calendar.ts_added_v2 / calendar.dateId_added_v1 flag, which is set after

```text
USAGE
  $ outlinedb calendar backfill-metadata [--force] [-j]

FLAGS
  -j, --json   Output {timestamps, dateIds} (the ids changed) as JSON
      --force  Run both backfills even when their flags are already set

DESCRIPTION
  Run workflowy.com's one-time calendar migrations: add calendar.timestamp, then calendar.dateId, to 📆 Calendar level
  nodes missing them, each only while root metadata lacks its calendar.ts_added_v2 / calendar.dateId_added_v1 flag,
  which is set after

EXAMPLES
  $ outlinedb calendar backfill-metadata

  $ outlinedb calendar backfill-metadata --force --json
```

## `outlinedb calendar day`

Find (or with --ensure, create) the 📆 Calendar day node workflowy.com uses for a date. Lookup is a strict metadata.calendar walk from the root; --ensure creates missing year/month/day nodes with calendar metadata

```text
USAGE
  $ outlinedb calendar day [--date <value>] [--ensure] [--no-child] [--level year|month|week|day] [-j]

FLAGS
  -j, --json            Output {id, created, firstChildId} as JSON
      --date=<value>    Date as YYYY-MM-DD (default: today, local time)
      --ensure          Create the day (and any missing year/month) with calendar metadata when it is missing
      --level=<option>  Which node to find or ensure: the day (default), its week, month or year
                        <options: year|month|week|day>
      --no-child        With --ensure, do not add an empty first child to a new or empty day

DESCRIPTION
  Find (or with --ensure, create) the 📆 Calendar day node workflowy.com uses for a date. Lookup is a strict
  metadata.calendar walk from the root; --ensure creates missing year/month/day nodes with calendar metadata

EXAMPLES
  $ outlinedb calendar day

  $ outlinedb calendar day --date 2026-10-05 --json

  $ outlinedb calendar day --date 2026-10-22 --ensure --no-child --json
```

## `outlinedb calendar fix-photo-groups`

Unwrap blank photo-paste wrappers in the calendar and restore chronological photo order

```text
USAGE
  $ outlinedb calendar fix-photo-groups [-d] [--node-id <value>] [-b <value>] [-D <value>]

FLAGS
  -D, --delay=<value>       [default: 1000] Milliseconds between API calls
  -b, --batch-size=<value>  Number of groups to fix before stopping (default: all)
  -d, --dry-run             Report the groups and planned order without making API calls
      --node-id=<value>     Limit processing by wrapper or entry UUID or 12-character short ID

DESCRIPTION
  Unwrap blank photo-paste wrappers in the calendar and restore chronological photo order

EXAMPLES
  # Preview every group that would be fixed

  $ outlinedb calendar fix-photo-groups --dry-run



  # Fix a single group by wrapper or entry ID

  $ outlinedb calendar fix-photo-groups --node-id b03bd2f9bf47



  # Fix the first five groups

  $ outlinedb calendar fix-photo-groups --batch-size 5
```

## `outlinedb calendar migrate-dates`

Convert text dates to native Workflowy dates in calendar archive day nodes

```text
USAGE
  $ outlinedb calendar migrate-dates [-d] [-a <value>] [-b <value>] [-D <value>] [--year <value>]

FLAGS
  -D, --delay=<value>       [default: 1000] Milliseconds between API calls
  -a, --archive-id=<value>  [default: f6b557fbf770] ID of the archive root node
  -b, --batch-size=<value>  Number of nodes to process before stopping (default: all)
  -d, --dry-run             Parse and log all changes without making API calls
      --year=<value>        Limit processing to a specific year

DESCRIPTION
  Convert text dates to native Workflowy dates in calendar archive day nodes

EXAMPLES
  # Preview all changes without making API calls

  $ outlinedb calendar migrate-dates --dry-run



  # Test with a specific year first

  $ outlinedb calendar migrate-dates --dry-run --year 2017



  # Execute migration for one year

  $ outlinedb calendar migrate-dates --year 2017



  # Execute full migration with custom delay

  $ outlinedb calendar migrate-dates --delay 300
```

## `outlinedb dropbox auth`

Authenticate with Dropbox to get a refresh token

```text
USAGE
  $ outlinedb dropbox auth

DESCRIPTION
  Authenticate with Dropbox to get a refresh token

EXAMPLES
  $ outlinedb dropbox auth
```

## `outlinedb dropbox download-backup`

Download all Workflowy backups from Dropbox that are not already downloaded locally

```text
USAGE
  $ outlinedb dropbox download-backup [--json] [-f Data|History] [-d <value>] [-q]

FLAGS
  -d, --date=<value>     Download backup from specific date only (YYYY-MM-DD format)
  -f, --folder=<option>  Which Dropbox folder to download from (default: downloads from both Data and History)
                         <options: Data|History>
  -q, --quiet            Suppress all output except the downloaded filenames (for scripting)

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Download all Workflowy backups from Dropbox that are not already downloaded locally

EXAMPLES
  $ outlinedb dropbox download-backup

  $ outlinedb dropbox download-backup --folder History

  $ outlinedb dropbox download-backup --date 2025-11-06

  $ outlinedb dropbox download-backup --json | jq -r ".downloaded[].path"
```

## `outlinedb dropbox list-backups`

List all available Workflowy backup files in Dropbox from both Data and History folders

```text
USAGE
  $ outlinedb dropbox list-backups [-a]

FLAGS
  -a, --all  List backups from all folders (Data and History)

DESCRIPTION
  List all available Workflowy backup files in Dropbox from both Data and History folders

EXAMPLES
  $ outlinedb dropbox list-backups
```

## `outlinedb files mirror`

Download attachment bytes (photos, PDFs, videos) out of Workflowy into a local content-addressed store, recording each in file_blobs. Resumable: attachments already on disk are skipped and failures are retried on the next run.

```text
USAGE
  $ outlinedb files mirror [--dir <value>] [--limit <value>] [--concurrency <value>] [-d]

FLAGS
  -d, --dry-run              Show what would be downloaded without fetching
      --concurrency=<value>  [default: 3] Downloads in flight at once
      --dir=<value>          Store directory (default: OUTLINEDB_FILES_DIR, else files-mirror/ beside the cache
                             database)
      --limit=<value>        Download at most this many attachments not yet mirrored

DESCRIPTION
  Download attachment bytes (photos, PDFs, videos) out of Workflowy into a local content-addressed store, recording each
  in file_blobs. Resumable: attachments already on disk are skipped and failures are retried on the next run.

EXAMPLES
  $ outlinedb files mirror --dry-run

  $ outlinedb files mirror --limit 3

  $ outlinedb files mirror --dir /Volumes/archive/outlinedb-files --concurrency 4
```

## `outlinedb gtd inboxes account`

Print the account Inbox (the node root metadata inbox_id names, else the top-level node named Inbox)

```text
USAGE
  $ outlinedb gtd inboxes account

DESCRIPTION
  Print the account Inbox (the node root metadata inbox_id names, else the top-level node named Inbox)

EXAMPLES
  $ outlinedb gtd inboxes account
```

## `outlinedb gtd inboxes load`

Load inbox items from Workflowy for GTD processing

```text
USAGE
  $ outlinedb gtd inboxes load [--depth <value>]

FLAGS
  --depth=<value>  Depth of children to fetch for each inbox item (0 = none, max 10)

DESCRIPTION
  Load inbox items from Workflowy for GTD processing

EXAMPLES
  # Load all inbox items

  $ outlinedb gtd inboxes load

  # Load with children (depth 3 for refinement nodes)

  $ outlinedb gtd inboxes load --depth 3
```

## `outlinedb gtd journal dedup`

Deduplicate journal entries against existing calendar

```text
USAGE
  $ outlinedb gtd journal dedup [--json] [-t <value>]

FLAGS
  -t, --threshold=<value>  [default: 0.55] Similarity threshold (0.0-1.0)

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Deduplicate journal entries against existing calendar

EXAMPLES
  # Run deduplication analysis

  $ outlinedb gtd journal dedup



  # Use custom threshold

  $ outlinedb gtd journal dedup --threshold 0.6
```

## `outlinedb gtd metadata sync`

Sync GTD metadata from Workflowy to local JSON

```text
USAGE
  $ outlinedb gtd metadata sync [-s cache|api]

FLAGS
  -s, --data-source=<option>  [default: cache] Data source to use
                              <options: cache|api>

DESCRIPTION
  Sync GTD metadata from Workflowy to local JSON

EXAMPLES
  # Sync metadata from cache (default)

  $ outlinedb gtd metadata sync



  # Force sync from API

  $ outlinedb gtd metadata sync --data-source api
```

## `outlinedb gtd otter api COMMAND`

Otter.ai API wrapper for fetching meetings

```text
USAGE
  $ outlinedb gtd otter api COMMAND [--otid <value>] [--page-size <value>] [--cursor <value>] [--modified-after
    <value>]

ARGUMENTS
  COMMAND  (available_speeches|speech|summary|action_items) API command to execute

FLAGS
  --cursor=<value>          Pagination cursor (last_load_ts)
  --modified-after=<value>  Only fetch items modified after this timestamp
  --otid=<value>            Otter transcript ID (required for speech, summary, action_items)
  --page-size=<value>       [default: 50] Number of results per page

DESCRIPTION
  Otter.ai API wrapper for fetching meetings

EXAMPLES
  # List available speeches

  $ outlinedb gtd otter api available_speeches



  # Get speech details

  $ outlinedb gtd otter api speech --otid abc123



  # Get action items for a speech

  $ outlinedb gtd otter api action_items --otid abc123
```

## `outlinedb gtd otter import`

Import Otter meetings to Workflowy Calendar

```text
USAGE
  $ outlinedb gtd otter import [-d <value>] [-m <value>] [--reset] [--calendar-id <value>] [--dry-run]

FLAGS
  -d, --delay=<value>        [default: 5] Seconds between API calls
  -m, --max=<value>          Maximum meetings to import (0 = unlimited)
      --calendar-id=<value>  [default: 8111d11c-b80e-f219-8ac3-08567aa37346] Calendar node ID to import into
      --dry-run              Show what would be imported without creating nodes
      --reset                Reset import state and start fresh

DESCRIPTION
  Import Otter meetings to Workflowy Calendar

EXAMPLES
  # Import meetings with 5 second delay between API calls

  $ outlinedb gtd otter import



  # Import with custom delay and max count

  $ outlinedb gtd otter import --delay 3 --max 10



  # Reset state and start fresh

  $ outlinedb gtd otter import --reset
```

## `outlinedb gtd otter sync`

Sync Otter meetings with action items

```text
USAGE
  $ outlinedb gtd otter sync [--page-size <value>] [--cursor <value>] [--modified-after <value>] [--concurrency
    <value>]

FLAGS
  --concurrency=<value>     [default: 10] Max concurrent action item requests
  --cursor=<value>          Pagination cursor (last_load_ts)
  --modified-after=<value>  Only fetch items modified after this timestamp
  --page-size=<value>       [default: 50] Number of results per page

DESCRIPTION
  Sync Otter meetings with action items

EXAMPLES
  # Sync recent meetings

  $ outlinedb gtd otter sync



  # Sync with pagination

  $ outlinedb gtd otter sync --page-size 100
```

## `outlinedb gtd tasks load`

Load existing tasks for duplicate detection

```text
USAGE
  $ outlinedb gtd tasks load [--json] [-l <value>]

FLAGS
  -l, --lookback-days=<value>  [default: 7] Number of days to look back for recent meetings

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Load existing tasks for duplicate detection

EXAMPLES
  # Load existing tasks (requires metadata.json)

  $ outlinedb gtd tasks load



  # Output as formatted JSON

  $ outlinedb gtd tasks load --json
```

## `outlinedb gtd tasks load-declined`

Load declined items from Session Memory

```text
USAGE
  $ outlinedb gtd tasks load-declined [--json] [-l <value>]

FLAGS
  -l, --lookback-days=<value>  [default: 7] Number of days to look back

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Load declined items from Session Memory

EXAMPLES
  # Load declined items from the last 7 days (default)

  $ outlinedb gtd tasks load-declined



  # Load declined items from the last 14 days

  $ outlinedb gtd tasks load-declined --lookback-days 14
```

## `outlinedb help [COMMAND]`

Display help for outlinedb.

```text
USAGE
  $ outlinedb help [COMMAND...] [-n]

ARGUMENTS
  [COMMAND...]  Command to show help for.

FLAGS
  -n, --nested-commands  Include all nested commands in the output.

DESCRIPTION
  Display help for outlinedb.
```

_See code: [@oclif/plugin-help](https://github.com/oclif/plugin-help/blob/7.0.6/src/commands/help.ts)_

## `outlinedb internal login`

Log in to Workflowy's internal API once and save the session cookie (mode 0600) so later live work needs no password

```text
USAGE
  $ outlinedb internal login

DESCRIPTION
  Log in to Workflowy's internal API once and save the session cookie (mode 0600) so later live work needs no password

EXAMPLES
  $ outlinedb internal login
```

## `outlinedb internal logout`

Delete the saved Workflowy internal-API session cookie

```text
USAGE
  $ outlinedb internal logout

DESCRIPTION
  Delete the saved Workflowy internal-API session cookie

EXAMPLES
  $ outlinedb internal logout
```

## `outlinedb internal probe STEP`

Run one live probe of Workflowy's internal API (read-only, or writes confined to the sandbox) and append the findings to a markdown log

```text
USAGE
  $ outlinedb internal probe STEP [--yes-live] [--crosscheck] [--yes-account-global] [--keep] [--out <value>]

ARGUMENTS
  STEP  (bootstrap|poll|error-shape|index|restore|meta|expansion|root-meta|root-meta-set|root-meta-unset|settings|calend
        ar-ids|calendar-adopt) Probe step

FLAGS
  --[no-]crosscheck     Send crosscheck_user_id on /push_and_poll (poll only)
  --keep                Leave the `index`, `restore`, `meta` or `expansion` fixture in the sandbox for a visual check
                        (delete it afterwards); `meta` then stops while the fixture is still numbered, `expansion` while
                        it is still expanded
  --out=<value>         [default: .llm/upstream-sync/internal-api-probes.md] Markdown file the findings are appended to
  --yes-account-global  Confirm the user approved the account-global writes: the throwaway root metadata key `probe`, or
                        the `show_completed` flip-and-restore
  --yes-live            Confirm the probe may call workflowy.com

DESCRIPTION
  Run one live probe of Workflowy's internal API (read-only, or writes confined to the sandbox) and append the findings
  to a markdown log

EXAMPLES
  $ outlinedb internal probe bootstrap --yes-live

  $ outlinedb internal probe poll --yes-live

  $ outlinedb internal probe poll --no-crosscheck --yes-live

  $ outlinedb internal probe error-shape --yes-live

  $ outlinedb internal probe index --yes-live

  $ outlinedb internal probe index --yes-live --keep

  $ outlinedb internal probe restore --yes-live

  $ outlinedb internal probe meta --yes-live

  $ outlinedb internal probe meta --yes-live --keep

  $ outlinedb internal probe expansion --yes-live

  $ outlinedb internal probe expansion --yes-live --keep

  $ outlinedb internal probe root-meta --yes-live

  $ outlinedb internal probe root-meta-set --yes-live --yes-account-global

  $ outlinedb internal probe root-meta-unset --yes-live --yes-account-global

  $ outlinedb internal probe settings --yes-live --yes-account-global

  $ outlinedb internal probe calendar-ids --yes-live

  $ outlinedb internal probe calendar-adopt --yes-live
```

## `outlinedb node changes`

Show nodes changed since a given time

```text
USAGE
  $ outlinedb node changes [-s <value>] [--json]

FLAGS
  -s, --since=<value>  [default: 1d] Time range: duration (1d, 12h, 1w) or ISO date
      --json           Output as JSON

DESCRIPTION
  Show nodes changed since a given time

EXAMPLES
  $ outlinedb node changes

  $ outlinedb node changes --since 2d

  $ outlinedb node changes --since 12h

  $ outlinedb node changes --since 2026-02-01

  $ outlinedb node changes --json
```

## `outlinedb node complete`

Mark a Workflowy node as completed

```text
USAGE
  $ outlinedb node complete [-i <value> | -p <value>] [-d]

FLAGS
  -d, --dry-run       Show the API call that would be made without executing
  -i, --id=<value>    ID of the node
  -p, --path=<value>  Comma-separated path to the node (e.g., "Work,Tasks,My Task")

DESCRIPTION
  Mark a Workflowy node as completed

EXAMPLES
  # Complete node by ID

  $ outlinedb node complete --id abc123



  # Complete node by path

  $ outlinedb node complete --path "Work,Tasks,My Task"



  # Preview the API call without executing

  $ outlinedb node complete --id abc123 --dry-run



  # With verbose logging

  $ outlinedb node complete --id abc123 --verbose
```

## `outlinedb node create`

Create a new Workflowy node or tree of nodes from JSON

```text
USAGE
  $ outlinedb node create [-n <value> | --json <value> | --json-file <value>] [--parent-id <value> |
    --parent-path <value>] [--note <value>] [--layout-mode <value>] [--position top|bottom] [-d] [--create-path]

FLAGS
  -d, --dry-run              Show the API call that would be made without executing
  -n, --name=<value>         Name of the new node (use "-" to read from stdin; an indented bullet outline becomes a
                             nested tree per top-level bullet)
      --create-path          Create missing parent path segments (like mkdir -p)
      --json=<value>         JSON structure defining a tree of nodes to create
      --json-file=<value>    Path to a JSON file defining a tree of nodes to create
      --layout-mode=<value>  Layout mode for the node (e.g., "document", "list", "board")
      --note=<value>         Note/description for the node
      --parent-id=<value>    ID of parent node, a system target (e.g., "inbox"), or "home" for the top level
      --parent-path=<value>  Comma-separated path to parent node (e.g., "Work,Projects")
      --position=<option>    Position among siblings: "top" (first) or "bottom" (last, default)
                             <options: top|bottom>

DESCRIPTION
  Create a new Workflowy node or tree of nodes from JSON

EXAMPLES
  # Create node in inbox (system target)

  $ outlinedb node create --parent-id inbox --name "New Task"



  # Create a top-level node (Home)

  $ outlinedb node create --parent-id home --name "Area"



  # Create node under a parent by ID

  $ outlinedb node create --parent-id abc123 --name "Subtask"



  # Create node under a parent by path

  $ outlinedb node create --parent-path "Work,Projects" --name "Subtask"



  # Create node with a specific layout mode

  $ outlinedb node create --parent-id abc123 --name "Notes" --layout-mode document



  # Create from stdin (use - for name)

  echo "## Section 1\n\nParagraph text" | outlinedb node create --parent-id abc123 --name -



  # Import article content via clean-mark

  npx clean-mark https://example.com/article --stdout | outlinedb node create --parent-id abc123 --name -



  # Preview the API call without creating

  $ outlinedb node create --parent-id inbox --name "New Task" --dry-run



  # Create nested nodes from inline JSON

  $ outlinedb node create --parent-id abc123 --json '{"name": "Project", "children": [{"name": "Task 1"}, {"name": "Task 2"}]}'



  # Create nested nodes from a JSON file

  $ outlinedb node create --parent-id abc123 --json-file ./project-template.json



  # Create node under a path, creating missing segments (like mkdir -p)

  $ outlinedb node create --parent-path "Metadata,Scanner State,my-scanner" --name "state.json" --create-path
```

## `outlinedb node delete`

Delete a Workflowy node

```text
USAGE
  $ outlinedb node delete [-i <value> | -p <value>] [-d]

FLAGS
  -d, --dry-run       Show the API calls that would be made without executing
  -i, --id=<value>    ID of the node to delete
  -p, --path=<value>  Comma-separated path to the node (e.g., "Work,Tasks,Old Task")

DESCRIPTION
  Delete a Workflowy node

EXAMPLES
  # Delete node by ID

  $ outlinedb node delete --id abc123



  # Delete node by path

  $ outlinedb node delete --path "Work,Tasks,Completed Task"



  # Preview the API calls without deleting

  $ outlinedb node delete --id abc123 --dry-run
```

## `outlinedb node get`

Read a single Workflowy node with optional children

```text
USAGE
  $ outlinedb node get [-f] [-j] [--depth <value>] [-l] [--fields <value>...] [-i <value> | -p <value>] [-m]

FLAGS
  -f, --force-refresh      Force refresh from API, ignoring cache
  -i, --id=<value>         ID of the node to read (full UUID or 12-char short ID from URL)
  -j, --json               Output all node details in JSON format
  -l, --follow-links       Follow Workflowy links in node names to include linked node children (requires --depth > 0)
  -m, --follow-mirror      If the node is a mirror, follow it to the original node
  -p, --path=<value>       Comma-separated path to the node (e.g., "Work,Projects,My Project")
      --depth=<value>      Depth of children to fetch (0 = no children, 1 = direct children only, etc.)
      --fields=<value>...  Comma-separated list of fields to include in JSON output (e.g., "id,name,note,children").
                           Reduces output size for LLM processing.

DESCRIPTION
  Read a single Workflowy node with optional children

EXAMPLES
  # Read node by ID

  $ outlinedb node get --id abc123



  # Read node by short ID from Workflowy URL (12 hex chars)

  $ outlinedb node get --id c8708df23f1e



  # Read node by path

  $ outlinedb node get --path "Work,Projects,My Project"



  # Read node with children (depth 3)

  $ outlinedb node get --id abc123 --depth 3



  # Read node with full tree and follow links

  $ outlinedb node get --path "Personal,Inbox" --depth 5 --follow-links



  # Follow a mirror to its original node

  $ outlinedb node get --id abc123 --follow-mirror



  # Output as JSON

  $ outlinedb node get --id abc123 --json



  # Output JSON with only specific fields (reduces token usage for LLM processing)

  $ outlinedb node get --path "Metadata,Inboxes" --depth 3 --json --fields id,name,note,completed,children
```

## `outlinedb node list`

List Workflowy nodes by parent node ID

```text
USAGE
  $ outlinedb node list [-f] [-j] [--depth <value>] [-l] [--fields <value>...] [-p <value>] [-d auto|api|cache]
    [--incomplete]

FLAGS
  -d, --data-source=<option>  [default: auto] Data source to use: auto (default), api, or cache
                              <options: auto|api|cache>
  -f, --force-refresh         Force refresh from API, ignoring cache
  -j, --json                  Output all node details in JSON format
  -l, --follow-links          Follow Workflowy links in node names to include linked node children (requires --depth >
                              0)
  -p, --parent-id=<value>     Parent node ID (omit for root nodes)
      --depth=<value>         Depth of children to fetch (0 = no children, 1 = direct children only, etc.)
      --fields=<value>...     Comma-separated list of fields to include in JSON output (e.g., "id,name,note,children").
                              Reduces output size for LLM processing.
      --incomplete            Only show incomplete (not completed) nodes

DESCRIPTION
  List Workflowy nodes by parent node ID

EXAMPLES
  $ outlinedb node list

  $ outlinedb node list --parent-id abc123

  $ outlinedb node list --parent-id abc123 --force-refresh
```

## `outlinedb node mirror`

Create or remove a live Workflowy mirror of a node

```text
USAGE
  $ outlinedb node mirror [--node-id <value> | --node-path <value>] [--parent-id <value> | --parent-path <value>
    | --delete] [-p top|bottom] [--json]

FLAGS
  -p, --position=<option>    [default: top] Position within the parent
                             <options: top|bottom>
      --delete               Remove the mirror given by --node-id/--node-path; the origin is untouched
      --json                 Output the result as JSON (see `node schema --command mirror`)
      --node-id=<value>      ID of the node to mirror, or of the mirror to remove with --delete
      --node-path=<value>    Comma-separated path to the node to mirror, or to the mirror to remove with --delete
      --parent-id=<value>    ID of the parent to place the mirror under, a system target (e.g., "inbox"), or "home" for
                             the top level
      --parent-path=<value>  Comma-separated path to the parent to place the mirror under

DESCRIPTION
  Create or remove a live Workflowy mirror of a node

EXAMPLES
  # Mirror a node into another parent (top by default)

  $ outlinedb node mirror --node-id abc123 --parent-id def456



  # Mirror a node to the top level (Home); needs WORKFLOWY_USERNAME/WORKFLOWY_PASSWORD for the internal API

  $ outlinedb node mirror --node-id abc123 --parent-id home



  # Mirror by path, placing the mirror at the bottom

  $ outlinedb node mirror --node-path "Work,Tasks,My Task" --parent-path "Work,Agendas" --position bottom



  # Remove a mirror (pass the mirror node, not the origin)

  $ outlinedb node mirror --node-id mirror123 --delete
```

## `outlinedb node move`

Move a single node to a new location by ID or path

```text
USAGE
  $ outlinedb node move [--node-id <value> | --node-path <value>] [--parent-id <value> | --parent-path <value>]
    [-d] [-p top|bottom]

FLAGS
  -d, --dry-run              Show the exact CLI command to execute the move without actually moving
  -p, --position=<option>    Position within the destination parent (top or bottom)
                             <options: top|bottom>
      --node-id=<value>      ID of the node to move
      --node-path=<value>    Comma-separated path to the node to move (e.g., "Work,Tasks,My Task")
      --parent-id=<value>    ID of the destination parent node, a system target (e.g., "inbox"), or "home" for the top
                             level
      --parent-path=<value>  Comma-separated path to the destination parent node (e.g., "Work,Archive")

DESCRIPTION
  Move a single node to a new location by ID or path

EXAMPLES
  # Move node to inbox (system target)

  $ outlinedb node move --node-id abc123 --parent-id inbox



  # Move node to the top level (Home)

  $ outlinedb node move --node-id abc123 --parent-id home



  # Move node by ID to parent ID

  $ outlinedb node move --node-id abc123 --parent-id def456



  # Move node by path to parent path

  $ outlinedb node move --node-path "Work,Tasks,My Task" --parent-path "Work,Archive"



  # Move node to bottom of parent (default is top)

  $ outlinedb node move --node-id abc123 --parent-id def456 --position bottom



  # Preview the move command without executing

  $ outlinedb node move --node-id abc123 --parent-id inbox --dry-run



  # Mixed: move by ID to path

  $ outlinedb node move --node-id abc123 --parent-path "Work,Archive"
```

## `outlinedb node schema`

Show JSON output schema for node commands (for LLM discovery)

```text
USAGE
  $ outlinedb node schema [-c get|list|search|changes|mirror]

FLAGS
  -c, --command=<option>  Which command output type to show
                          <options: get|list|search|changes|mirror>

DESCRIPTION
  Show JSON output schema for node commands (for LLM discovery)

EXAMPLES
  # Show all command output schemas

  $ outlinedb node schema



  # Show schema for a specific command

  $ outlinedb node schema --command get
```

## `outlinedb node search`

Search Workflowy nodes by text in names and notes

```text
USAGE
  $ outlinedb node search -q <value> [-l <value>] [--incomplete] [-j]

FLAGS
  -j, --json           Output results in JSON format
  -l, --limit=<value>  [default: 20] Maximum number of results to return
  -q, --query=<value>  (required) Text to search for in node names and notes
      --incomplete     Only show incomplete (not completed) nodes

DESCRIPTION
  Search Workflowy nodes by text in names and notes

EXAMPLES
  $ outlinedb node search --query "meeting notes"

  $ outlinedb node search -q "project ideas" --limit 10

  $ outlinedb node search --query "TODO" --json

  $ outlinedb node search --query "#llm-task" --incomplete
```

## `outlinedb node uncomplete`

Mark a Workflowy node as not completed

```text
USAGE
  $ outlinedb node uncomplete [-i <value> | -p <value>] [-d]

FLAGS
  -d, --dry-run       Show the API call that would be made without executing
  -i, --id=<value>    ID of the node
  -p, --path=<value>  Comma-separated path to the node (e.g., "Work,Tasks,My Task")

DESCRIPTION
  Mark a Workflowy node as not completed

EXAMPLES
  # Uncomplete node by ID

  $ outlinedb node uncomplete --id abc123



  # Uncomplete node by path

  $ outlinedb node uncomplete --path "Work,Tasks,My Task"



  # Preview the API call without executing

  $ outlinedb node uncomplete --id abc123 --dry-run



  # With verbose logging

  $ outlinedb node uncomplete --id abc123 --verbose
```

## `outlinedb node update`

Update a Workflowy node

```text
USAGE
  $ outlinedb node update [-i <value> | -p <value>] [-n <value> | --clear-name] [--note <value> | --clear-note]
    [--layout-mode <value>] [--expect-name <value>] [-d]

FLAGS
  -d, --dry-run              Show the API call that would be made without executing
  -i, --id=<value>           ID of the node to update
  -n, --name=<value>         New name for the node
  -p, --path=<value>         Comma-separated path to the node (e.g., "Work,Tasks,My Task")
      --clear-name           Clear the node's name (on a mirror, its original's name).
      --clear-note           Clear the note from the node
      --expect-name=<value>  Refuse the update unless the node's current name exactly equals this value (guards against
                             overwriting text that changed since it was read)
      --layout-mode=<value>  Layout mode for the node (e.g., "todo", "document", "board")
      --note=<value>         New note/description for the node

DESCRIPTION
  Update a Workflowy node

EXAMPLES
  # Update node name by ID

  $ outlinedb node update --id abc123 --name "Updated Task"



  # Update node by path

  $ outlinedb node update --path "Work,Tasks,Old Name" --name "New Name"



  # Update note only

  $ outlinedb node update --id abc123 --note "Additional details"



  # Update both name and note

  $ outlinedb node update --id abc123 --name "Updated" --note "With note"



  # Clear the note from a node

  $ outlinedb node update --id abc123 --clear-note



  # Clear a node's name

  $ outlinedb node update --id abc123 --clear-name



  # Preview the API call without updating

  $ outlinedb node update --id abc123 --name "Updated" --dry-run
```

## `outlinedb utils format-node`

Format a single node from JSON input with name and URL

```text
USAGE
  $ outlinedb utils format-node

DESCRIPTION
  Format a single node from JSON input with name and URL

EXAMPLES
  # Format a node from JSON

  echo '{"id":"722bccf5-e821-9a59-4380-3247da821f97","name":"Projects"}' | outlinedb utils format-node



  # Format a node with HTML styling

  echo '{"id":"abc123","name":"<span class=\"colored c-red\">Important</span>"}' | outlinedb utils format-node



  # Chain with other commands

  $ outlinedb node:get --id abc123 --json | outlinedb utils format-node
```

## `outlinedb utils path-to-id`

Resolve a Workflowy path to a node ID

```text
USAGE
  $ outlinedb utils path-to-id -p <value> [-r <value>] [-d auto|api|cache]

FLAGS
  -d, --data-source=<option>  [default: auto] Data source to use: auto (default), api, or cache
                              <options: auto|api|cache>
  -p, --path=<value>          (required) Comma-separated path to the node (e.g., "Work,Projects,My Project")
  -r, --root-id=<value>       Root node ID to start path from (omit for root level)

DESCRIPTION
  Resolve a Workflowy path to a node ID

EXAMPLES
  # Resolve a path to get the node ID

  $ outlinedb utils path-to-id --path "Work,Projects,My Project"



  # Use with node:list for composition

  $ outlinedb utils path-to-id --path "Work,Calendar" | xargs outlinedb node:list --id



  # Resolve from a custom root node

  $ outlinedb utils path-to-id --root-id abc123 --path "Tasks,Today"



  # Use cache-only mode (no API calls)

  $ outlinedb utils path-to-id --path "Home,Inbox" --data-source cache
```

<!-- commandsstop -->
