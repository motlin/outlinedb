import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {join} from "node:path";
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import * as schema from "@outlinedb/shared/db";
import {readNodeConfig} from "../src/server/config.js";
import {buildServerContext} from "../src/server/context.js";
import type {ServerContext} from "../src/server/context.js";
import {LadderEventBus} from "../src/server/ladder-events.js";
import {inProcessStore} from "../src/server/store.js";
import type {StoreClient} from "../src/server/store.js";

const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");

let sqlite: DatabaseConstructor.Database;
let ctx: ServerContext;
let store: StoreClient;

beforeEach(() => {
	sqlite = new DatabaseConstructor(":memory:");
	const db = drizzle(sqlite, {schema});
	migrate(db, {migrationsFolder});
	ctx = buildServerContext({
		db,
		config: readNodeConfig({WORKFLOWY_API_KEY: "test-api-key"}),
		ladderEvents: new LadderEventBus(),
	});
	store = inProcessStore(ctx);
	const insert = (id: string, name: string, parentId: string | null, completedAt: number | null = null) => {
		ctx.cacheService.insertNode(
			{id, name, note: null, priority: 0, createdAt: 1_600_000_000, modifiedAt: 1_600_000_000, completedAt},
			parentId,
		);
	};
	insert("work", "Work", null);
	insert("projects", "Projects", "work");
	insert("alpha", "Alpha", "projects", 1_600_000_100);
	// A path the cache lacks falls back to the public API, which knows nothing more.
	vi.spyOn(globalThis, "fetch").mockImplementation(async () => Promise.resolve(Response.json({nodes: []})));
});

afterEach(() => {
	sqlite.close();
});

describe("nodes.resolve", () => {
	it("resolves a comma path from the cache", async () => {
		await expect(store.call("nodes.resolve", {path: "Work, Projects"})).resolves.toStrictEqual({
			ok: true,
			value: {id: "projects"},
		});
	});

	it("resolves home to null as a parent", async () => {
		await expect(store.call("nodes.resolve", {id: "home", parent: true})).resolves.toStrictEqual({
			ok: true,
			value: {id: null},
		});
	});

	it("answers 404 with the resolver's message for an unknown path", async () => {
		await expect(store.call("nodes.resolve", {path: "Work,Nowhere"})).resolves.toStrictEqual({
			ok: false,
			status: 404,
			body: {error: "Node not found at path: Work > Nowhere"},
		});
	});

	it("needs the API key", async () => {
		const keyless = inProcessStore({...ctx, apiKey: undefined});

		await expect(keyless.call("nodes.resolve", {id: "work"})).resolves.toStrictEqual({
			ok: false,
			status: 500,
			body: {error: "WORKFLOWY_API_KEY environment variable is required"},
		});
	});
});

describe("nodes.readTree", () => {
	it("reads a parent's children with the requested depth of descendants", async () => {
		const result = await store.call("nodes.readTree", {parentId: "work", depth: 1});

		expect(
			result.ok &&
				result.value.nodes.map((node) => {
					const {id, children} = node as {id: string; children: {id: string}[]};
					return {id, children: children.map((child) => child.id)};
				}),
		).toStrictEqual([{id: "projects", children: ["alpha"]}]);
	});

	it("reads the named nodes without descendants by default", async () => {
		const result = await store.call("nodes.readTree", {ids: ["alpha"]});

		expect(
			result.ok &&
				result.value.nodes.map((node) => {
					const {id, name, completedAt} = node as {id: string; name: string; completedAt: string};
					return {id, name, completedAt, readsChildren: "children" in (node as object)};
				}),
		).toStrictEqual([{id: "alpha", name: "Alpha", completedAt: "2020-09-13T12:28:20.000Z", readsChildren: false}]);
	});
});

describe("cache.status", () => {
	it("counts live nodes, roots and completed nodes", async () => {
		await expect(store.call("cache.status", {})).resolves.toStrictEqual({
			ok: true,
			value: {
				totalNodes: 3,
				rootNodes: 1,
				completedNodes: 1,
				lastSync: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u),
				lastBackupImport: null,
			},
		});
	});
});
