import type {Logger as DrizzleLogger} from "drizzle-orm";
import {logger} from "./logger.js";

/**
 * Custom Drizzle logger that routes SQL queries through our logging infrastructure.
 * READ operations (SELECT): debug severity
 * WRITE operations (INSERT, UPDATE, DELETE): info severity
 */
export const sqlLogger: DrizzleLogger =
{
	logQuery(query: string, params: unknown[]): void
	{
		logger.logSql(query, params);
	},
};
