import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {inject} from "vite-plus/test";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {InMemoryTransport} from "@modelcontextprotocol/sdk/inMemory.js";
import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import type {CacheService} from "@workflowy/shared/cache";
import type {AppDatabase} from "@workflowy/shared/db";
import {createServerContext, inProcessStore} from "@workflowy/web/node-host";
import type {StoreClient} from "@workflowy/web/node-host";
import {registerWorkflowyTools} from "../src/register.js";

declare module "vitest" {
	export interface ProvidedContext {
		/** Provided by packages/cli/test/setup/migrated-template.ts, the run-wide global setup. */
		migratedDatabaseTemplate: string;
	}
}

export interface Harness {
	tempDir: string;
	/** Without internal-API auth. */
	store: StoreClient;
	/** With internal-API credentials (alice@example.com), so the ops write through the internal adapter. */
	authStore: StoreClient;
	cache: CacheService;
	db: AppDatabase;
	restoreEnv(): void;
}

/**
 * The stdio host's wiring over a copy of the migrated test database: `createServerContext` reads the env set here,
 * so call it once per test file (the database is a module singleton). Both stores share that database.
 */
export function openHarness(prefix: string): Harness {
	const originalEnv = {...process.env};
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	const dbPath = path.join(tempDir, "test.sqlite");
	fs.copyFileSync(inject("migratedDatabaseTemplate"), dbPath);
	Object.assign(process.env, {
		WORKFLOWY_DB_PATH: dbPath,
		WORKFLOWY_SKIP_MIGRATIONS: "true",
		WORKFLOWY_API_KEY: "test-api-key",
		WORKFLOWY_SESSION_FILE: path.join(tempDir, "workflowy-session"),
	});
	delete process.env.WORKFLOWY_USERNAME;
	delete process.env.WORKFLOWY_PASSWORD;
	const ctx = createServerContext();
	process.env.WORKFLOWY_USERNAME = "alice@example.com";
	process.env.WORKFLOWY_PASSWORD = "hunter2";
	const authCtx = createServerContext();
	delete process.env.WORKFLOWY_USERNAME;
	delete process.env.WORKFLOWY_PASSWORD;
	return {
		tempDir,
		store: inProcessStore(ctx),
		authStore: inProcessStore(authCtx),
		cache: ctx.cacheService,
		db: ctx.db,
		restoreEnv() {
			process.env = originalEnv;
			fs.rmSync(tempDir, {recursive: true, force: true});
		},
	};
}

/** Insert a node straight into the cache, as an import would. */
export function seed(
	cache: CacheService,
	id: string,
	name: string,
	parentId: string | null = null,
	note: string | null = null,
): void {
	cache.insertNode({id, name, note, priority: 0, createdAt: 0, modifiedAt: 0, completedAt: null}, parentId);
}

/** A client connected over an in-memory transport to a server carrying every Workflowy tool. */
export async function connectClient(store: StoreClient): Promise<Client> {
	const server = new McpServer({name: "workflowy", version: "0.1.0"});
	registerWorkflowyTools(server, store);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({name: "test", version: "0.0.0"});
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return client;
}

/** One tool call's `isError` and content. */
export async function callTool(
	store: StoreClient,
	name: string,
	args: Record<string, unknown>,
): Promise<{isError: unknown; content: unknown}> {
	const client = await connectClient(store);
	try {
		const result = await client.callTool({name, arguments: args});
		return {isError: result.isError, content: result.content};
	} finally {
		await client.close();
	}
}
