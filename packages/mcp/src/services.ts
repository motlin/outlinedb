import {WorkflowyApiClient} from "@workflowy/shared/api";
import type {InternalAuth} from "@workflowy/shared/api";
import {CacheService, ensureNodeTags, WorkflowyWriteThroughClient} from "@workflowy/shared/cache";
import * as schema from "@workflowy/shared/db";
import type {WorkflowyInternalAdapter} from "@workflowy/shared/internal";
import {internalAdapter, readInternalAuth} from "@workflowy/shared/node";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import DatabaseConstructor from "better-sqlite3";
import {join} from "node:path";

let database: ReturnType<typeof drizzle<typeof schema>> | null = null;
let apiClient: WorkflowyApiClient | null = null;
let cacheService: CacheService | null = null;
let writeThroughClient: WorkflowyWriteThroughClient | null = null;

export function getDatabase(): ReturnType<typeof drizzle<typeof schema>> {
	if (!database) {
		const dbPath = (process.env.WORKFLOWY_DB_PATH ?? "") || "workflowy.sqlite";
		const sqlite = new DatabaseConstructor(dbPath);

		if (!process.env.WORKFLOWY_DB_PATH) {
			sqlite.pragma("journal_mode = WAL");
		}

		database = drizzle(sqlite, {schema});

		if (process.env.WORKFLOWY_SKIP_MIGRATIONS !== "true") {
			const migrationsFolder = join(import.meta.dirname, "../../shared/dist/db/migrations");
			migrate(database, {migrationsFolder});
			ensureNodeTags(database);
		}

		sqlite.pragma("foreign_keys = ON");
	}
	return database;
}

export function getApiClient(): WorkflowyApiClient {
	if (!apiClient) {
		const apiKey = process.env.WORKFLOWY_API_KEY;
		if (!apiKey) {
			throw new Error("WORKFLOWY_API_KEY environment variable is required");
		}
		apiClient = new WorkflowyApiClient(apiKey, undefined, process.env.WORKFLOWY_API_URL);
	}
	return apiClient;
}

/**
 * Internal-API auth from `WORKFLOWY_USERNAME`/`WORKFLOWY_PASSWORD` (both
 * required) or a saved session cookie, mirroring the web and CLI wiring.
 * Undefined when neither is configured.
 */
export function getInternalAuth(env: NodeJS.ProcessEnv = process.env): InternalAuth | undefined {
	return readInternalAuth(env);
}

export function getCacheService(): CacheService {
	return (cacheService ??= new CacheService(getDatabase()));
}

export function getWriteThroughClient(): WorkflowyWriteThroughClient {
	return (writeThroughClient ??= new WorkflowyWriteThroughClient(getApiClient(), getCacheService()));
}

/** An internal-API adapter over the cache, or undefined without {@link getInternalAuth}. */
export function getInternalAdapter(): WorkflowyInternalAdapter | undefined {
	return internalAdapter(getDatabase(), getWriteThroughClient());
}
