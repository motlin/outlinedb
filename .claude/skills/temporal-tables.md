---
description: Query patterns for temporal tables with system_from/system_to validity periods
---

# Temporal Table Query Patterns

When working with temporal tables (tables with `system_from` and `system_to` columns), the query pattern is:

**Correct: Use strict inequality (system_from <= T AND system_to > T)**

```sql
WHERE system_from <= '2024-06-15 14:30:00' AND system_to > '2024-06-15 14:30:00'
```

This ensures exactly one row matches at any point in time, even when rows have contiguous timestamps (system_to of row N = system_from of row N+1). Do NOT use `BETWEEN` because `<=` on both sides would match two rows at the boundary.

**Wrong: Check if system_from is BETWEEN two dates**

```sql
-- This is NOT how temporal tables work
WHERE system_from BETWEEN '2024-01-01 00:00:00' AND '2024-12-31 23:59:59'
```

Temporal tables store validity periods. We query "what was valid at this point in time?" not "when did this validity period start?"

## Timestamp Format

All temporal columns use UTC ISO8601 TEXT with millisecond precision: `YYYY-MM-DD HH:MM:SS.sss` (`formatTemporalTimestamp` in `packages/shared/src/temporal/constants.ts`).

- `system_from`: Start of validity period. It has no column default; the writer stamps it with the unit of work's system time (see Composites).
- `system_to`: End of validity period, `9999-12-31 23:59:59` (`FAR_FUTURE_DATE`) for current records.

## Keys and Indexes

- The primary key is the business key plus one of `system_from` or `system_to`; the other gets a UNIQUE index on the same business key columns. Either choice is equivalent. This repo's convention is PK `(key..., system_from)` plus UNIQUE `(key..., system_to)`. `packages/shared/test/schema-guard.test.ts` fails when a temporal table lacks either.
- Add a partial closed-at index on `system_to WHERE system_to < '9999-12-31 23:59:59'` when queries look up ended rows; a full `system_to` index would win every live-row lookup.

Example schema:

```sql
CREATE TABLE nodes (
  id TEXT NOT NULL,
  name TEXT,
  system_from TEXT NOT NULL,
  system_to TEXT NOT NULL,
  PRIMARY KEY (id, system_from)
);
CREATE UNIQUE INDEX nodes_system_to_idx ON nodes (id, system_to);
CREATE INDEX nodes_closed_at_idx ON nodes (system_to) WHERE system_to < '9999-12-31 23:59:59';
```

## Which Tables Are Temporal

- Every table is temporal, and no column holds JSON.
- Exemption: derived data rebuilt from temporal tables may be non-temporal, such as the `node_fts*` full-text tables and `node_tags`. SQLite and migration bookkeeping (`sqlite_sequence`, `__drizzle_migrations`) are also exempt.

Example queries:

```sql
-- Query current records
SELECT * FROM nodes WHERE system_to = '9999-12-31 23:59:59';

-- Query records as of a specific date (strict > on system_to)
SELECT * FROM nodes WHERE system_from <= '2024-06-15 14:30:00' AND system_to > '2024-06-15 14:30:00';

-- Query historical records at backup import time
SELECT * FROM nodes WHERE system_from <= @importTimestamp AND system_to > @importTimestamp;
```

## Composites

See Liftwizard's [Composites](https://liftwizard.io/docs/temporal-data/versioning#composites) and [Reladomo](https://github.com/goldmansachs/reladomo).

- A node is the composite root. The ownership map is `NODE_COMPOSITE_PARTS` in `packages/shared/src/cache/node-composite.ts`; `packages/shared/test/node.test.ts` fails when a table or node-id column is unclassified.
- Here the leading primary-key column names the owner; every other node-id column is a reference.
- Unit of work: one logical operation may edit several composites, and all of them share one transaction and one system time (`UnitOfWork` from `runUnitOfWork`). That time is every ended row's `system_to` and every new row's `system_from`. Helpers take the unit of work from the caller and never call `now()` or open their own transaction.
- System time comes from the application's UTC clock, read once per unit of work (`newSystemTime`/`newSystemTimestamp` in `packages/shared/src/cache/system-time.ts`), as Reladomo reads its processing time once per transaction. A unit split across several transactions (the batched `beginApiImport`, the Durable Object's alarm-driven import) stages the time once and passes it to every transaction. Never shift a time to make it unique: two units may share a millisecond, and times need not be monotonic across units.
- Close current rows with `closeCurrentVersions`, never a bare `UPDATE ... SET system_to`. A current row that already starts at the unit's time (written earlier in the same unit, or by another unit in the same millisecond) throws `SameMillisecondOverwriteError`, naming the table, key and system time, and the unit rolls back. Deleting it instead (Reladomo's "changed too fast" rule) would erase history and strand derived rows such as `node_tags`. Fix a caller that hits it at the source: merge the two writes before writing (as `storeApiResponses` skips a placeholder for a parent another list in the unit stores), or give a test's second unit a later time; never catch the error. Tests run on a strictly increasing `Date.now()` (`packages/shared/test/setup/strictly-increasing-clock.ts`), standing in for the network round trip that separates units in production; a test that freezes time with `vi.useFakeTimers` must step the clock between units itself. A row starting after the unit's time (a unit that read the clock later but landed first) is closed like any other and ends before it starts.
- Every write path that ends or merges composites runs one `runUnitOfWork`: `applyRows`, `endNodeComposites` and `endOrphanedParts` take the caller's `UnitOfWork`. Examples: `CacheService.deleteNode` and `promoteOriginal`, `importFromApi` (merge plus `endOrphanedParts`), and the backup import (node, relationship and orphan sweep in one transaction). Never close an owned table ad hoc.
