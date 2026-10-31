import {getTableName, sql} from "drizzle-orm";
import type {SQL} from "drizzle-orm";
import {getTableConfig} from "drizzle-orm/sqlite-core";
import type {BaseSQLiteDatabase, SQLiteColumn, SQLiteTable} from "drizzle-orm/sqlite-core";
import {FAR_FUTURE_DATE} from "../temporal/index.js";

/**
 * Batch size for bulk insert/phase-out operations.
 * Balances memory use against round-trip count, and keeps `sql.join()` argument
 * lists short enough to avoid a stack overflow when joining thousands of items.
 */
/** Durable Object SQLite allows at most 100 bound parameters in a statement. */
const BOUND_PARAMS_PER_STATEMENT = 90;

/**
 * Separator for composite merge keys. ASCII unit separator (U+001F) — a control
 * character that cannot appear in a Workflowy id, so joined keys never collide
 * (unlike ad-hoc `:` / `|` separators). Composite-key callers must build their
 * `incomingKey`/`currentKey` with {@link joinKey} so they match the SQL-side
 * concatenation used for phase-out.
 */
const KEY_SEP = "\u001F";

/** Join key parts with the composite-key separator. */
export function joinKey(...parts: string[]): string {
	return parts.join(KEY_SEP);
}

/** SQL expression concatenating the key columns with {@link KEY_SEP}. */
function keyExpression(columns: SQLiteColumn[]): SQL {
	let expr: SQL = sql`${columns[0]}`;
	for (let i = 1; i < columns.length; i++) {
		expr = sql`${expr} || ${KEY_SEP} || ${columns[i]}`;
	}
	return expr;
}

/**
 * Result of a {@link temporalMerge} call.
 */
export interface TemporalMergeResult {
	/** Rows inserted as new current versions (new keys + changed keys). */
	inserted: number;
	/** Current rows whose `systemTo` was closed (changed keys + removed keys). */
	phasedOut: number;
	/** Current rows left untouched because their content was identical. */
	unchanged: number;
}

/**
 * Configuration describing how a single temporal table is merged.
 */
export interface TemporalMergeConfig<TIncoming, TCurrent> {
	/**
	 * The Drizzle table to merge into. Must have `system_from` / `system_to`
	 * text columns following the project's temporal convention.
	 */
	table: SQLiteTable;
	/**
	 * Column(s) on `table` used to phase out current rows by key. For a
	 * single-column natural key, pass the id column as `keyColumn` (e.g.
	 * `nodeContent.id`). For a composite natural key (e.g. `mirrors` keyed by
	 * `(originalId, mirrorId)`), pass `keyColumns` and build `incomingKey`/
	 * `currentKey` with {@link joinKey}. Exactly one of the two must be set.
	 */
	keyColumn?: SQLiteColumn;
	keyColumns?: SQLiteColumn[];
	/**
	 * Extracts the merge key from an incoming desired-state row.
	 */
	incomingKey: (row: TIncoming) => string;
	/**
	 * Extracts the merge key from a current row loaded from the database.
	 */
	currentKey: (row: TCurrent) => string;
	/**
	 * Returns true when an incoming row's content is unchanged relative to the
	 * matching current row. When true, the current row is left alone; when
	 * false, the current row is phased out and a new version inserted.
	 */
	contentMatches: (current: TCurrent, incoming: TIncoming) => boolean;
	/**
	 * Builds the row to insert for a new or changed incoming row. `current` is the
	 * row being phased out for a changed key, or undefined for a new key. The
	 * returned object must NOT include `systemFrom` / `systemTo`; those are
	 * appended by the merge engine.
	 */
	// oxlint-disable-next-line @typescript-eslint/no-explicit-any
	buildInsertRow: (incoming: TIncoming, current: TCurrent | undefined) => Record<string, any>;
	/**
	 * Keys that must never be phased out for being absent from `incoming`.
	 *
	 * A backup snapshot only testifies to the state of the tree at the moment it
	 * was taken, so it cannot prove that a node written after that moment was
	 * deleted. Callers importing an older snapshot pass those newer keys here to
	 * keep them open. A preserved key that *is* present in `incoming` follows the
	 * normal content-comparison path.
	 */
	preserveKeys?: ReadonlySet<string>;
}

/**
 * A synchronous Drizzle SQLite handle: an `AppDatabase` or the `tx`
 * from its `database.transaction(...)`. The schema generics stay open so this
 * engine is agnostic of the concrete schema.
 */
// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- schema generics are invariant, so `unknown` would reject concrete schemas
export type TemporalTransaction = BaseSQLiteDatabase<"sync", any, any, any>;

/**
 * A unit of work tried to close a current version whose `system_from` is the
 * unit's own system time. Closing it would leave an empty interval and block
 * the new version's key, and deleting it (Reladomo's "changed too fast") would
 * erase history and strand derived rows, so the unit fails and rolls back. Two
 * writes to one row in one unit should be merged before writing; two units in
 * one millisecond should retry.
 */
export class SameMillisecondOverwriteError extends Error {
	constructor(tableName: string, key: string, systemTime: string) {
		super(
			`Unit of work at system time ${systemTime} would overwrite the ${tableName} version (${key}) it started in the same millisecond; rolled back instead of deleting history`,
		);
		this.name = "SameMillisecondOverwriteError";
	}
}

/** The names of the non-temporal primary-key columns of `table`, which name one row's history. */
function historyKeyColumnNames(table: SQLiteTable): string[] {
	const tableConfig = getTableConfig(table);
	const columns = tableConfig.primaryKeys[0]?.columns ?? tableConfig.columns.filter((column) => column.primary);
	return columns.map((column): string => column.name).filter((name) => name !== "system_from");
}

/**
 * Close the current versions of `table` matching `where` at `systemTime`, the
 * unit of work's system time. A current version that already starts at
 * `systemTime` throws {@link SameMillisecondOverwriteError}: it was written
 * earlier in this unit, or by another unit in the same millisecond, and closing
 * it would leave an empty interval. A current version starting after
 * `systemTime`, left by a unit that read the clock later but landed first, is
 * closed like any other, so its interval ends before it starts and no as-of
 * read sees it.
 */
export function closeCurrentVersions(
	tx: TemporalTransaction,
	table: SQLiteTable,
	systemTime: string,
	where: SQL | undefined,
): void {
	const systemFrom = sql.identifier("system_from");
	const systemTo = sql.identifier("system_to");
	const matching = where ?? sql`1`;
	const keyColumnNames = historyKeyColumnNames(table);
	const collision = tx.get<Record<string, unknown> | undefined>(
		sql`SELECT ${sql.join(
			keyColumnNames.map((name) => sql.identifier(name)),
			sql`, `,
		)} FROM ${table} WHERE ${systemTo} = ${FAR_FUTURE_DATE} AND ${systemFrom} = ${systemTime} AND (${matching}) LIMIT 1`,
	);
	if (collision !== undefined) {
		const key = keyColumnNames.map((name) => `${name}=${String(collision[name])}`).join(", ");
		throw new SameMillisecondOverwriteError(getTableName(table), key, systemTime);
	}
	tx.run(
		sql`UPDATE ${table} SET ${systemTo} = ${systemTime} WHERE ${systemTo} = ${FAR_FUTURE_DATE} AND (${matching})`,
	);
}

/**
 * Apply the temporal merge-list pattern to a single table.
 *
 * Given the desired set of current rows (`incoming`) and a `systemFrom`
 * timestamp, this:
 *
 *   - phases out current rows whose content changed (sets `system_to = importedAt`),
 *   - phases out current rows that are absent from `incoming` (deletions),
 *   - inserts new current versions for new and changed rows
 *     (`system_from = importedAt`, `system_to = FAR_FUTURE_DATE`),
 *   - leaves unchanged rows untouched (no new temporal version).
 *
 * The caller is responsible for opening the transaction. This function expects
 * the current rows for the table to already be loaded into `currentRows`
 * (callers typically need them for other bookkeeping anyway), so it performs no
 * SELECT of its own.
 *
 * @param tx          Active Drizzle transaction.
 * @param config      Table-specific merge configuration.
 * @param incoming    Desired-state rows.
 * @param currentRows Current (active) rows already loaded from the table.
 * @param importedAt  Temporal timestamp string for this import.
 */
export function temporalMerge<TIncoming, TCurrent>(
	tx: TemporalTransaction,
	config: TemporalMergeConfig<TIncoming, TCurrent>,
	incoming: TIncoming[],
	currentRows: TCurrent[],
	importedAt: string,
): TemporalMergeResult {
	const {table, keyColumn, keyColumns, incomingKey, currentKey, contentMatches, buildInsertRow, preserveKeys} =
		config;
	const columns = keyColumns ?? (keyColumn ? [keyColumn] : []);
	const keyMatchExpr = keyExpression(columns);

	const currentByKey = new Map<string, TCurrent>();
	for (const row of currentRows) {
		currentByKey.set(currentKey(row), row);
	}

	const incomingKeys = new Set<string>();
	const keysToPhaseOut: string[] = [];
	// oxlint-disable-next-line @typescript-eslint/no-explicit-any
	const rowsToInsert: Record<string, any>[] = [];
	let unchanged = 0;

	for (const row of incoming) {
		const key = incomingKey(row);
		incomingKeys.add(key);

		const current = currentByKey.get(key);
		if (current !== undefined && contentMatches(current, row)) {
			unchanged++;
			continue;
		}

		// New key, or changed key: insert a new current version. A changed key
		// also needs its old current row phased out.
		if (current !== undefined) {
			keysToPhaseOut.push(key);
		}
		rowsToInsert.push({
			...buildInsertRow(row, current),
			systemFrom: importedAt,
			systemTo: FAR_FUTURE_DATE,
		});
	}

	let phasedOut = keysToPhaseOut.length;
	for (const key of currentByKey.keys()) {
		if (!incomingKeys.has(key) && !preserveKeys?.has(key)) {
			keysToPhaseOut.push(key);
			phasedOut++;
		}
	}

	// Chunked IN lists rather than a scratch table: Durable Object SQLite has no temp tables.
	for (let i = 0; i < keysToPhaseOut.length; i += BOUND_PARAMS_PER_STATEMENT) {
		const chunk = keysToPhaseOut.slice(i, i + BOUND_PARAMS_PER_STATEMENT);
		closeCurrentVersions(
			tx,
			table,
			importedAt,
			sql`${keyMatchExpr} IN (${sql.join(
				chunk.map((key) => sql`${key}`),
				sql`, `,
			)})`,
		);
	}

	const firstRow = rowsToInsert[0];
	if (firstRow !== undefined) {
		const rowsPerStatement = Math.max(1, Math.floor(BOUND_PARAMS_PER_STATEMENT / Object.keys(firstRow).length));
		for (let i = 0; i < rowsToInsert.length; i += rowsPerStatement) {
			tx.insert(table)
				.values(rowsToInsert.slice(i, i + rowsPerStatement))
				.run();
		}
	}

	return {inserted: rowsToInsert.length, phasedOut, unchanged};
}
