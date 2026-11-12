import DatabaseConstructor from "better-sqlite3";
import {eq} from "drizzle-orm";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {join} from "node:path";
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {z} from "zod";
import {WorkflowyInternalClient} from "../src/api/workflowy-internal-client.js";
import {CacheService} from "../src/cache/cache-service.js";
import {runUnitOfWork} from "../src/cache/node-composite.js";
import {advanceTreeTxId, readTreeTxId, storeTreeTxId} from "../src/cache/tree-transaction.js";
import * as schema from "../src/db/schema.js";
import {WorkflowyInternalAdapter} from "../src/internal/adapter.js";
import
{
	TreeNotSeeded,
	TreeRefreshRequired,
	TreeResyncRequired,
	UnreplayableTransaction,
} from "../src/internal/errors.js";
import {FAR_FUTURE_DATE} from "../src/temporal/index.js";
import {createFakeInternalApi, json, treeDataReads} from "./helpers/fake-internal-api.js";
import type {RecordedRequest} from "./helpers/fake-internal-api.js";

const migrationsFolder = join(import.meta.dirname, "../src/db/migrations");
const START_MS = 1_800_000_000_000;

function setup()
{
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
			now: () => START_MS,
			pushAndPoll:
			{
				randomId: () => "pollid01",
				timezone: "America/New_York",
				sleep: async () =>
				{
				},
			},
		},
	);
	const cache = new CacheService(db);
	const edges = () => (
	{
		mirrors: db
			.select(
				{
					mirrorId: schema.mirrors.mirrorId,
					originalId: schema.mirrors.originalId,
				},
			)
			.from(schema.mirrors)
			.where(eq(schema.mirrors.systemTo, FAR_FUTURE_DATE))
			.all()
			.toSorted((a, b) => a.mirrorId.localeCompare(b.mirrorId)),
		referencesRoots: db
			.select(
				{
					nodeId: schema.referencesRoots.nodeId,
				},
			)
			.from(schema.referencesRoots)
			.where(eq(schema.referencesRoots.systemTo, FAR_FUTURE_DATE))
			.all(),
	});
	return {
		sqlite,
		db,
		api,
		adapter,
		cache,
		edges,
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

function poll(txId: string, remote: string[], extra: Record<string, unknown> = {})
{
	return () =>
		json(
			{
				results: [
					{
						new_most_recent_operation_transaction_id: txId,
						concurrent_remote_operation_transactions: remote,
						...extra,
					},
				],
			},
		);
}

function leafAdd(projectid: string, field: string, mirrorId: string)
{
	return {
		type: "edit",
		data:
		{
			projectid,
			metadataPatches: [
				{
					op: "add",
					path: ["mirror", field, mirrorId],
					value: true,
				},
			],
		},
	};
}

const PushDataSchema = z.array(
	z
		.object(
			{
				most_recent_operation_transaction_id: z.string(),
			},
		)
		.loose(),
);

/** The transaction id each push or poll started from. */
function startIds(requests: RecordedRequest[]): string[]
{
	return requests
		.filter((request) => request.path === "/push_and_poll")
		.flatMap((request) =>
			PushDataSchema.parse(JSON.parse(new URLSearchParams(request.body ?? "").get("push_poll_data") ?? "[]")).map(
				(tree) => tree.most_recent_operation_transaction_id,
			),
		);
}

/** What `promise` rejects with, or undefined when it resolves. */
async function caughtBy(promise: Promise<unknown>): Promise<unknown>
{
	try
	{
		await promise;
		return undefined;
	}
	catch (error)
	{
		return error;
	}
}

describe("WorkflowyInternalAdapter transaction log", () =>
{
	let open: DatabaseConstructor.Database[] = [];
	afterEach(() =>
	{
		for (const sqlite of open)
		{
			sqlite.close();
		}
		open = [];
		vi.restoreAllMocks();
	});
	function tracked()
	{
		const context = setup();
		open.push(context.sqlite);
		return context;
	}

	it("catches up from the stored id: a remote leaf add becomes a mirror row and the id advances, with no tree read", async () =>
	{
		const {db, api, adapter, edges} = tracked();
		storeTreeTxId(db, "100");
		api.respondOnce("/push_and_poll", poll("105", [transaction(103, [leafAdd("orig", "mirrorRootIds", "m1")])]));

		await adapter.catchUp();

		expect(
			{
				starts: startIds(api.requests),
				edges: edges(),
				txId: readTreeTxId(db),
				reads: treeDataReads(api),
			},
		).toStrictEqual(
			{
				starts: ["100"],
				edges:
				{
					mirrors: [
						{
							mirrorId: "m1",
							originalId: "orig",
						},
					],
					referencesRoots: [],
				},
				txId: "105",
				reads: 0,
			},
		);
	});

	it("records bulk_create metadata in the REST log format: mirror roots, references roots and backlink items", async () =>
	{
		const {db, api, adapter, edges} = tracked();
		storeTreeTxId(db, "100");
		const restTrees = `[{"id": "m3", "nm": "", "no": "", "ct": 1, "metadata": {"mirror": {"originalId": "o3", "isMirrorRoot": true}}}]`;
		api.respondOnce(
			"/push_and_poll",
			poll("110", [
				transaction(101, [
					{
						type: "bulk_create",
						data:
						{
							parentid: "box",
							starting_priority: 1_000_000,
							project_trees: restTrees,
						},
					},
				]),
				transaction(102, [
					{
						type: "bulk_create",
						data:
						{
							parentid: "t2",
							starting_priority: 0,
							project_trees: JSON.stringify([
								{
									id: "rr2",
									nm: "",
									metadata:
									{
										isReferencesRoot: true,
									},
									ch: [
										{
											id: "bl2",
											nm: "",
											metadata:
											{
												mirror:
												{
													originalId: "s2",
													isMirrorRoot: true,
												},
												backlink:
												{
													sourceID: "s2",
													targetID: "t2",
												},
											},
										},
									],
								},
							]),
						},
					},
				]),
			]),
		);

		await adapter.catchUp();

		expect(edges()).toStrictEqual(
			{
				mirrors: [
					{
						mirrorId: "bl2",
						originalId: "s2",
					},
					{
						mirrorId: "m3",
						originalId: "o3",
					},
				],
				referencesRoots: [
					{
						nodeId: "rr2",
					},
				],
			},
		);
	});

	it("merges a whole-map REST add instead of replacing it, then applies the leaf remove", async () =>
	{
		const {db, api, adapter, cache, edges} = tracked();
		storeTreeTxId(db, "100");
		cache.recordRelationships(
			{
				mirrors: [
					{
						mirrorId: "m2",
						originalId: "o2",
					},
				],
				referencesRoots: [],
				aiMetadata: [],
			},
		);
		api.respondOnce(
			"/push_and_poll",
			poll("120", [
				transaction(111, [
					{
						type: "edit",
						data:
						{
							projectid: "o2",
							metadataPatches: [
								{
									op: "add",
									path: ["mirror", "mirrorRootIds"],
									value:
									{
										m4: true,
									},
								},
							],
						},
					},
				]),
				transaction(112, [
					{
						type: "edit",
						data:
						{
							projectid: "o2",
							metadataPatches: [
								{
									op: "remove",
									path: ["mirror", "mirrorRootIds", "m4"],
								},
							],
						},
					},
					{
						type: "delete",
						data:
						{
							projectid: "m4",
						},
					},
				]),
			]),
		);

		await adapter.catchUp();

		expect(edges().mirrors).toStrictEqual([
			{
				mirrorId: "m2",
				originalId: "o2",
			},
		]);
	});

	it("ends every mirror row of a node on remove [mirror] and a references-root row on its remove, keeping a backlink item's mirror on remove [backlink]", async () =>
	{
		const {db, api, adapter, cache, edges} = tracked();
		storeTreeTxId(db, "100");
		cache.recordRelationships(
			{
				mirrors: [
					{
						mirrorId: "m3",
						originalId: "o3",
					},
					{
						mirrorId: "bl",
						originalId: "src",
					},
				],
				referencesRoots: [
					{
						nodeId: "rr",
					},
				],
				aiMetadata: [],
			},
		);
		api.respondOnce(
			"/push_and_poll",
			poll("130", [
				transaction(121, [
					{
						type: "edit",
						data:
						{
							projectid: "o3",
							metadataPatches: [
								{
									op: "remove",
									path: ["mirror"],
								},
							],
						},
					},
					{
						type: "edit",
						data:
						{
							projectid: "bl",
							metadataPatches: [
								{
									op: "remove",
									path: ["backlink"],
								},
							],
						},
					},
					{
						type: "edit",
						data:
						{
							projectid: "rr",
							metadataPatches: [
								{
									op: "remove",
									path: ["isReferencesRoot"],
								},
							],
						},
					},
				]),
			]),
		);

		await adapter.catchUp();

		expect(edges()).toStrictEqual(
			{
				mirrors: [
					{
						mirrorId: "bl",
						originalId: "src",
					},
				],
				referencesRoots: [],
			},
		);
	});

	it("ends the mirror and references-root rows a deleted node and its subtree own, including nodes created earlier in the batch", async () =>
	{
		const {db, api, adapter, cache, edges} = tracked();
		storeTreeTxId(db, "100");
		for (const [id, parentId] of [
			["p", null],
			["c", "p"],
			["gc", "c"],
			["o1", null],
			["m9", null],
		] as const)
		{
			db.insert(schema.nodeContent)
				.values(
					{
						id,
						name: id,
						parentId,
						systemFrom: "2026-01-01",
						systemTo: FAR_FUTURE_DATE,
					},
				)
				.run();
		}
		cache.recordRelationships(
			{
				mirrors: [
					{
						mirrorId: "c",
						originalId: "o1",
					},
					{
						mirrorId: "gc",
						originalId: "src",
					},
					{
						mirrorId: "m9",
						originalId: "o9",
					},
				],
				referencesRoots: [
					{
						nodeId: "p",
					},
				],
				aiMetadata: [],
			},
		);
		api.respondOnce(
			"/push_and_poll",
			poll("135", [
				transaction(131, [
					{
						type: "bulk_create",
						data:
						{
							parentid: "gc",
							starting_priority: 0,
							project_trees: JSON.stringify([
								{
									id: "n1",
									nm: "",
									ch: [
										{
											id: "n2",
											nm: "",
											metadata:
											{
												mirror:
												{
													originalId: "o5",
													isMirrorRoot: true,
												},
											},
										},
									],
								},
							]),
						},
					},
				]),
				transaction(132, [
					{
						type: "delete",
						data:
						{
							projectid: "p",
						},
					},
				]),
			]),
		);

		await adapter.catchUp();

		expect(edges()).toStrictEqual(
			{
				mirrors: [
					{
						mirrorId: "m9",
						originalId: "o9",
					},
				],
				referencesRoots: [],
			},
		);
	});

	it("applies a transaction the poll repeats from our own push only once", async () =>
	{
		const {db, api, adapter, edges} = tracked();
		storeTreeTxId(db, "100");
		const own = [leafAdd("orig", "mirrorRootIds", "m1")];
		api.respondOnce(
			"/push_and_poll",
			poll(
				"141",
				[
					transaction(140, own),
					transaction(141, [
						{
							type: "edit",
							data:
							{
								projectid: "orig",
								metadataPatches: [
									{
										op: "remove",
										path: ["mirror", "mirrorRootIds", "m1"],
									},
								],
							},
						},
					]),
				],
				{
					server_run_operation_transaction_json: transaction(140, own),
				},
			),
		);

		await adapter.catchUp();

		expect(edges().mirrors).toStrictEqual([]);
	});

	it("starts adapter writes from the stored id and keeps a larger id another process stored meanwhile", async () =>
	{
		const {db, api, adapter} = tracked();
		storeTreeTxId(db, "100");
		api.respondOnce("/push_and_poll", () =>
		{
			runUnitOfWork(db, (unitOfWork) =>
			{
				advanceTreeTxId(unitOfWork, "200");
			});
			return poll("150", [])();
		});

		await adapter.setRawExpansionKeys(
			{
				"1a2b3c4d": true,
			},
		);

		expect(
			{
				starts: startIds(api.requests),
				txId: readTreeTxId(db),
			},
		).toStrictEqual(
			{
				starts: ["100"],
				txId: "200",
			},
		);
	});

	it("fails loudly without pushing when the cache was never seeded", async () =>
	{
		const {api, adapter} = tracked();
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});

		const error = await caughtBy(adapter.catchUp());

		expect(
			{
				error,
				message: error instanceof Error ? error.message : undefined,
				pushes: startIds(api.requests),
				logged: logged.mock.calls,
			},
		).toStrictEqual(
			{
				error: expect.any(TreeNotSeeded),
				message:
					"The local cache has no Workflowy transaction id to sync from; run './bin/run.js cache import-api' to seed it",
				pushes: [],
				logged: [[error]],
			},
		);
	});

	it("fails loudly on need_refreshed_project_tree, applying nothing and keeping the stored id", async () =>
	{
		const {db, api, adapter, edges} = tracked();
		storeTreeTxId(db, "100");
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		api.respondOnce(
			"/push_and_poll",
			poll(
				"160",
				[transaction(155, [leafAdd("orig", "mirrorRootIds", "m1")])],
				{
					need_refreshed_project_tree: true,
				},
			),
		);

		const error = await caughtBy(adapter.catchUp());

		expect(
			{
				error,
				message: error instanceof Error ? error.message : undefined,
				txId: readTreeTxId(db),
				mirrors: edges().mirrors,
				pushes: startIds(api.requests),
				logged: logged.mock.calls,
			},
		).toStrictEqual(
			{
				error: expect.any(TreeRefreshRequired),
				message:
					"Workflowy answered need_refreshed_project_tree: the cache's transaction id 100 is no longer in the tree's log; run './bin/run.js cache import-api' to reseed it",
				txId: "100",
				mirrors: [],
				pushes: ["100"],
				logged: [[error]],
			},
		);
	});
	it.each([
		{
			name: "an edit whose metadata patches do not parse",
			op:
			{
				type: "edit",
				data:
				{
					projectid: "orig",
					metadataPatches: [
						{
							op: "add",
							path: "mirror",
						},
					],
				},
			},
		},
		{
			name: "a bulk_create whose project_trees is not JSON",
			op:
			{
				type: "bulk_create",
				data:
				{
					parentid: "None",
					project_trees: "[{not json",
				},
			},
		},
		{
			name: "a delete with no projectid",
			op:
			{
				type: "delete",
				data: {},
			},
		},
		{
			name: "a bulk_create whose trees have no id",
			op:
			{
				type: "bulk_create",
				data:
				{
					parentid: "None",
					project_trees: JSON.stringify([
						{
							nm: "x",
						},
					]),
				},
			},
		},
	])("fails loudly on $name, naming the transaction, applying nothing and keeping the stored id", async ({op}) =>
	{
		const {db, api, adapter, edges} = tracked();
		storeTreeTxId(db, "100");
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		api.respondOnce(
			"/push_and_poll",
			poll("160", [transaction(155, [leafAdd("orig", "mirrorRootIds", "m1")]), transaction(156, [op])]),
		);

		const error = await caughtBy(adapter.catchUp());

		expect(
			{
				error,
				resync: error instanceof TreeResyncRequired,
				message: error instanceof Error ? error.message : undefined,
				txId: readTreeTxId(db),
				mirrors: edges().mirrors,
				pushes: startIds(api.requests),
				logged: logged.mock.calls,
			},
		).toStrictEqual(
			{
				error: expect.any(UnreplayableTransaction),
				resync: true,
				message: `Workflowy transaction 156 has a ${op.type} op the cache cannot parse, so the cache would diverge from the tree; run './bin/run.js cache import-api' to reseed it`,
				txId: "100",
				mirrors: [],
				pushes: ["100"],
				logged: [[error]],
			},
		);
	});
});
