import {journal, migrations} from "@outlinedb/shared/db-migrations-bundle";

/**
 * Apply the bundled drizzle migrations this Durable Object has not run, in one transaction, keeping drizzle's
 * `__drizzle_migrations` bookkeeping. Drizzle's own durable-sqlite migrator replaces any SQL error with a bare
 * "Rollback", so this one rethrows the failing migration, statement and SQLite message instead.
 */
export function migrateDurableObject(storage: DurableObjectStorage): void
{
	storage.transactionSync(() =>
	{
		const sql = storage.sql;
		sql.exec(
			"CREATE TABLE IF NOT EXISTS __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)",
		);
		const last = sql
			.exec("SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1")
			.toArray()[0];
		const appliedAt = last === undefined ? undefined : Number(last.created_at);
		for (const entry of journal.entries)
		{
			if (appliedAt !== undefined && appliedAt >= entry.when)
			{
				continue;
			}
			const name = `m${String(entry.idx).padStart(4, "0")}`;
			const query = migrations[name];
			if (query === undefined)
			{
				throw new Error(`Missing migration: ${entry.tag}`);
			}
			for (const statement of query.split("--> statement-breakpoint"))
			{
				try
				{
					sql.exec(statement);
				}
				catch (error)
				{
					const message = error instanceof Error ? error.message : String(error);
					throw new Error(
						`Migration ${entry.tag} failed: ${message} in: ${statement.trim().slice(0, 300)}`,
						{
							cause: error,
						},
					);
				}
			}
			sql.exec("INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('', ?)", entry.when);
		}
	});
}
