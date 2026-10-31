<!-- markdownlint-disable-file MD025 -->

# workflowy-cli

CLI for managing Workflowy nodes via API.

Why this project merges several data sources: see [docs/workflowy-data-sources.md](docs/workflowy-data-sources.md).

<!-- toc -->

- [workflowy-cli](#workflowy-cli)
- [Usage](#usage)
- [Commands](#commands) <!-- tocstop -->

# Usage

<!-- usage -->

```sh-session
$ npm install -g workflowy-cli
$ workflowy COMMAND
running command...
$ workflowy (--version)
workflowy-cli/0.1.0 linux-x64 node-v26.3.0
$ workflowy --help [COMMAND]
USAGE
  $ workflowy COMMAND
...
```

<!-- usagestop -->

# Commands

<!-- commands -->

- [`workflowy ai embed`](#workflowy-ai-embed)
- [`workflowy ai qmd-embed`](#workflowy-ai-qmd-embed)
- [`workflowy ai qmd-search`](#workflowy-ai-qmd-search)
- [`workflowy ai search`](#workflowy-ai-search)
- [`workflowy backups archive`](#workflowy-backups-archive)
- [`workflowy cache import-api`](#workflowy-cache-import-api)
- [`workflowy cache import-backup`](#workflowy-cache-import-backup)
- [`workflowy cache import-backups`](#workflowy-cache-import-backups)
- [`workflowy cache status`](#workflowy-cache-status)
- [`workflowy cache sync-node`](#workflowy-cache-sync-node)
- [`workflowy cache temporal-rollback`](#workflowy-cache-temporal-rollback)
- [`workflowy cache vacuum`](#workflowy-cache-vacuum)
- [`workflowy calendar migrate-dates`](#workflowy-calendar-migrate-dates)
- [`workflowy dropbox auth`](#workflowy-dropbox-auth)
- [`workflowy dropbox download-backup`](#workflowy-dropbox-download-backup)
- [`workflowy dropbox list-backups`](#workflowy-dropbox-list-backups)
- [`workflowy gtd inboxes load`](#workflowy-gtd-inboxes-load)
- [`workflowy gtd journal dedup`](#workflowy-gtd-journal-dedup)
- [`workflowy gtd metadata sync`](#workflowy-gtd-metadata-sync)
- [`workflowy gtd otter api COMMAND`](#workflowy-gtd-otter-api-command)
- [`workflowy gtd otter import`](#workflowy-gtd-otter-import)
- [`workflowy gtd otter sync`](#workflowy-gtd-otter-sync)
- [`workflowy gtd tasks load`](#workflowy-gtd-tasks-load)
- [`workflowy gtd tasks load-declined`](#workflowy-gtd-tasks-load-declined)
- [`workflowy help [COMMAND]`](#workflowy-help-command)
- [`workflowy node changes`](#workflowy-node-changes)
- [`workflowy node complete`](#workflowy-node-complete)
- [`workflowy node create`](#workflowy-node-create)
- [`workflowy node delete`](#workflowy-node-delete)
- [`workflowy node get`](#workflowy-node-get)
- [`workflowy node list`](#workflowy-node-list)
- [`workflowy node move`](#workflowy-node-move)
- [`workflowy node schema`](#workflowy-node-schema)
- [`workflowy node search`](#workflowy-node-search)
- [`workflowy node uncomplete`](#workflowy-node-uncomplete)
- [`workflowy node update`](#workflowy-node-update)
- [`workflowy workflowy utils format-node`](#workflowy-workflowy-utils-format-node)
- [`workflowy workflowy utils path-to-id`](#workflowy-workflowy-utils-path-to-id)

## `workflowy ai embed`

Generate vector embeddings for all Workflowy nodes

```text
USAGE
  $ workflowy ai embed [-b <value>] [-f] [-m minilm|mpnet|bge|openai-small|openai-large]

FLAGS
  -b, --batch-size=<value>  [default: 20] Number of nodes to process in each batch
  -f, --force               Regenerate embeddings for nodes that already have them
  -m, --model=<option>      Embedding model to use (generates for local models by default)
                            <options: minilm|mpnet|bge|openai-small|openai-large>

DESCRIPTION
  Generate vector embeddings for all Workflowy nodes

EXAMPLES
  $ workflowy ai embed

  $ workflowy ai embed --batch-size 50

  $ workflowy ai embed --force
```

## `workflowy ai qmd-embed`

Sync Workflowy nodes into qmd index and generate embeddings

```text
USAGE
  $ workflowy ai qmd-embed [-f]

FLAGS
  -f, --force  Re-embed all documents (clear existing embeddings first)

DESCRIPTION
  Sync Workflowy nodes into qmd index and generate embeddings

EXAMPLES
  $ workflowy ai qmd-embed

  $ workflowy ai qmd-embed --force
```

## `workflowy ai qmd-search`

Search Workflowy nodes using qmd hybrid search (BM25 + vector + LLM reranking)

```text
USAGE
  $ workflowy ai qmd-search -q <value> [-j] [-l <value>] [-t <value>] [-d] [-m hybrid|vector|keyword]

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
  $ workflowy ai qmd-search --query "project ideas"

  $ workflowy ai qmd-search --query "meeting notes" --mode keyword

  $ workflowy ai qmd-search --query "API design" --mode vector

  $ workflowy ai qmd-search --query "tasks" --limit 10 --json
```

## `workflowy ai search`

Semantically search through Workflowy nodes using vector embeddings

```text
USAGE
  $ workflowy ai search -q <value> [-j] [-l <value>] [-t <value>] [-d] [-m
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
  $ workflowy ai search --query "project ideas"

  $ workflowy ai search --query "meeting notes from last week" --limit 10

  $ workflowy ai search -q "tasks about refactoring" --threshold 0.3 # stricter matching

  $ workflowy ai search --query "API" --model bge # use specific model

  $ workflowy ai search --query "API" --json | jq

  $ workflowy ai search --query "API" --mode hybrid # BM25 + vector fusion
```

## `workflowy backups archive`

Compress local backups: keep recent days as per-file .zst, fold older days into solid monthly archives

```text
USAGE
  $ workflowy backups archive [--keep-days <value>] [--source Data|History]

FLAGS
  --keep-days=<value>  [default: 30] Days of backups to keep as individually compressed files before folding into
                       monthly archives
  --source=<option>    Limit to a single backup source
                       <options: Data|History>

DESCRIPTION
  Compress local backups: keep recent days as per-file .zst, fold older days into solid monthly archives

EXAMPLES
  $ workflowy backups:archive

  $ workflowy backups:archive --keep-days 60

  $ workflowy backups:archive --source Data
```

## `workflowy cache import-api`

Import all nodes from Workflowy API export endpoint

```text
USAGE
  $ workflowy cache import-api [-d] [-v]

FLAGS
  -d, --dry-run  Show what would be imported without making changes
  -v, --verbose  Show detailed timing information

DESCRIPTION
  Import all nodes from Workflowy API export endpoint

EXAMPLES
  $ workflowy cache:import-api

  $ workflowy cache:import-api --dry-run
```

## `workflowy cache import-backup`

Import a Workflowy backup file into the cache database

```text
USAGE
  $ workflowy cache import-backup [-f <value>] [--latest] [--embeddings] [-b <value>] [-y] [--force]

FLAGS
  -b, --batch-size=<value>  [default: 20] Number of nodes to process in each embedding batch
  -f, --file=<value>        Path to the backup file
  -y, --yes                 Skip confirmation prompts
      --[no-]embeddings     Generate embeddings after import
      --force               Bypass the stale-snapshot watermark guard and import even if the cache has newer data
      --latest              Import the most recent backup file from current directory

DESCRIPTION
  Import a Workflowy backup file into the cache database

EXAMPLES
  $ workflowy cache:import-backup --file backup.json

  $ workflowy cache:import-backup --file /path/to/backup.workflowy.backup

  $ workflowy cache:import-backup --file backup.json --no-embeddings

  $ workflowy cache:import-backup --latest
```

## `workflowy cache import-backups`

Import all missing backups from Dropbox into cache

```text
USAGE
  $ workflowy cache import-backups [--embeddings] [-b <value>]

FLAGS
  -b, --batch-size=<value>  [default: 20] Number of nodes to process in each embedding batch
      --[no-]embeddings     Generate embeddings after import

DESCRIPTION
  Import all missing backups from Dropbox into cache

EXAMPLES
  $ workflowy cache:import-backups

  $ workflowy cache:import-backups --no-embeddings

  $ workflowy cache:import-backups --batch-size 50
```

## `workflowy cache status`

Show cache database status and statistics

```text
USAGE
  $ workflowy cache status [--json]

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Show cache database status and statistics

EXAMPLES
  $ workflowy cache:status

  $ workflowy cache:status --json
```

## `workflowy cache sync-node`

Sync a specific node and optionally its children from the Workflowy API to the cache

```text
USAGE
  $ workflowy cache sync-node [-i <value> | -p <value>] [-r]

FLAGS
  -i, --id=<value>    Node ID to sync
  -p, --path=<value>  Path to the node (comma-separated)
  -r, --recursive     Recursively sync all children

DESCRIPTION
  Sync a specific node and optionally its children from the Workflowy API to the cache

EXAMPLES
  $ workflowy cache:sync-node --id 61111c3a-e939-d4dc-1a8c-6bf42551caa3

  $ workflowy cache:sync-node --path Personal,Journal

  $ workflowy cache:sync-node --path Work,Projects --recursive

  $ workflowy cache:sync-node --id 39caff96-e338-0f20-55f2-65f9e140ba02 --recursive
```

## `workflowy cache temporal-rollback`

Roll back all temporal tables to a previous point in time. This is a destructive operation for disaster recovery.

```text
USAGE
  $ workflowy cache temporal-rollback --to <value> [--exclude <value>...] [--dry-run] [-y]

FLAGS
  -y, --yes                 Skip confirmation prompt
      --dry-run             Show row counts without executing
      --exclude=<value>...  [default: ] Table to exclude from rollback (repeatable)
      --to=<value>          (required) Target timestamp to roll back to (e.g., "2026-01-23 00:00:00")

DESCRIPTION
  Roll back all temporal tables to a previous point in time. This is a destructive operation for disaster recovery.

EXAMPLES
  $ workflowy cache:temporal-rollback --to "2026-01-23 00:00:00" --dry-run

  $ workflowy cache:temporal-rollback --to "2026-01-23 00:00:00" --exclude node_embeddings

  $ workflowy cache:temporal-rollback --to "2026-01-23 00:00:00" --exclude node_embeddings --yes
```

## `workflowy cache vacuum`

Reclaim dead pages from the cache database by running VACUUM, shrinking the file on disk

```text
USAGE
  $ workflowy cache vacuum [--json]

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Reclaim dead pages from the cache database by running VACUUM, shrinking the file on disk

EXAMPLES
  $ workflowy cache:vacuum

  $ workflowy cache:vacuum --json
```

## `workflowy calendar migrate-dates`

Convert text dates to native Workflowy dates in calendar archive day nodes

```text
USAGE
  $ workflowy calendar migrate-dates [-d] [-a <value>] [-b <value>] [-D <value>] [--year <value>]

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

  $ workflowy calendar migrate-dates --dry-run



  # Test with a specific year first

  $ workflowy calendar migrate-dates --dry-run --year 2017



  # Execute migration for one year

  $ workflowy calendar migrate-dates --year 2017



  # Execute full migration with custom delay

  $ workflowy calendar migrate-dates --delay 300
```

## `workflowy dropbox auth`

Authenticate with Dropbox to get a refresh token

```text
USAGE
  $ workflowy dropbox auth

DESCRIPTION
  Authenticate with Dropbox to get a refresh token

EXAMPLES
  $ workflowy dropbox auth
```

## `workflowy dropbox download-backup`

Download all Workflowy backups from Dropbox that are not already downloaded locally

```text
USAGE
  $ workflowy dropbox download-backup [--json] [-f Data|History] [-d <value>] [-q]

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
  $ workflowy dropbox download-backup

  $ workflowy dropbox download-backup --folder History

  $ workflowy dropbox download-backup --date 2025-11-06

  $ workflowy dropbox download-backup --json | jq -r ".downloaded[].path"
```

## `workflowy dropbox list-backups`

List all available Workflowy backup files in Dropbox from both Data and History folders

```text
USAGE
  $ workflowy dropbox list-backups [-a]

FLAGS
  -a, --all  List backups from all folders (Data and History)

DESCRIPTION
  List all available Workflowy backup files in Dropbox from both Data and History folders

EXAMPLES
  $ workflowy dropbox list-backups
```

## `workflowy gtd inboxes load`

Load inbox items from Workflowy for GTD processing

```text
USAGE
  $ workflowy gtd inboxes load [--depth <value>]

FLAGS
  --depth=<value>  Depth of children to fetch for each inbox item (0 = none, max 10)

DESCRIPTION
  Load inbox items from Workflowy for GTD processing

EXAMPLES
  # Load all inbox items

  $ workflowy gtd inboxes load

  # Load with children (depth 3 for refinement nodes)

  $ workflowy gtd inboxes load --depth 3
```

## `workflowy gtd journal dedup`

Deduplicate journal entries against existing calendar

```text
USAGE
  $ workflowy gtd journal dedup [--json] [-t <value>]

FLAGS
  -t, --threshold=<value>  [default: 0.55] Similarity threshold (0.0-1.0)

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Deduplicate journal entries against existing calendar

EXAMPLES
  # Run deduplication analysis

  $ workflowy gtd journal dedup



  # Use custom threshold

  $ workflowy gtd journal dedup --threshold 0.6
```

## `workflowy gtd metadata sync`

Sync GTD metadata from Workflowy to local JSON

```text
USAGE
  $ workflowy gtd metadata sync [-s cache|api]

FLAGS
  -s, --data-source=<option>  [default: cache] Data source to use
                              <options: cache|api>

DESCRIPTION
  Sync GTD metadata from Workflowy to local JSON

EXAMPLES
  # Sync metadata from cache (default)

  $ workflowy gtd metadata sync



  # Force sync from API

  $ workflowy gtd metadata sync --data-source api
```

## `workflowy gtd otter api COMMAND`

Otter.ai API wrapper for fetching meetings

```text
USAGE
  $ workflowy gtd otter api COMMAND [--otid <value>] [--page-size <value>] [--cursor <value>] [--modified-after
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

  $ workflowy gtd otter api available_speeches



  # Get speech details

  $ workflowy gtd otter api speech --otid abc123



  # Get action items for a speech

  $ workflowy gtd otter api action_items --otid abc123
```

## `workflowy gtd otter import`

Import Otter meetings to Workflowy Calendar

```text
USAGE
  $ workflowy gtd otter import [-d <value>] [-m <value>] [--reset] [--calendar-id <value>] [--dry-run]

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

  $ workflowy gtd otter import



  # Import with custom delay and max count

  $ workflowy gtd otter import --delay 3 --max 10



  # Reset state and start fresh

  $ workflowy gtd otter import --reset
```

## `workflowy gtd otter sync`

Sync Otter meetings with action items

```text
USAGE
  $ workflowy gtd otter sync [--page-size <value>] [--cursor <value>] [--modified-after <value>] [--concurrency
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

  $ workflowy gtd otter sync



  # Sync with pagination

  $ workflowy gtd otter sync --page-size 100
```

## `workflowy gtd tasks load`

Load existing tasks for duplicate detection

```text
USAGE
  $ workflowy gtd tasks load [--json] [-l <value>]

FLAGS
  -l, --lookback-days=<value>  [default: 7] Number of days to look back for recent meetings

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Load existing tasks for duplicate detection

EXAMPLES
  # Load existing tasks (requires metadata.json)

  $ workflowy gtd tasks load



  # Output as formatted JSON

  $ workflowy gtd tasks load --json
```

## `workflowy gtd tasks load-declined`

Load declined items from Session Memory

```text
USAGE
  $ workflowy gtd tasks load-declined [--json] [-l <value>]

FLAGS
  -l, --lookback-days=<value>  [default: 7] Number of days to look back

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Load declined items from Session Memory

EXAMPLES
  # Load declined items from the last 7 days (default)

  $ workflowy gtd tasks load-declined



  # Load declined items from the last 14 days

  $ workflowy gtd tasks load-declined --lookback-days 14
```

## `workflowy help [COMMAND]`

Display help for workflowy.

```text
USAGE
  $ workflowy help [COMMAND...] [-n]

ARGUMENTS
  [COMMAND...]  Command to show help for.

FLAGS
  -n, --nested-commands  Include all nested commands in the output.

DESCRIPTION
  Display help for workflowy.
```

_See code: [@oclif/plugin-help](https://github.com/oclif/plugin-help/blob/6.2.53/src/commands/help.ts)_

## `workflowy node changes`

Show nodes changed since a given time

```text
USAGE
  $ workflowy node changes [-s <value>] [--json]

FLAGS
  -s, --since=<value>  [default: 1d] Time range: duration (1d, 12h, 1w) or ISO date
      --json           Output as JSON

DESCRIPTION
  Show nodes changed since a given time

EXAMPLES
  $ workflowy node changes

  $ workflowy node changes --since 2d

  $ workflowy node changes --since 12h

  $ workflowy node changes --since 2026-02-01

  $ workflowy node changes --json
```

## `workflowy node complete`

Mark a Workflowy node as completed

```text
USAGE
  $ workflowy node complete [-i <value> | -p <value>] [-d]

FLAGS
  -d, --dry-run       Show the API call that would be made without executing
  -i, --id=<value>    ID of the node
  -p, --path=<value>  Comma-separated path to the node (e.g., "Work,Tasks,My Task")

DESCRIPTION
  Mark a Workflowy node as completed

EXAMPLES
  # Complete node by ID

  $ workflowy node complete --id abc123



  # Complete node by path

  $ workflowy node complete --path "Work,Tasks,My Task"



  # Preview the API call without executing

  $ workflowy node complete --id abc123 --dry-run



  # With verbose logging

  $ workflowy node complete --id abc123 --verbose
```

## `workflowy node create`

Create a new Workflowy node or tree of nodes from JSON

```text
USAGE
  $ workflowy node create [-n <value> | --json <value> | --json-file <value>] [--parent-id <value> |
    --parent-path <value>] [--note <value>] [--layout-mode <value>] [--position top|bottom] [-d] [--create-path]

FLAGS
  -d, --dry-run              Show the API call that would be made without executing
  -n, --name=<value>         Name of the new node (use "-" to read from stdin; markdown will be parsed into children)
      --create-path          Create missing parent path segments (like mkdir -p)
      --json=<value>         JSON structure defining a tree of nodes to create
      --json-file=<value>    Path to a JSON file defining a tree of nodes to create
      --layout-mode=<value>  Layout mode for the node (e.g., "document", "list", "board")
      --note=<value>         Note/description for the node
      --parent-id=<value>    ID of parent node or system target (e.g., "inbox")
      --parent-path=<value>  Comma-separated path to parent node (e.g., "Work,Projects")
      --position=<option>    Position among siblings: "top" (first) or "bottom" (last, default)
                             <options: top|bottom>

DESCRIPTION
  Create a new Workflowy node or tree of nodes from JSON

EXAMPLES
  # Create node in inbox (system target)

  $ workflowy node create --parent-id inbox --name "New Task"



  # Create node under a parent by ID

  $ workflowy node create --parent-id abc123 --name "Subtask"



  # Create node under a parent by path

  $ workflowy node create --parent-path "Work,Projects" --name "Subtask"



  # Create node with a specific layout mode

  $ workflowy node create --parent-id abc123 --name "Notes" --layout-mode document



  # Create from stdin (use - for name)

  echo "## Section 1\n\nParagraph text" | workflowy node create --parent-id abc123 --name -



  # Import article content via clean-mark

  npx clean-mark https://example.com/article --stdout | workflowy node create --parent-id abc123 --name -



  # Preview the API call without creating

  $ workflowy node create --parent-id inbox --name "New Task" --dry-run



  # Create nested nodes from inline JSON

  $ workflowy node create --parent-id abc123 --json '{"name": "Project", "children": [{"name": "Task 1"}, {"name": "Task 2"}]}'



  # Create nested nodes from a JSON file

  $ workflowy node create --parent-id abc123 --json-file ./project-template.json



  # Create node under a path, creating missing segments (like mkdir -p)

  $ workflowy node create --parent-path "Metadata,Scanner State,my-scanner" --name "state.json" --create-path
```

## `workflowy node delete`

Delete a Workflowy node

```text
USAGE
  $ workflowy node delete [-i <value> | -p <value>] [-d]

FLAGS
  -d, --dry-run       Show the API call that would be made without executing
  -i, --id=<value>    ID of the node to delete
  -p, --path=<value>  Comma-separated path to the node (e.g., "Work,Tasks,Old Task")

DESCRIPTION
  Delete a Workflowy node

EXAMPLES
  # Delete node by ID

  $ workflowy node delete --id abc123



  # Delete node by path

  $ workflowy node delete --path "Work,Tasks,Completed Task"



  # Preview the API call without deleting

  $ workflowy node delete --id abc123 --dry-run
```

## `workflowy node get`

Read a single Workflowy node with optional children

```text
USAGE
  $ workflowy node get [-f] [-j] [--depth <value>] [-l] [--fields <value>...] [-i <value> | -p <value>] [-m]

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

  $ workflowy node get --id abc123



  # Read node by short ID from Workflowy URL (12 hex chars)

  $ workflowy node get --id c8708df23f1e



  # Read node by path

  $ workflowy node get --path "Work,Projects,My Project"



  # Read node with children (depth 3)

  $ workflowy node get --id abc123 --depth 3



  # Read node with full tree and follow links

  $ workflowy node get --path "Personal,Inbox" --depth 5 --follow-links



  # Follow a mirror to its original node

  $ workflowy node get --id abc123 --follow-mirror



  # Output as JSON

  $ workflowy node get --id abc123 --json



  # Output JSON with only specific fields (reduces token usage for LLM processing)

  $ workflowy node get --path "Metadata,Inboxes" --depth 3 --json --fields id,name,note,completed,children
```

## `workflowy node list`

List Workflowy nodes by parent node ID

```text
USAGE
  $ workflowy node list [-f] [-j] [--depth <value>] [-l] [--fields <value>...] [-p <value>] [-d auto|api|cache]
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
  $ workflowy node list

  $ workflowy node list --parent-id abc123

  $ workflowy node list --parent-id abc123 --force-refresh
```

## `workflowy node move`

Move a single node to a new location by ID or path

```text
USAGE
  $ workflowy node move [--node-id <value> | --node-path <value>] [--parent-id <value> | --parent-path <value>]
    [-d] [-p top|bottom]

FLAGS
  -d, --dry-run              Show the exact CLI command to execute the move without actually moving
  -p, --position=<option>    Position within the destination parent (top or bottom)
                             <options: top|bottom>
      --node-id=<value>      ID of the node to move
      --node-path=<value>    Comma-separated path to the node to move (e.g., "Work,Tasks,My Task")
      --parent-id=<value>    ID of the destination parent node or system target (e.g., "inbox")
      --parent-path=<value>  Comma-separated path to the destination parent node (e.g., "Work,Archive")

DESCRIPTION
  Move a single node to a new location by ID or path

EXAMPLES
  # Move node to inbox (system target)

  $ workflowy node move --node-id abc123 --parent-id inbox



  # Move node by ID to parent ID

  $ workflowy node move --node-id abc123 --parent-id def456



  # Move node by path to parent path

  $ workflowy node move --node-path "Work,Tasks,My Task" --parent-path "Work,Archive"



  # Move node to bottom of parent (default is top)

  $ workflowy node move --node-id abc123 --parent-id def456 --position bottom



  # Preview the move command without executing

  $ workflowy node move --node-id abc123 --parent-id inbox --dry-run



  # Mixed: move by ID to path

  $ workflowy node move --node-id abc123 --parent-path "Work,Archive"
```

## `workflowy node schema`

Show JSON output schema for node commands (for LLM discovery)

```text
USAGE
  $ workflowy node schema [-c get|list|search|changes]

FLAGS
  -c, --command=<option>  Which command output type to show
                          <options: get|list|search|changes>

DESCRIPTION
  Show JSON output schema for node commands (for LLM discovery)

EXAMPLES
  # Show all command output schemas

  $ workflowy node schema



  # Show schema for a specific command

  $ workflowy node schema --command get
```

## `workflowy node search`

Search Workflowy nodes by text in names and notes

```text
USAGE
  $ workflowy node search -q <value> [-l <value>] [--incomplete] [-j]

FLAGS
  -j, --json           Output results in JSON format
  -l, --limit=<value>  [default: 20] Maximum number of results to return
  -q, --query=<value>  (required) Text to search for in node names and notes
      --incomplete     Only show incomplete (not completed) nodes

DESCRIPTION
  Search Workflowy nodes by text in names and notes

EXAMPLES
  $ workflowy node search --query "meeting notes"

  $ workflowy node search -q "project ideas" --limit 10

  $ workflowy node search --query "TODO" --json

  $ workflowy node search --query "#llm-task" --incomplete
```

## `workflowy node uncomplete`

Mark a Workflowy node as not completed

```text
USAGE
  $ workflowy node uncomplete [-i <value> | -p <value>] [-d]

FLAGS
  -d, --dry-run       Show the API call that would be made without executing
  -i, --id=<value>    ID of the node
  -p, --path=<value>  Comma-separated path to the node (e.g., "Work,Tasks,My Task")

DESCRIPTION
  Mark a Workflowy node as not completed

EXAMPLES
  # Uncomplete node by ID

  $ workflowy node uncomplete --id abc123



  # Uncomplete node by path

  $ workflowy node uncomplete --path "Work,Tasks,My Task"



  # Preview the API call without executing

  $ workflowy node uncomplete --id abc123 --dry-run



  # With verbose logging

  $ workflowy node uncomplete --id abc123 --verbose
```

## `workflowy node update`

Update a Workflowy node

```text
USAGE
  $ workflowy node update [-i <value> | -p <value>] [-n <value>] [--note <value> | --clear-note] [--layout-mode
    <value>] [-d]

FLAGS
  -d, --dry-run              Show the API call that would be made without executing
  -i, --id=<value>           ID of the node to update
  -n, --name=<value>         New name for the node
  -p, --path=<value>         Comma-separated path to the node (e.g., "Work,Tasks,My Task")
      --clear-note           Clear the note from the node
      --layout-mode=<value>  Layout mode for the node (e.g., "todo", "document", "board")
      --note=<value>         New note/description for the node

DESCRIPTION
  Update a Workflowy node

EXAMPLES
  # Update node name by ID

  $ workflowy node update --id abc123 --name "Updated Task"



  # Update node by path

  $ workflowy node update --path "Work,Tasks,Old Name" --name "New Name"



  # Update note only

  $ workflowy node update --id abc123 --note "Additional details"



  # Update both name and note

  $ workflowy node update --id abc123 --name "Updated" --note "With note"



  # Clear the note from a node

  $ workflowy node update --id abc123 --clear-note



  # Preview the API call without updating

  $ workflowy node update --id abc123 --name "Updated" --dry-run
```

## `workflowy workflowy utils format-node`

Format a single node from JSON input with name and URL

```text
USAGE
  $ workflowy workflowy utils format-node

DESCRIPTION
  Format a single node from JSON input with name and URL

EXAMPLES
  # Format a node from JSON

  echo '{"id":"722bccf5-e821-9a59-4380-3247da821f97","name":"Projects"}' | workflowy workflowy utils format-node



  # Format a node with HTML styling

  echo '{"id":"abc123","name":"<span class=\"colored c-red\">Important</span>"}' | workflowy workflowy utils format-node



  # Chain with other commands

  $ workflowy node:get --id abc123 --json | workflowy workflowy utils format-node
```

## `workflowy workflowy utils path-to-id`

Resolve a Workflowy path to a node ID

```text
USAGE
  $ workflowy workflowy utils path-to-id -p <value> [-r <value>] [-d auto|api|cache]

FLAGS
  -d, --data-source=<option>  [default: auto] Data source to use: auto (default), api, or cache
                              <options: auto|api|cache>
  -p, --path=<value>          (required) Comma-separated path to the node (e.g., "Work,Projects,My Project")
  -r, --root-id=<value>       Root node ID to start path from (omit for root level)

DESCRIPTION
  Resolve a Workflowy path to a node ID

EXAMPLES
  # Resolve a path to get the node ID

  $ workflowy workflowy utils path-to-id --path "Work,Projects,My Project"



  # Use with node:list for composition

  $ workflowy workflowy utils path-to-id --path "Work,Calendar" | xargs workflowy node:list --id



  # Resolve from a custom root node

  $ workflowy workflowy utils path-to-id --root-id abc123 --path "Tasks,Today"



  # Use cache-only mode (no API calls)

  $ workflowy workflowy utils path-to-id --path "Home,Inbox" --data-source cache
```

<!-- commandsstop -->
