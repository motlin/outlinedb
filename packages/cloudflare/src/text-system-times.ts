import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";

/** The far-future `system_to` of a current row from when system times were text. */
const TEXT_FAR_FUTURE = "9999-12-31 23:59:59";

const quoted = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** The `name` column of each row. */
function names(cursor: SqlStorageCursor<Record<string, SqlStorageValue>>): string[]
{
	return cursor.toArray().flatMap((row) => (typeof row.name === "string" ? [row.name] : []));
}

/** SQL converting a text system time (`YYYY-MM-DD HH:MM:SS.sss` UTC, or the text sentinel) to integer microseconds. */
function microsFromText(column: string): string
{
	const name = quoted(column);
	return `CASE WHEN ${name} = '${TEXT_FAR_FUTURE}' THEN ${String(FAR_FUTURE_DATE)} ELSE CAST(round((julianday(${name}) - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END`;
}

/**
 * Run a Durable Object's `ddl` (CREATE ... IF NOT EXISTS) so its system-time columns are integer microseconds. Each of
 * `tables` created when system times were text is set aside without its indexes, created anew by `ddl`, and refilled
 * with its rows, every column in `timeColumns` converted.
 */
export function createWithMicrosecondSystemTimes(
	sql: SqlStorage,
	ddl: string,
	tables: readonly string[],
	timeColumns: ReadonlySet<string>,
): void
{
	const textTables = tables.filter(
		(table) =>
			sql.exec("SELECT type FROM pragma_table_info(?) WHERE name = 'system_from'", table).toArray()[0]?.type ===
			"TEXT",
	);
	for (const table of textTables)
	{
		for (const name of names(
			sql.exec("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL", table),
		))
		{
			sql.exec(`DROP INDEX ${quoted(name)}`);
		}
		sql.exec(`ALTER TABLE ${quoted(table)} RENAME TO ${quoted(`${table}_text`)}`);
	}
	sql.exec(ddl);
	for (const table of textTables)
	{
		const columns = names(sql.exec("SELECT name FROM pragma_table_info(?)", `${table}_text`));
		const values = columns.map((column) => (timeColumns.has(column) ? microsFromText(column) : quoted(column)));
		sql.exec(
			`INSERT INTO ${quoted(table)} (${columns.map(quoted).join(", ")}) SELECT ${values.join(", ")} FROM ${quoted(`${table}_text`)}`,
		);
		sql.exec(`DROP TABLE ${quoted(`${table}_text`)}`);
	}
}
