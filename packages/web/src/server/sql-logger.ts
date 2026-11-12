import type {Logger as DrizzleLogger} from "drizzle-orm";

/**
 * Custom Drizzle logger that routes SQL queries to console with appropriate severity.
 * READ operations (SELECT): debug severity
 * WRITE operations (INSERT, UPDATE, DELETE): info severity
 *
 * Logging is enabled by the host (`ServerConfig.sqlQueryLogging`).
 */
export function createSqlLogger(enabled: boolean): DrizzleLogger
{
	return {
		logQuery(query: string, params: unknown[]): void
		{
			if (!enabled)
			{
				return;
			}

			const isWrite = /^\s*(INSERT|UPDATE|DELETE)/iu.test(query);

			if (isWrite)
			{
				console.info("[SQL]", query, params);
			}
			else
			{
				console.debug("[SQL]", query, params);
			}
		},
	};
}
