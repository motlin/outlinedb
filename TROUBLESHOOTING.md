# Troubleshooting Guide

## Database Queries Return 0 Nodes

### Problem

SQLite queries like the following return 0 or empty results:

```bash
sqlite3 outlinedb.sqlite "SELECT COUNT(*) FROM nodes"
# Returns: 0

sqlite3 outlinedb.sqlite "SELECT name FROM nodes WHERE completed_at IS NOT NULL LIMIT 10"
# Returns: (empty)
```

### Cause

The `nodes` table is empty because no data has been imported yet. The application requires either:

1. API data to be fetched and stored via the CLI commands
2. A backup file to be imported

### Solution

Import a Workflowy backup file using the cache import-backup command:

```bash
./bin/run.js cache import-backup --file "(alice@example.com).2025-09-07.workflowy.backup"
```

To see verbose SQL logging, set the environment variables:

```bash
# Log SQL queries (SELECT, INSERT, UPDATE, DELETE statements)
export OUTLINEDB_SQL_QUERY_LOGGING=true

# Log SQL query results (full JSON output)
export OUTLINEDB_SQL_RESULTS_LOGGING=true
```

After importing, the nodes table will be populated and queries will return data:

```bash
sqlite3 outlinedb.sqlite "SELECT COUNT(*) FROM nodes"
# Returns: 95009

sqlite3 outlinedb.sqlite "SELECT name FROM nodes WHERE completed_at IS NOT NULL LIMIT 10"
# Returns: (list of completed nodes)
```

### How It Works

- The application uses three tables: `nodes`, `api_data`, and `backup_data`
- The `nodes` table stores the actual node data
- The `api_data` and `backup_data` tables store raw JSON and metadata
- Data flows into `nodes` table through:
    - `CacheService.importBackup()` - imports from backup files
    - `CacheService.storeApiResponse()` - stores API responses
- Without running either import method, the `nodes` table remains empty
