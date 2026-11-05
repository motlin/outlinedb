import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {Hono} from "hono";
import {join} from "node:path";
import {WorkflowyInternalClient} from "@workflowy/shared/api";
import {CacheService, TRANSACTION_TIMEOUT_MS, storeTreeTxId} from "@workflowy/shared/cache";
import * as schema from "@workflowy/shared/db";
import {WorkflowyInternalAdapter} from "@workflowy/shared/internal";
import type {WorkflowyNode} from "@workflowy/shared/types";
import {createFakeInternalApi, json} from "../../shared/test/helpers/fake-internal-api.js";
import type {AppEnv, ServerContext} from "../src/server/context.js";
import type {NodeChangesResponse} from "../src/node-types.js";
import {httpAppFor} from "./http-app-for.js";

const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");
const T0 = Date.parse("2026-11-05T12:00:00.000Z");

function apiNode(id: string, parentId: string | null, priority: number): WorkflowyNode {
	return {id, name: id, note: null, parent_id: parentId, priority, createdAt: 100, modifiedAt: 200, completed: false};
}

/** A logged transaction as `/push_and_poll` sends it: a JSON string. */
function transaction(id: number, ops: {type: string; data: Record<string, unknown>}[]): string {
	return JSON.stringify({id, client_timestamp: 300_000_000, ops});
}

/**
 * Home holds P1 (X, Y) and P2 (Z), seeded at {@link T0} with the tree at transaction 100. The clock then stands past
 * the transaction timeout, so the seeding falls behind the first watermark.
 */
function setup() {
	vi.useFakeTimers({toFake: ["Date"], now: T0});
	const sqlite = new DatabaseConstructor(":memory:");
	const db = drizzle(sqlite, {schema});
	migrate(db, {migrationsFolder});
	const cacheService = new CacheService(db);
	cacheService.insertNode(apiNode("P1", null, 0), null);
	cacheService.insertNode(apiNode("P2", null, 1), null);
	cacheService.insertNode(apiNode("X", "P1", 0), "P1");
	cacheService.insertNode(apiNode("Y", "P1", 1), "P1");
	cacheService.insertNode(apiNode("Z", "P2", 0), "P2");
	storeTreeTxId(db, "100");
	vi.setSystemTime(T0 + TRANSACTION_TIMEOUT_MS + 60_000);
	const api = createFakeInternalApi();
	const adapter = new WorkflowyInternalAdapter({
		client: new WorkflowyInternalClient({
			credentials: {username: "alice@example.com", password: "hunter2"},
			fetch: api.fetch,
			baseUrl: "https://workflowy.test",
			transientId: "6f1c1d1e-0000-4000-8000-000000000001",
		}),
		db,
		pushAndPoll: {randomId: () => "pollid01", timezone: "America/New_York", sleep: async () => {}},
	});
	const ctx = {db, cacheService} as unknown as ServerContext;
	const app = new Hono<AppEnv>();
	app.use("*", async (c, next) => {
		c.set("ctx", ctx);
		await next();
	});
	app.route("/", httpAppFor(ctx));
	const changes = async (since: string | null): Promise<NodeChangesResponse> => {
		const query = since === null ? "" : `?since=${encodeURIComponent(since)}`;
		const res = await app.fetch(new Request(`http://x/api/v1/nodes/changes${query}`));
		return (await res.json()) as NodeChangesResponse;
	};
	return {sqlite, api, adapter, changes};
}

function shape(body: NodeChangesResponse) {
	return {
		reset: body.reset,
		changedIds: new Set(body.changedIds),
		deletedIds: new Set(body.deletedIds),
		children: Object.fromEntries(
			body.children.map(({parentId, nodes}) => [parentId ?? "home", nodes.map((node) => node.id)]),
		),
	};
}

describe("remote transactions reach the nodes change feed", () => {
	let open: DatabaseConstructor.Database[] = [];
	afterEach(() => {
		for (const sqlite of open) {
			sqlite.close();
		}
		open = [];
		vi.useRealTimers();
	});

	it("a remote move caught up through the adapter lists the moved node and both parents' refreshed children", async () => {
		const {sqlite, api, adapter, changes} = setup();
		open.push(sqlite);
		const seeded = await changes(null);
		vi.setSystemTime(T0 + TRANSACTION_TIMEOUT_MS + 70_000);
		api.respondOnce("/push_and_poll", () =>
			json({
				results: [
					{
						new_most_recent_operation_transaction_id: "101",
						concurrent_remote_operation_transactions: [
							transaction(101, [{type: "move", data: {projectid: "X", parentid: "P2", priority: 1}}]),
						],
					},
				],
			}),
		);

		await adapter.catchUp();
		const body = await changes(seeded.latest);

		expect(shape(body)).toStrictEqual({
			reset: false,
			changedIds: new Set(["X", "Y"]),
			deletedIds: new Set(),
			children: {P1: ["Y"], P2: ["Z", "X"]},
		});
	});

	it("a remote bulk_move lands the block after the non-moved siblings its priority counts, Home included", async () => {
		const {sqlite, api, adapter, changes} = setup();
		open.push(sqlite);
		const seeded = await changes(null);
		vi.setSystemTime(T0 + TRANSACTION_TIMEOUT_MS + 70_000);
		api.respondOnce("/push_and_poll", () =>
			json({
				results: [
					{
						new_most_recent_operation_transaction_id: "101",
						concurrent_remote_operation_transactions: [
							transaction(101, [
								{
									type: "bulk_move",
									data: {projectids_json: JSON.stringify(["Y", "Z"]), parentid: "None", priority: 1},
								},
							]),
						],
					},
				],
			}),
		);

		await adapter.catchUp();
		const body = await changes(seeded.latest);

		expect(shape(body)).toStrictEqual({
			reset: false,
			changedIds: new Set(["Y", "Z", "P2"]),
			deletedIds: new Set(),
			children: {home: ["P1", "Y", "Z", "P2"], P1: ["X"], P2: []},
		});
	});
});
