/** Rows a Durable Object's SQLite has read and written, index rows included, as Cloudflare bills them. */
export interface RowCounts
{
	rowsRead: number;
	rowsWritten: number;
}

/** Rows a Durable Object's SQLite has read and written since the meter was installed. */
export interface RowMeter
{
	rows(): RowCounts;
}

/**
 * Count the rows every `sql.exec` reads and writes, index rows included, as Cloudflare bills them. Installed once on
 * the object's `SqlStorage`, so drizzle and the jobs' raw SQL are all counted. A statement's counts are final once it
 * has run, so each cursor is folded in when the next statement starts.
 */
export function meterRows(sql: SqlStorage): RowMeter
{
	const exec = sql.exec.bind(sql);
	const settled: RowCounts =
	{
		rowsRead: 0,
		rowsWritten: 0,
	};
	let last: RowCounts | undefined;
	const metered = <T extends Record<string, SqlStorageValue>>(
		query: string,
		...bindings: unknown[]
	): SqlStorageCursor<T> =>
	{
		settled.rowsRead += last?.rowsRead ?? 0;
		settled.rowsWritten += last?.rowsWritten ?? 0;
		const cursor = exec<T>(query, ...bindings);
		last = cursor;
		return cursor;
	};
	Object.defineProperty(
		sql,
		"exec",
		{
			value: metered,
			configurable: true,
		},
	);
	return {
		rows: () => (
		{
			rowsRead: settled.rowsRead + (last?.rowsRead ?? 0),
			rowsWritten: settled.rowsWritten + (last?.rowsWritten ?? 0),
		}),
	};
}
