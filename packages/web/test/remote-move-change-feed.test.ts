import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {Hono} from "hono";
import {join} from "node:path";
import {WorkflowyInternalClient} from "@outlinedb/shared/api";
import
{
	CacheService,
	LocalTreeWriter,
	OutboxRecorder,
	TRANSACTION_TIMEOUT_MS,
	pendingAspects,
	storeTreeTxId,
} from "@outlinedb/shared/cache";
import * as schema from "@outlinedb/shared/db";
import {PendingEditsDeletedUpstream, WorkflowyInternalAdapter} from "@outlinedb/shared/internal";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import type {WorkflowyNode} from "@outlinedb/shared/types";
import {createFakeInternalApi, json} from "../../shared/test/helpers/fake-internal-api.js";
import type {AppEnv, ServerContext} from "../src/server/context.js";
import type {NodeChangesResponse} from "../src/node-types.js";
import {httpAppFor} from "./http-app-for.js";

const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");
const T0 = Date.parse("2026-11-05T12:00:00.000Z");

function apiNode(id: string, parentId: string | null, priority: number): WorkflowyNode
{
	return {
		id,
		name: id,
		note: null,
		parent_id: parentId,
		priority,
		createdAt: 100,
		modifiedAt: 200,
		completed: false,
	};
}

/** A logged transaction as `/push_and_poll` sends it: a JSON string. */
function transaction(
	id: number,
	ops:
	{
		type: string;
		data: Record<string, unknown>;
	}[],
): string
{
	return JSON.stringify(
		{
			id,
			client_timestamp: 300_000_000,
			ops,
		},
	);
}

/**
 * Home holds P1 (X, Y) and P2 (Z), seeded at {@link T0} with the tree at transaction 100. The clock then stands past
 * the transaction timeout, so the seeding falls behind the first watermark.
 */
function setup()
{
	vi.useFakeTimers(
		{
			toFake: ["Date"],
			now: T0,
		},
	);
	const sqlite = new DatabaseConstructor(":memory:");
	const db = drizzle(
		sqlite,
		{
			schema,
		},
	);
	migrate(
		db,
		{
			migrationsFolder,
		},
	);
	const cacheService = new CacheService(db);
	cacheService.insertNode(apiNode("P1", null, 0), null);
	cacheService.insertNode(apiNode("P2", null, 1), null);
	cacheService.insertNode(apiNode("X", "P1", 0), "P1");
	cacheService.insertNode(apiNode("Y", "P1", 1), "P1");
	cacheService.insertNode(apiNode("Z", "P2", 0), "P2");
	storeTreeTxId(db, "100");
	vi.setSystemTime(T0 + TRANSACTION_TIMEOUT_MS + 60_000);
	const api = createFakeInternalApi();
	const adapter = new WorkflowyInternalAdapter(
		{
			client: new WorkflowyInternalClient(
				{
					credentials:
					{
						username: "alice@example.com",
						password: "hunter2",
					},
					fetch: api.fetch,
					baseUrl: "https://workflowy.test",
					transientId: "6f1c1d1e-0000-4000-8000-000000000001",
				},
			),
			db,
			pushAndPoll:
			{
				randomId: () => "pollid01",
				timezone: "America/New_York",
			},
		},
	);
	const ctx =
	{
		db,
		cacheService,
	} as unknown as ServerContext;
	const app = new Hono<AppEnv>();
	app.use("*", async (c, next) =>
	{
		c.set("ctx", ctx);
		await next();
	});
	app.route("/", httpAppFor(ctx));
	const changes = async (since: string | null): Promise<NodeChangesResponse> =>
	{
		const query = since === null ? "" : `?since=${encodeURIComponent(since)}`;
		const res = await app.fetch(new Request(`http://x/api/v1/nodes/changes${query}`));
		return (await res.json()) as NodeChangesResponse;
	};
	return {
		sqlite,
		db,
		api,
		adapter,
		changes,
	};
}

/** Answer the next `/push_and_poll` with `transactions`, logged after transaction 100. */
function respondWith(api: ReturnType<typeof createFakeInternalApi>, transactions: string[], latest: string): void
{
	api.respondOnce("/push_and_poll", () =>
		json(
			{
				results: [
					{
						new_most_recent_operation_transaction_id: latest,
						concurrent_remote_operation_transactions: transactions,
					},
				],
			},
		),
	);
}

/** Each listed node's name, note and completion, by id. */
function contents(body: NodeChangesResponse)
{
	return Object.fromEntries(
		body.children.flatMap(({nodes}) =>
			nodes.map((node) => [
				node.id,
				{
					name: node.name,
					note: node.note,
					completedAt: node.completedAt,
					modifiedAt: node.modifiedAt,
				},
			]),
		),
	);
}

/** The `modifiedAt` every seeded node starts with. */
const SEEDED_SEC = 200;

/** The unit of work's system time, in seconds, at which the replayed catch-up runs. */
const REPLAY_SEC = Math.floor((T0 + TRANSACTION_TIMEOUT_MS + 70_000) / 1000);

function shape(body: NodeChangesResponse)
{
	return {
		reset: body.reset,
		changedIds: new Set(body.changedIds),
		deletedIds: new Set(body.deletedIds),
		children: Object.fromEntries(
			body.children.map(({parentId, nodes}) => [parentId ?? "home", nodes.map((node) => node.id)]),
		),
	};
}

describe("remote transactions reach the nodes change feed", () =>
{
	let open: DatabaseConstructor.Database[] = [];
	afterEach(() =>
	{
		for (const sqlite of open)
		{
			sqlite.close();
		}
		open = [];
		vi.useRealTimers();
	});

	it("a remote move caught up through the adapter lists the moved node and both parents' refreshed children", async () =>
	{
		const {sqlite, api, adapter, changes} = setup();
		open.push(sqlite);
		const seeded = await changes(null);
		vi.setSystemTime(T0 + TRANSACTION_TIMEOUT_MS + 70_000);
		api.respondOnce("/push_and_poll", () =>
			json(
				{
					results: [
						{
							new_most_recent_operation_transaction_id: "101",
							concurrent_remote_operation_transactions: [
								transaction(101, [
									{
										type: "move",
										data:
										{
											projectid: "X",
											parentid: "P2",
											priority: 1,
										},
									},
								]),
							],
						},
					],
				},
			),
		);

		await adapter.catchUp();
		const body = await changes(seeded.latest);

		expect(
			{
				...shape(body),
				contents: contents(body),
			},
		).toStrictEqual(
			{
				reset: false,
				changedIds: new Set(["X", "P2"]),
				deletedIds: new Set(),
				children:
				{
					home: ["P1", "P2"],
					P1: ["Y"],
					P2: ["Z", "X"],
				},
				// workflowy.com stamps the moved node and its new parent, never the old parent or a sibling.
				contents:
				{
					P1:
					{
						name: "P1",
						note: null,
						completedAt: null,
						modifiedAt: SEEDED_SEC,
					},
					P2:
					{
						name: "P2",
						note: null,
						completedAt: null,
						modifiedAt: REPLAY_SEC,
					},
					X:
					{
						name: "X",
						note: null,
						completedAt: null,
						modifiedAt: REPLAY_SEC,
					},
					Y:
					{
						name: "Y",
						note: null,
						completedAt: null,
						modifiedAt: SEEDED_SEC,
					},
					Z:
					{
						name: "Z",
						note: null,
						completedAt: null,
						modifiedAt: SEEDED_SEC,
					},
				},
			},
		);
	});

	it("a remote bulk_move lands the block after the non-moved siblings its priority counts, Home included", async () =>
	{
		const {sqlite, api, adapter, changes} = setup();
		open.push(sqlite);
		const seeded = await changes(null);
		vi.setSystemTime(T0 + TRANSACTION_TIMEOUT_MS + 70_000);
		api.respondOnce("/push_and_poll", () =>
			json(
				{
					results: [
						{
							new_most_recent_operation_transaction_id: "101",
							concurrent_remote_operation_transactions: [
								transaction(101, [
									{
										type: "bulk_move",
										data:
										{
											projectids_json: JSON.stringify(["Y", "Z"]),
											parentid: "None",
											priority: 1,
										},
									},
								]),
							],
						},
					],
				},
			),
		);

		await adapter.catchUp();
		const body = await changes(seeded.latest);

		expect(shape(body)).toStrictEqual(
			{
				reset: false,
				changedIds: new Set(["Y", "Z"]),
				deletedIds: new Set(),
				children:
				{
					home: ["P1", "Y", "Z", "P2"],
					P1: ["X"],
					P2: [],
				},
			},
		);
	});
	it("a remote edit renames the node and replaces its note", async () =>
	{
		const {sqlite, api, adapter, changes} = setup();
		open.push(sqlite);
		const seeded = await changes(null);
		vi.setSystemTime(T0 + TRANSACTION_TIMEOUT_MS + 70_000);
		respondWith(
			api,
			[
				transaction(101, [
					{
						type: "edit",
						data:
						{
							projectid: "X",
							name: "Renamed",
							description: "A note",
						},
					},
				]),
			],
			"101",
		);

		await adapter.catchUp();
		const body = await changes(seeded.latest);

		expect(
			{
				...shape(body),
				contents: contents(body),
			},
		).toStrictEqual(
			{
				reset: false,
				changedIds: new Set(["X"]),
				deletedIds: new Set(),
				children:
				{
					P1: ["X", "Y"],
				},
				contents:
				{
					X:
					{
						name: "Renamed",
						note: "A note",
						completedAt: null,
						modifiedAt: REPLAY_SEC,
					},
					Y:
					{
						name: "Y",
						note: null,
						completedAt: null,
						modifiedAt: SEEDED_SEC,
					},
				},
			},
		);
	});

	it("a remote bulk_create inserts the trees at starting_priority with their children", async () =>
	{
		const {sqlite, api, adapter, changes} = setup();
		open.push(sqlite);
		const seeded = await changes(null);
		vi.setSystemTime(T0 + TRANSACTION_TIMEOUT_MS + 70_000);
		respondWith(
			api,
			[
				transaction(101, [
					{
						type: "bulk_create",
						data:
						{
							parentid: "P1",
							starting_priority: 1,
							project_trees: JSON.stringify([
								{
									id: "N",
									nm: "New",
									no: "Its note",
									ct: 1000,
									ch: [
										{
											id: "C",
											nm: "Child",
											ct: 1000,
										},
									],
								},
							]),
							isForSearch: false,
						},
					},
					// Captured from workflowy.com: pressing Enter logs a nameless tree with empty metadata and `cb`.
					{
						type: "bulk_create",
						data:
						{
							parentid: "P2",
							starting_priority: 0,
							project_trees: JSON.stringify([
								{
									metadata: {},
									id: "U",
									ct: 1000,
									cb: 107_483,
								},
							]),
							isForSearch: false,
						},
					},
					// A node created through the public REST API logs a null note; its name may carry an @mention link.
					{
						type: "bulk_create",
						data:
						{
							parentid: "P2",
							starting_priority: 2,
							project_trees: JSON.stringify([
								{
									id: "R",
									nm: '@Alice <a href="https://workflowy.com/#/0123456789ab">↗</a>',
									no: null,
									ct: 1000,
									metadata: {},
								},
							]),
							isForSearch: false,
						},
					},
				]),
			],
			"101",
		);

		await adapter.catchUp();
		const body = await changes(seeded.latest);

		expect(
			{
				...shape(body),
				contents: contents(body),
			},
		).toStrictEqual(
			{
				reset: false,
				changedIds: new Set(["N", "C", "U", "R"]),
				deletedIds: new Set(),
				children:
				{
					P1: ["X", "N", "Y"],
					N: ["C"],
					P2: ["U", "Z", "R"],
				},
				contents:
				{
					X:
					{
						name: "X",
						note: null,
						completedAt: null,
						modifiedAt: SEEDED_SEC,
					},
					N:
					{
						name: "New",
						note: "Its note",
						completedAt: null,
						modifiedAt: REPLAY_SEC,
					},
					Y:
					{
						name: "Y",
						note: null,
						completedAt: null,
						modifiedAt: SEEDED_SEC,
					},
					C:
					{
						name: "Child",
						note: null,
						completedAt: null,
						modifiedAt: REPLAY_SEC,
					},
					U:
					{
						name: null,
						note: null,
						completedAt: null,
						modifiedAt: REPLAY_SEC,
					},
					Z:
					{
						name: "Z",
						note: null,
						completedAt: null,
						modifiedAt: SEEDED_SEC,
					},
					R:
					{
						name: '@Alice <a href="https://workflowy.com/#/0123456789ab">↗</a>',
						note: null,
						completedAt: null,
						modifiedAt: REPLAY_SEC,
					},
				},
			},
		);
	});

	it("a remote bulk_create under an uncached parent is skipped", async () =>
	{
		const {sqlite, api, adapter, changes} = setup();
		open.push(sqlite);
		const seeded = await changes(null);
		vi.setSystemTime(T0 + TRANSACTION_TIMEOUT_MS + 70_000);
		respondWith(
			api,
			[
				transaction(101, [
					{
						type: "bulk_create",
						data:
						{
							parentid: "Q",
							starting_priority: 0,
							project_trees: JSON.stringify([
								{
									id: "N",
									nm: "New",
									ct: 1000,
								},
							]),
						},
					},
				]),
			],
			"101",
		);

		await adapter.catchUp();
		const body = await changes(seeded.latest);

		expect(shape(body)).toStrictEqual(
			{
				reset: false,
				changedIds: new Set(),
				deletedIds: new Set(),
				children: {},
			},
		);
	});

	it("a remote complete then uncomplete sets and clears completedAt", async () =>
	{
		const {sqlite, api, adapter, changes} = setup();
		open.push(sqlite);
		const seeded = await changes(null);
		vi.setSystemTime(T0 + TRANSACTION_TIMEOUT_MS + 70_000);
		respondWith(
			api,
			[
				transaction(101, [
					{
						type: "complete",
						data:
						{
							projectid: "X",
						},
					},
				]),
			],
			"101",
		);

		await adapter.catchUp();
		const completed = await changes(seeded.latest);

		const uncompletedAt = T0 + 2 * TRANSACTION_TIMEOUT_MS + 140_000;
		vi.setSystemTime(uncompletedAt);
		respondWith(
			api,
			[
				transaction(102, [
					{
						type: "uncomplete",
						data:
						{
							projectid: "X",
						},
					},
				]),
			],
			"102",
		);
		await adapter.catchUp();
		const uncompleted = await changes(completed.latest);

		expect(
			{
				completed:
				{
					...shape(completed),
					contents: contents(completed),
				},
				uncompleted:
				{
					...shape(uncompleted),
					contents: contents(uncompleted),
				},
			},
		).toStrictEqual(
			{
				completed:
				{
					reset: false,
					changedIds: new Set(["X"]),
					deletedIds: new Set(),
					children:
					{
						P1: ["X", "Y"],
					},
					contents:
					{
						X:
						{
							name: "X",
							note: null,
							completedAt: REPLAY_SEC,
							modifiedAt: REPLAY_SEC,
						},
						Y:
						{
							name: "Y",
							note: null,
							completedAt: null,
							modifiedAt: SEEDED_SEC,
						},
					},
				},
				uncompleted:
				{
					reset: false,
					changedIds: new Set(["X"]),
					deletedIds: new Set(),
					children:
					{
						P1: ["X", "Y"],
					},
					contents:
					{
						X:
						{
							name: "X",
							note: null,
							completedAt: null,
							modifiedAt: Math.floor(uncompletedAt / 1000),
						},
						Y:
						{
							name: "Y",
							note: null,
							completedAt: null,
							modifiedAt: SEEDED_SEC,
						},
					},
				},
			},
		);
	});

	it("a remote delete ends the node's subtree and leaves its siblings' keys alone", async () =>
	{
		const {sqlite, api, adapter, changes} = setup();
		open.push(sqlite);
		const seeded = await changes(null);
		vi.setSystemTime(T0 + TRANSACTION_TIMEOUT_MS + 70_000);
		respondWith(
			api,
			[
				transaction(101, [
					{
						type: "delete",
						data:
						{
							projectid: "P1",
						},
					},
				]),
			],
			"101",
		);

		await adapter.catchUp();
		const body = await changes(seeded.latest);

		expect(shape(body)).toStrictEqual(
			{
				reset: false,
				changedIds: new Set(["P1", "X", "Y"]),
				deletedIds: new Set(["P1", "X", "Y"]),
				children:
				{
					home: ["P2"],
				},
			},
		);
	});
	it("a remote undelete restores the subtree at its slot, keeping createdAt and stamping every restored node", async () =>
	{
		const {sqlite, api, adapter, changes} = setup();
		open.push(sqlite);
		vi.setSystemTime(T0 + TRANSACTION_TIMEOUT_MS + 70_000);
		respondWith(
			api,
			[
				transaction(101, [
					{
						type: "delete",
						data:
						{
							projectid: "P1",
						},
					},
				]),
			],
			"101",
		);
		await adapter.catchUp();
		const deleted = await changes(null);
		const restoredAt = T0 + 2 * TRANSACTION_TIMEOUT_MS + 140_000;
		vi.setSystemTime(restoredAt);
		respondWith(
			api,
			[
				transaction(102, [
					{
						type: "undelete",
						data:
						{
							projectid: "P1",
							parentid: "None",
							priority: 1,
						},
					},
				]),
			],
			"102",
		);

		await adapter.catchUp();
		const body = await changes(deleted.latest);

		const restoredSec = Math.floor(restoredAt / 1000);
		expect(
			{
				...shape(body),
				contents: contents(body),
				createdAt: Object.fromEntries(
					body.children.flatMap(({nodes}) => nodes.map((node) => [node.id, node.createdAt])),
				),
			},
		).toStrictEqual(
			{
				reset: false,
				changedIds: new Set(["P1", "X", "Y"]),
				deletedIds: new Set(),
				children:
				{
					home: ["P2", "P1"],
					P1: ["X", "Y"],
				},
				// workflowy.com's undelete stamps every restored node and never the parent.
				contents:
				{
					P1:
					{
						name: "P1",
						note: null,
						completedAt: null,
						modifiedAt: restoredSec,
					},
					P2:
					{
						name: "P2",
						note: null,
						completedAt: null,
						modifiedAt: SEEDED_SEC,
					},
					X:
					{
						name: "X",
						note: null,
						completedAt: null,
						modifiedAt: restoredSec,
					},
					Y:
					{
						name: "Y",
						note: null,
						completedAt: null,
						modifiedAt: restoredSec,
					},
				},
				createdAt:
				{
					P1: 100,
					P2: 100,
					X: 100,
					Y: 100,
				},
			},
		);
	});

	it("a remote delete then undelete in one batch leaves the subtree live at the undelete's slot", async () =>
	{
		const {sqlite, api, adapter, changes} = setup();
		open.push(sqlite);
		const seeded = await changes(null);
		vi.setSystemTime(T0 + TRANSACTION_TIMEOUT_MS + 70_000);
		respondWith(
			api,
			[
				transaction(101, [
					{
						type: "edit",
						data:
						{
							projectid: "X",
							name: "Renamed",
						},
					},
					{
						type: "delete",
						data:
						{
							projectid: "P1",
						},
					},
					{
						type: "undelete",
						data:
						{
							projectid: "P1",
							parentid: "P2",
							priority: 0,
						},
					},
				]),
			],
			"101",
		);

		await adapter.catchUp();
		const body = await changes(seeded.latest);

		expect(
			{
				...shape(body),
				contents: contents(body),
			},
		).toStrictEqual(
			{
				reset: false,
				changedIds: new Set(["P1", "X", "Y"]),
				deletedIds: new Set(),
				children:
				{
					home: ["P2"],
					P1: ["X", "Y"],
					P2: ["P1", "Z"],
				},
				contents:
				{
					P1:
					{
						name: "P1",
						note: null,
						completedAt: null,
						modifiedAt: REPLAY_SEC,
					},
					P2:
					{
						name: "P2",
						note: null,
						completedAt: null,
						modifiedAt: SEEDED_SEC,
					},
					X:
					{
						name: "Renamed",
						note: null,
						completedAt: null,
						modifiedAt: REPLAY_SEC,
					},
					Y:
					{
						name: "Y",
						note: null,
						completedAt: null,
						modifiedAt: REPLAY_SEC,
					},
					Z:
					{
						name: "Z",
						note: null,
						completedAt: null,
						modifiedAt: SEEDED_SEC,
					},
				},
			},
		);
	});

	describe("around pending outbox rows", () =>
	{
		/** A mirror-mode local write, recorded in the outbox, made before the catch-up's clock. */
		function writeLocally(db: ReturnType<typeof setup>["db"], write: (writer: LocalTreeWriter) => void): void
		{
			write(
				new LocalTreeWriter(
					db,
					{
						outbox: new OutboxRecorder(),
					},
				),
			);
			vi.setSystemTime(T0 + TRANSACTION_TIMEOUT_MS + 70_000);
		}

		/** Each live node's name, note and parent, and the pending outbox aspects of the seeded nodes. */
		function state(db: ReturnType<typeof setup>["db"])
		{
			const live = db
				.select()
				.from(schema.nodeContent)
				.all()
				.filter((row) => row.systemTo === FAR_FUTURE_DATE)
				.map((row) => `${row.id}:${row.name}:${row.note}:${row.parentId}`);
			// oxlint-disable-next-line unicorn/no-array-sort -- the test tsconfig lib has no toSorted
			live.sort();
			return {
				live,
				pending: pendingAspects(db, ["P1", "P2", "X", "Y", "Z"]),
			};
		}

		it("a remote edit keeps the pending local name and takes the remote note", async () =>
		{
			const {sqlite, db, api, adapter} = setup();
			open.push(sqlite);
			writeLocally(db, (writer) =>
			{
				writer.updateNode(
					"X",
					{
						name: "Local",
					},
				);
			});
			respondWith(
				api,
				[
					transaction(101, [
						{
							type: "edit",
							data:
							{
								projectid: "X",
								name: "Remote",
								description: "A note",
							},
						},
					]),
				],
				"101",
			);

			await adapter.catchUp();

			expect(state(db)).toStrictEqual(
				{
					live: ["P1:P1:null:null", "P2:P2:null:null", "X:Local:A note:P1", "Y:Y:null:P1", "Z:Z:null:P2"],
					pending: new Map([["X", new Set(["name"])]]),
				},
			);
		});

		it("a remote move keeps a node with a pending placement where the local move put it", async () =>
		{
			const {sqlite, db, api, adapter} = setup();
			open.push(sqlite);
			writeLocally(db, (writer) =>
			{
				writer.moveTo(
					{
						ids: ["X"],
						parentId: "P2",
					},
				);
			});
			respondWith(
				api,
				[
					transaction(101, [
						{
							type: "bulk_move",
							data:
							{
								projectids_json: JSON.stringify(["X", "Y"]),
								parentid: "None",
								priority: 0,
							},
						},
					]),
				],
				"101",
			);

			await adapter.catchUp();

			expect(state(db)).toStrictEqual(
				{
					live: ["P1:P1:null:null", "P2:P2:null:null", "X:X:null:P2", "Y:Y:null:null", "Z:Z:null:P2"],
					pending: new Map([["X", new Set(["placement"])]]),
				},
			);
		});

		it("a remote undelete leaves a node with a pending local delete deleted", async () =>
		{
			const {sqlite, db, api, adapter} = setup();
			open.push(sqlite);
			respondWith(
				api,
				[
					transaction(101, [
						{
							type: "delete",
							data:
							{
								projectid: "P1",
							},
						},
					]),
				],
				"101",
			);
			await adapter.catchUp();
			vi.setSystemTime(T0 + 2 * TRANSACTION_TIMEOUT_MS + 140_000);
			new LocalTreeWriter(
				db,
				{
					outbox: new OutboxRecorder(),
				},
			).deleteNode("P2");
			vi.setSystemTime(T0 + 2 * TRANSACTION_TIMEOUT_MS + 150_000);
			respondWith(
				api,
				[
					transaction(102, [
						{
							type: "undelete",
							data:
							{
								projectid: "P2",
								parentid: "None",
								priority: 0,
							},
						},
						{
							type: "undelete",
							data:
							{
								projectid: "P1",
								parentid: "P2",
								priority: 0,
							},
						},
					]),
				],
				"102",
			);

			await adapter.catchUp();

			expect(state(db)).toStrictEqual(
				{
					live: [],
					pending: new Map([
						["P2", new Set(["delete"])],
						["Z", new Set(["delete"])],
					]),
				},
			);
		});

		it("a remote delete of a node with pending edits wins, closes their outbox rows and fails the catch-up loudly", async () =>
		{
			const {sqlite, db, api, adapter} = setup();
			open.push(sqlite);
			vi.spyOn(console, "error").mockImplementation(() => {});
			writeLocally(db, (writer) =>
			{
				writer.updateNode(
					"Y",
					{
						name: "Local",
					},
				);
				writer.updateNode(
					"Z",
					{
						name: "Kept",
					},
				);
			});
			respondWith(
				api,
				[
					transaction(101, [
						{
							type: "delete",
							data:
							{
								projectid: "P1",
							},
						},
					]),
				],
				"101",
			);

			const error = await adapter.catchUp().then(
				() => null,
				(caught: unknown) => caught,
			);

			expect(
				{
					error: error instanceof PendingEditsDeletedUpstream ? error.nodeIds : error,
					...state(db),
				},
			).toStrictEqual(
				{
					error: ["Y"],
					live: ["P2:P2:null:null", "Z:Kept:null:P2"],
					pending: new Map([["Z", new Set(["name"])]]),
				},
			);
		});
	});
});
