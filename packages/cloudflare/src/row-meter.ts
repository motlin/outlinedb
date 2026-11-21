/** Rows a Durable Object's SQLite has written since the meter was installed, index rows included. */
export interface RowMeter
{
	rowsWritten(): number;
}

/**
 * Count the rows every `sql.exec` writes, index rows included, as Cloudflare bills them. Installed once on the
 * object's `SqlStorage`, so drizzle and the jobs' raw SQL are all counted. A statement's count is final once it has
 * run, so each cursor is folded in when the next statement starts.
 */
export function meterRowsWritten(sql: SqlStorage): RowMeter
{
	const exec = sql.exec.bind(sql);
	let settled = 0;
	let last:
		|
		  {
				readonly rowsWritten: number;
		  }
		| undefined;
	const metered = <T extends Record<string, SqlStorageValue>>(
		query: string,
		...bindings: unknown[]
	): SqlStorageCursor<T> =>
	{
		settled += last?.rowsWritten ?? 0;
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
		rowsWritten: () => settled + (last?.rowsWritten ?? 0),
	};
}
