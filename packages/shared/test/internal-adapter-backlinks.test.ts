import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {join} from "node:path";
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {z} from "zod";
import {WorkflowyApiClient} from "../src/api/workflowy-client.js";
import {WorkflowyInternalClient} from "../src/api/workflowy-internal-client.js";
import {CacheService} from "../src/cache/cache-service.js";
import {collectItemRelationships, emptyItemRelationships} from "../src/cache/item-relationships.js";
import {WorkflowyWriteThroughClient} from "../src/cache/workflowy-write-through-client.js";
import {countStrandedRows} from "../src/cache/stranded-relationships.js";
import {storeTreeTxId} from "../src/cache/tree-transaction.js";
import * as schema from "../src/db/schema.js";
import {linkedSourcesInSubtree, WorkflowyInternalAdapter} from "../src/internal/adapter.js";
import {OperationRejected} from "../src/internal/errors.js";
import {applyMetadataPatches} from "../src/internal/metadata-patch.js";
import type {MetadataPatch} from "../src/internal/metadata-patch.js";
import {hasInternalLink, internalLinkShortIds} from "../src/workflowy/internal-links.js";
import {createFakeInternalApi, forbidTreeData, json, treeDataReads} from "./helpers/fake-internal-api.js";
import type {RecordedRequest} from "./helpers/fake-internal-api.js";

/** The current backlink items, derived as the app derives them: live mirrors under a live references root. */
const BACKLINKS = `(SELECT m.mirror_id AS node_id, m.original_id AS source_id, p.parent_id AS target_id, m.system_to
	FROM mirrors m
	JOIN node_content c ON c.id = m.mirror_id AND c.system_to = '9999-12-31 23:59:59'
	JOIN references_roots r ON r.node_id = c.parent_id AND r.system_to = '9999-12-31 23:59:59'
	JOIN node_content p ON p.id = c.parent_id AND p.system_to = '9999-12-31 23:59:59'
	WHERE m.system_to = '9999-12-31 23:59:59')`;

const migrationsFolder = join(import.meta.dirname, "../src/db/migrations");
const START_MS = 1_800_000_000_000;
const ROOT = "None";
const SEEDED = "2026-01-01 00:00:00";

const SOURCE = "11111111-1111-4111-8111-111111111111";
const TARGET = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const OLD_ROOT = "44444444-4444-4444-8444-444444444444";
const OLD_ITEM = "55555555-5555-4555-8555-555555555555";
const OTHER_ROOT = "66666666-6666-4666-8666-666666666666";
const CHILD = "77777777-7777-4777-8777-777777777777";
const CHILD_ITEM = "88888888-8888-4888-8888-888888888888";
const OTHER_ITEM = "99999999-9999-4999-8999-999999999999";

const link = (id: string) => `<a href="https://workflowy.com/#/${id.replaceAll("-", "").slice(-12)}">x</a>`;

const PushDataSchema = z.array(
	z.object(
		{
			operations: z
				.array(
					z
						.object(
							{
								type: z.string(),
								data: z.record(z.string(), z.unknown()),
							},
						)
						.loose(),
				)
				.optional(),
		},
	),
);
const OpDataSchema = z.object(
	{
		projectid: z.string().optional(),
		parentid: z.string().optional(),
		starting_priority: z.number().optional(),
		project_trees: z.string().optional(),
		metadataPatches: z.array(z.custom<MetadataPatch>()).optional(),
	},
);
const TreesSchema = z.array(
	z
		.object(
			{
				id: z.string(),
				nm: z.string(),
				no: z.string().optional(),
				metadata: z.record(z.string(), z.unknown()).optional(),
			},
		)
		.loose(),
);

interface ServerNode
{
	name: string;
	note: string | null;
	parent: string;
	metadata: Record<string, unknown>;
}

/** One server state behind both fakes: `/push_and_poll` applies ops, `/get_tree_data/` and `/api/v1/nodes*` read it. */
function createServer(initial: [string, ServerNode][], trashed: [string, ServerNode][] = [])
{
	const nodes = new Map(initial);
	const trash = new Map(trashed);
	const order = new Map<string, string[]>();
	for (const [id, node] of initial)
	{
		order.set(node.parent, [...(order.get(node.parent) ?? []), id]);
	}
	const children = (parent: string) => order.get(parent) ?? [];

	function apply(type: string, rawData: Record<string, unknown>): void
	{
		const data = OpDataSchema.parse(rawData);
		if (type === "bulk_create")
		{
			const parent = data.parentid ?? ROOT;
			const trees = TreesSchema.parse(JSON.parse(data.project_trees ?? "[]"));
			for (const tree of trees)
			{
				nodes.set(
					tree.id,
					{
						name: tree.nm,
						note: tree.no ?? null,
						parent,
						metadata: tree.metadata ?? {},
					},
				);
			}
			const list = [...children(parent)];
			list.splice(data.starting_priority ?? 0, 0, ...trees.map((tree) => tree.id));
			order.set(parent, list);
		}
		else if (type === "undelete" && data.projectid !== undefined)
		{
			const parent = data.parentid ?? ROOT;
			const restored = trash.get(data.projectid);
			if (restored)
			{
				nodes.set(
					data.projectid,
					{
						...restored,
						parent,
					},
				);
				order.set(parent, [...children(parent), data.projectid]);
			}
		}
		else if (type === "delete" && data.projectid !== undefined)
		{
			const node = nodes.get(data.projectid);
			if (node)
			{
				order.set(
					node.parent,
					children(node.parent).filter((id) => id !== data.projectid),
				);
				nodes.delete(data.projectid);
			}
		}
		else if (type === "edit" && data.projectid !== undefined)
		{
			const node = nodes.get(data.projectid);
			if (node)
			{
				node.metadata = applyMetadataPatches(node.metadata, data.metadataPatches ?? []);
			}
		}
	}

	function toApi(id: string)
	{
		const node = nodes.get(id);
		if (!node)
		{
			throw new Error(`no node ${id}`);
		}
		return {
			id,
			name: node.name,
			note: node.note,
			parent_id: node.parent === ROOT ? null : node.parent,
			priority: children(node.parent).indexOf(id) * 100,
			completed: false,
			createdAt: 0,
			modifiedAt: 0,
			completedAt: null,
		};
	}

	function publicFetch(url: string): Response
	{
		const path = url.replace("https://workflowy.test/api/v1", "");
		if (path === "/nodes" || path.startsWith("/nodes?"))
		{
			const parent = new URLSearchParams(path.split("?")[1] ?? "").get("parent_id") ?? ROOT;
			return Response.json(
				{
					nodes: children(parent).map(toApi),
				},
			);
		}
		const id = path.split("/")[2] ?? "";
		if (!nodes.has(id))
		{
			return Response.json(
				{
					error: "not found",
				},
				{
					status: 404,
				},
			);
		}
		return Response.json(
			{
				node: toApi(id),
			},
		);
	}

	return {
		apply,
		publicFetch,
		children,
	};
}

const SERVER_RUN = JSON.stringify(
	{
		ops: [],
		client_timestamp: 300_000_000,
	},
);

function pushedOps(request: RecordedRequest):
{
	type: string;
	data: Record<string, unknown>;
}[]
{
	const fields = new URLSearchParams(request.body ?? "");
	const trees = PushDataSchema.parse(JSON.parse(fields.get("push_poll_data") ?? "[]"));
	return trees.flatMap((tree) => tree.operations ?? []);
}

const node = (name: string, parent: string, metadata: Record<string, unknown> = {}, note: string | null = null) => (
{
	name,
	note,
	parent,
	metadata,
});

/**
 * Every read of `/get_tree_data/` fails, and the cache is seeded the way a whole-tree import would have: each
 * node cached, plus the edge rows of its `mirror`/`backlink`/`isReferencesRoot` metadata.
 */
async function setup(initial: [string, ServerNode][], trashed: [string, ServerNode][] = [])
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
	// A whole-tree import seeded the transaction-log position at the fake init's id.
	storeTreeTxId(db, "4567");
	const server = createServer(initial, trashed);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) => Promise.resolve(server.publicFetch(url))),
	);
	const api = createFakeInternalApi();
	const pushes:
	{
		type: string;
		data: Record<string, unknown>;
	}[][] = [];
	api.respond("/push_and_poll", (request) =>
	{
		const ops = pushedOps(request);
		if (ops.length > 0)
		{
			pushes.push(ops);
		}
		for (const op of ops)
		{
			server.apply(op.type, op.data);
		}
		return json(
			{
				results: [
					{
						new_most_recent_operation_transaction_id: "4568",
						server_run_operation_transaction_json: SERVER_RUN,
						concurrent_remote_operation_transactions: [],
					},
				],
			},
		);
	});
	const client = new WorkflowyInternalClient(
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
	);
	const apiClient = new WorkflowyApiClient(
		"test-key",
		undefined,
		"https://workflowy.test",
		{
			maxRetries: 0,
			baseDelayMs: 0,
			maxDelayMs: 0,
		},
	);
	const cacheService = new CacheService(db);
	const writeThrough = new WorkflowyWriteThroughClient(apiClient, cacheService);
	let next = 0;
	const adapter = new WorkflowyInternalAdapter(
		{
			client,
			db,
			writeThrough,
			now: () => START_MS,
			generateId: () => `00000000-0000-4000-8000-00000000000${++next}`,
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
	const parents = [...new Set(initial.map(([, value]) => value.parent))];
	await writeThrough.refreshChildren(parents.map((parent) => (parent === ROOT ? null : parent)));
	const imported = emptyItemRelationships();
	for (const [id, value] of initial)
	{
		collectItemRelationships(imported, id, value.metadata);
	}
	cacheService.recordRelationships(imported);
	forbidTreeData(api);
	const rows = (sql: string) => sqlite.prepare(sql).all();
	return {
		sqlite,
		db,
		api,
		adapter,
		pushes,
		server,
		cacheService,
		rows,
	};
}

const ID1 = "00000000-0000-4000-8000-000000000001";
const ID2 = "00000000-0000-4000-8000-000000000002";

describe("internal links", () =>
{
	it("finds short-id and full-id links on any host, deduplicated, ignoring bare urls", () =>
	{
		const text = `${link(TARGET)} <a href="https://beta.workflowy.com/#/${OTHER}">y</a> ${link(TARGET)} <a href="https://example.com/#/333333333333">z</a> https://workflowy.com/#/444444444444`;

		expect(
			{
				ids: internalLinkShortIds(text),
				has: hasInternalLink(text),
				none: hasInternalLink("plain"),
			},
		).toStrictEqual(
			{
				ids: ["222222222222", "333333333333"],
				has: true,
				none: false,
			},
		);
	});
});

describe("WorkflowyInternalAdapter.syncBacklinks", () =>
{
	let open: DatabaseConstructor.Database[] = [];
	afterEach(() =>
	{
		for (const sqlite of open)
		{
			sqlite.close();
		}
		open = [];
		vi.unstubAllGlobals();
	});
	async function tracked(initial: [string, ServerNode][], trashed: [string, ServerNode][] = [])
	{
		const result = await setup(initial, trashed);
		open.push(result.sqlite);
		return result;
	}

	it("creates the target's references root and a backlink mirror under it in one push, then caches them in one unit of work", async () =>
	{
		const {adapter, pushes, cacheService, rows} = await tracked([
			[SOURCE, node(`see ${link(TARGET)}`, ROOT)],
			[TARGET, node("target", ROOT)],
		]);

		const result = await adapter.syncBacklinks([SOURCE]);

		const current = "system_to = '9999-12-31 23:59:59'";
		expect(
			{
				result,
				pushes: pushes.map((ops) => ops.map((op) => [op.type, op.data])),
				targetChildren: cacheService.getChildren(TARGET).map((child) => child.id),
				rootChildren: cacheService.getChildren(ID1).map((child) => child.id),
				relations: rows(
					`SELECT 'root' AS kind, node_id AS id FROM references_roots WHERE ${current} UNION ALL SELECT 'backlink', node_id || '>' || source_id || '>' || target_id FROM ${BACKLINKS} WHERE ${current} UNION ALL SELECT 'mirror', mirror_id || '>' || original_id FROM mirrors WHERE ${current}`,
				),
				systemTimes: rows(
					`SELECT COUNT(DISTINCT system_from) AS n FROM (SELECT system_from FROM references_roots UNION ALL SELECT system_from FROM mirrors UNION ALL SELECT system_from FROM node_content WHERE id IN ('${ID1}', '${ID2}'))`,
				),
			},
		).toStrictEqual(
			{
				result:
				{
					created: [
						{
							id: ID2,
							sourceId: SOURCE,
							targetId: TARGET,
						},
					],
					referencesRoots: [ID1],
					deleted: [],
				},
				pushes: [
					[
						[
							"bulk_create",
							{
								parentid: TARGET,
								starting_priority: 0,
								project_trees: JSON.stringify([
									{
										id: ID1,
										nm: "",
										metadata:
										{
											isReferencesRoot: true,
										},
										ct: 300_000_000,
										cb: 123,
										ch: [],
									},
								]),
								isForSearch: false,
							},
						],
						[
							"bulk_create",
							{
								parentid: ID1,
								starting_priority: 0,
								project_trees: JSON.stringify([
									{
										id: ID2,
										nm: "",
										metadata:
										{
											mirror:
											{
												originalId: SOURCE,
												isMirrorRoot: true,
											},
											backlink:
											{
												sourceID: SOURCE,
												targetID: TARGET,
											},
										},
										ct: 300_000_000,
										cb: 123,
										ch: [],
									},
								]),
								isForSearch: false,
							},
						],
						[
							"edit",
							{
								projectid: SOURCE,
								metadataPatches: [
									{
										op: "add",
										path: ["mirror"],
										value:
										{
											backlinkMirrorRootIds:
											{
												[ID2]: true,
											},
										},
									},
								],
								metadataInversePatches: [
									{
										op: "remove",
										path: ["mirror"],
									},
								],
							},
						],
					],
				],
				targetChildren: [ID1],
				rootChildren: [ID2],
				relations: [
					{
						kind: "root",
						id: ID1,
					},
					{
						kind: "backlink",
						id: `${ID2}>${SOURCE}>${TARGET}`,
					},
					{
						kind: "mirror",
						id: `${ID2}>${SOURCE}`,
					},
				],
				systemTimes: [
					{
						n: 1,
					},
				],
			},
		);
	});

	it("reuses an existing references root and deletes a backlink whose link is gone, ending its composite", async () =>
	{
		const {api, adapter, pushes, rows} = await tracked([
			[
				SOURCE,
				node(
					`now ${link(OTHER)}`,
					ROOT,
					{
						mirror:
						{
							backlinkMirrorRootIds:
							{
								[OLD_ITEM]: true,
							},
						},
					},
				),
			],
			[TARGET, node("target", ROOT)],
			[OTHER, node("other", ROOT)],
			[
				OLD_ROOT,
				node(
					"",
					TARGET,
					{
						isReferencesRoot: true,
					},
				),
			],
			[
				OLD_ITEM,
				node(
					"",
					OLD_ROOT,
					{
						mirror:
						{
							originalId: SOURCE,
							isMirrorRoot: true,
						},
						backlink:
						{
							sourceID: SOURCE,
							targetID: TARGET,
						},
					},
				),
			],
			[
				OTHER_ROOT,
				node(
					"",
					OTHER,
					{
						isReferencesRoot: true,
					},
				),
			],
		]);

		const result = await adapter.syncBacklinks([SOURCE]);

		expect(
			{
				result,
				pushes: pushes.map((ops) => ops.map((op) => [op.type, op.data.projectid ?? op.data.parentid])),
				edit: pushes.flat().find((op) => op.type === "edit")?.data.metadataPatches,
				current: rows(`SELECT node_id, source_id, target_id FROM ${BACKLINKS} ORDER BY node_id`),
				oldItemCurrent: rows(
					`SELECT id FROM node_content WHERE id = '${OLD_ITEM}' AND system_to = '9999-12-31 23:59:59' UNION ALL SELECT mirror_id FROM mirrors WHERE mirror_id = '${OLD_ITEM}' AND system_to = '9999-12-31 23:59:59'`,
				),
				reads: treeDataReads(api),
			},
		).toStrictEqual(
			{
				result:
				{
					created: [
						{
							id: ID1,
							sourceId: SOURCE,
							targetId: OTHER,
						},
					],
					referencesRoots: [],
					deleted: [OLD_ITEM],
				},
				pushes: [
					[
						["delete", OLD_ITEM],
						["bulk_create", OTHER_ROOT],
						["edit", SOURCE],
					],
				],
				edit: [
					{
						op: "remove",
						path: ["mirror", "backlinkMirrorRootIds", OLD_ITEM],
					},
					{
						op: "add",
						path: ["mirror", "backlinkMirrorRootIds", ID1],
						value: true,
					},
				],
				current: [
					{
						node_id: ID1,
						source_id: SOURCE,
						target_id: OTHER,
					},
				],
				oldItemCurrent: [],
				reads: 0,
			},
		);
	});

	it("drops a backlinkMirrorRootIds entry whose item no longer exists, without a delete op", async () =>
	{
		const {adapter, pushes, sqlite} = await tracked([
			[
				SOURCE,
				node(
					"plain",
					ROOT,
					{
						mirror:
						{
							backlinkMirrorRootIds:
							{
								[OLD_ITEM]: true,
							},
						},
					},
				),
			],
		]);
		// An earlier import cached the item, under the target's references root, while it still existed.
		sqlite.exec(`
			INSERT INTO node_content (id, name, parent_id, system_from, system_to) VALUES
				('${TARGET}', 'target', NULL, '${SEEDED}', '9999-12-31 23:59:59'),
				('${OLD_ROOT}', '', '${TARGET}', '${SEEDED}', '9999-12-31 23:59:59'),
				('${OLD_ITEM}', '', '${OLD_ROOT}', '${SEEDED}', '9999-12-31 23:59:59');
			INSERT INTO references_roots VALUES ('${OLD_ROOT}', '${SEEDED}', '9999-12-31 23:59:59');
		`);

		const result = await adapter.syncBacklinks([SOURCE]);

		expect(
			{
				result,
				ops: pushes.flat().map((op) => [op.type, op.data.projectid]),
				edit: pushes.flat().find((op) => op.type === "edit")?.data.metadataPatches,
			},
		).toStrictEqual(
			{
				result:
				{
					created: [],
					referencesRoots: [],
					deleted: [],
				},
				ops: [["edit", SOURCE]],
				edit: [
					{
						op: "remove",
						path: ["mirror", "backlinkMirrorRootIds", OLD_ITEM],
					},
				],
			},
		);
	});

	it("pushes nothing when every link already has its backlink, or the source is a mirror", async () =>
	{
		const {adapter, pushes} = await tracked([
			[
				SOURCE,
				node(
					link(TARGET),
					ROOT,
					{
						mirror:
						{
							backlinkMirrorRootIds:
							{
								[OLD_ITEM]: true,
							},
						},
					},
				),
			],
			[TARGET, node("target", ROOT)],
			[
				OTHER,
				node(
					link(TARGET),
					ROOT,
					{
						mirror:
						{
							originalId: SOURCE,
							isMirrorRoot: true,
						},
					},
				),
			],
			[
				OLD_ROOT,
				node(
					"",
					TARGET,
					{
						isReferencesRoot: true,
					},
				),
			],
			[
				OLD_ITEM,
				node(
					"",
					OLD_ROOT,
					{
						mirror:
						{
							originalId: SOURCE,
							isMirrorRoot: true,
						},
						backlink:
						{
							sourceID: SOURCE,
							targetID: TARGET,
						},
					},
				),
			],
		]);

		const result = await adapter.syncBacklinks([SOURCE, OTHER]);

		expect(
			{
				result,
				pushes,
			},
		).toStrictEqual(
			{
				result:
				{
					created: [],
					referencesRoots: [],
					deleted: [],
				},
				pushes: [],
			},
		);
	});

	it("reuses a references root created upstream after the import, learned from the transaction log", async () =>
	{
		const {api, adapter, pushes, server} = await tracked([
			[SOURCE, node(`see ${link(TARGET)}`, ROOT)],
			[TARGET, node("target", ROOT)],
		]);
		const rootOp =
		{
			type: "bulk_create",
			data:
			{
				parentid: TARGET,
				starting_priority: 0,
				project_trees: JSON.stringify([
					{
						id: OTHER_ROOT,
						nm: "",
						metadata:
						{
							isReferencesRoot: true,
						},
					},
				]),
			},
		};
		server.apply(rootOp.type, rootOp.data);
		api.respondOnce("/push_and_poll", () =>
			json(
				{
					results: [
						{
							new_most_recent_operation_transaction_id: "4568",
							concurrent_remote_operation_transactions: [
								JSON.stringify(
									{
										id: 4568,
										client_timestamp: 300_000_000,
										ops: [rootOp],
									},
								),
							],
						},
					],
				},
			),
		);

		const result = await adapter.syncBacklinks([SOURCE]);

		expect(
			{
				result,
				pushes: pushes.map((ops) => ops.map((op) => [op.type, op.data.projectid ?? op.data.parentid])),
				targetChildren: server.children(TARGET),
				reads: treeDataReads(api),
			},
		).toStrictEqual(
			{
				result:
				{
					created: [
						{
							id: ID1,
							sourceId: SOURCE,
							targetId: TARGET,
						},
					],
					referencesRoots: [],
					deleted: [],
				},
				pushes: [
					[
						["bulk_create", OTHER_ROOT],
						["edit", SOURCE],
					],
				],
				targetChildren: [OTHER_ROOT],
				reads: 0,
			},
		);
	});

	it("points a link to a mirror at the mirror's original", async () =>
	{
		const {api, adapter, pushes} = await tracked([
			[SOURCE, node(`see ${link(CHILD)}`, ROOT)],
			[
				TARGET,
				node(
					"target",
					ROOT,
					{
						mirror:
						{
							mirrorRootIds:
							{
								[CHILD]: true,
							},
						},
					},
				),
			],
			[
				CHILD,
				node(
					"",
					ROOT,
					{
						mirror:
						{
							originalId: TARGET,
							isMirrorRoot: true,
						},
					},
				),
			],
		]);

		const result = await adapter.syncBacklinks([SOURCE]);

		expect(
			{
				result,
				pushes: pushes.map((ops) => ops.map((op) => [op.type, op.data.projectid ?? op.data.parentid])),
				reads: treeDataReads(api),
			},
		).toStrictEqual(
			{
				result:
				{
					created: [
						{
							id: ID2,
							sourceId: SOURCE,
							targetId: TARGET,
						},
					],
					referencesRoots: [ID1],
					deleted: [],
				},
				pushes: [
					[
						["bulk_create", TARGET],
						["bulk_create", ID1],
						["edit", SOURCE],
					],
				],
				reads: 0,
			},
		);
	});

	it("creates backlinks for a node created with a link in its note", async () =>
	{
		const {adapter, pushes, server} = await tracked([[TARGET, node("target", ROOT)]]);

		const {id} = await adapter.createAt(
			{
				parentId: "home",
				index: 0,
				name: "new",
				note: `see ${link(TARGET)}`,
			},
		);

		expect(
			{
				id,
				pushTypes: pushes.map((ops) => ops.map((op) => op.type)),
				targetChildren: server.children(TARGET),
			},
		).toStrictEqual(
			{
				id: ID1,
				pushTypes: [["bulk_create"], ["bulk_create", "bulk_create", "edit"]],
				targetChildren: [ID2],
			},
		);
	});

	it("creates backlinks for a restored node that links to a target", async () =>
	{
		const {adapter, pushes, server} = await tracked(
			[[TARGET, node("target", ROOT)]],
			[[SOURCE, node(`see ${link(TARGET)}`, ROOT)]],
		);

		await adapter.restore(
			{
				id: SOURCE,
				parentId: "home",
				index: 1,
			},
		);

		expect(
			{
				pushTypes: pushes.map((ops) => ops.map((op) => op.type)),
				targetChildren: server.children(TARGET),
			},
		).toStrictEqual(
			{
				pushTypes: [["undelete"], ["bulk_create", "bulk_create", "edit"]],
				targetChildren: [ID1],
			},
		);
	});

	it("deletes the backlink items of every deleted linked source in a subtree in one push, keeping other sources' items", async () =>
	{
		const backlinkItem = (sourceId: string) =>
			node(
				"",
				OLD_ROOT,
				{
					mirror:
					{
						originalId: sourceId,
						isMirrorRoot: true,
					},
					backlink:
					{
						sourceID: sourceId,
						targetID: TARGET,
					},
				},
			);
		const {api, adapter, pushes, server, db, rows, cacheService} = await tracked([
			[
				SOURCE,
				node(
					`see ${link(TARGET)}`,
					ROOT,
					{
						mirror:
						{
							backlinkMirrorRootIds:
							{
								[OLD_ITEM]: true,
							},
						},
					},
				),
			],
			[
				CHILD,
				node(
					"child",
					SOURCE,
					{
						mirror:
						{
							backlinkMirrorRootIds:
							{
								[CHILD_ITEM]: true,
							},
						},
					},
					link(TARGET),
				),
			],
			[
				OTHER,
				node(
					`also ${link(TARGET)}`,
					ROOT,
					{
						mirror:
						{
							backlinkMirrorRootIds:
							{
								[OTHER_ITEM]: true,
							},
						},
					},
				),
			],
			[TARGET, node("target", ROOT)],
			[
				OLD_ROOT,
				node(
					"",
					TARGET,
					{
						isReferencesRoot: true,
					},
				),
			],
			[OLD_ITEM, backlinkItem(SOURCE)],
			[CHILD_ITEM, backlinkItem(CHILD)],
			[OTHER_ITEM, backlinkItem(OTHER)],
		]);
		const linked = linkedSourcesInSubtree(db, SOURCE);
		// The write-through delete removes the subtree upstream and from the cache.
		server.apply(
			"delete",
			{
				projectid: CHILD,
			},
		);
		server.apply(
			"delete",
			{
				projectid: SOURCE,
			},
		);
		cacheService.deleteNode(SOURCE);

		const deleted = await adapter.deleteBacklinksOf(linked);

		expect(
			{
				linked,
				deleted,
				pushes: pushes.map((ops) => ops.map((op) => [op.type, op.data.projectid])),
				referencesChildren: server.children(OLD_ROOT),
				current: rows(`SELECT node_id FROM ${BACKLINKS} ORDER BY node_id`),
				treeDataReads: treeDataReads(api),
			},
		).toStrictEqual(
			{
				linked:
				{
					ids: [SOURCE, CHILD],
					mirrors: [
						{
							originalId: SOURCE,
							mirrorId: OLD_ITEM,
						},
						{
							originalId: CHILD,
							mirrorId: CHILD_ITEM,
						},
					],
				},
				deleted: [OLD_ITEM, CHILD_ITEM],
				pushes: [
					[
						["delete", OLD_ITEM],
						["delete", CHILD_ITEM],
					],
				],
				referencesChildren: [OTHER_ITEM],
				current: [
					{
						node_id: OTHER_ITEM,
					},
				],
				treeDataReads: 0,
			},
		);
	});

	it("writes no references root, backlink or mirror row when the push is rejected", async () =>
	{
		const {api, adapter, rows} = await tracked([
			[SOURCE, node(`see ${link(TARGET)}`, ROOT)],
			[TARGET, node("target", ROOT)],
		]);
		api.respond("/push_and_poll", () =>
			json(
				{
					results: [
						{
							new_most_recent_operation_transaction_id: "4568",
							error: "bad op",
						},
					],
				},
			),
		);

		await expect(adapter.syncBacklinks([SOURCE])).rejects.toBeInstanceOf(OperationRejected);

		expect(
			rows("SELECT node_id AS id FROM references_roots UNION ALL SELECT mirror_id FROM mirrors"),
		).toStrictEqual([]);
	});

	it("reads the whole account tree zero times for syncBacklinks", async () =>
	{
		const {api, adapter} = await tracked([
			[SOURCE, node(`see ${link(TARGET)}`, ROOT)],
			[TARGET, node("target", ROOT)],
		]);

		await adapter.syncBacklinks([SOURCE]);

		expect(treeDataReads(api)).toBe(0);
	});

	it("skips a deleted source's backlink item that is already gone upstream, reading the whole account tree zero times", async () =>
	{
		const {api, adapter, pushes, server, cacheService} = await tracked([
			[
				SOURCE,
				node(
					`see ${link(TARGET)}`,
					ROOT,
					{
						mirror:
						{
							backlinkMirrorRootIds:
							{
								[OLD_ITEM]: true,
							},
						},
					},
				),
			],
			[TARGET, node("target", ROOT)],
			[
				OLD_ROOT,
				node(
					"",
					TARGET,
					{
						isReferencesRoot: true,
					},
				),
			],
			[
				OLD_ITEM,
				node(
					"",
					OLD_ROOT,
					{
						backlink:
						{
							sourceID: SOURCE,
							targetID: TARGET,
						},
					},
				),
			],
		]);
		server.apply(
			"delete",
			{
				projectid: OLD_ITEM,
			},
		);
		server.apply(
			"delete",
			{
				projectid: SOURCE,
			},
		);
		cacheService.deleteNode(SOURCE);

		const deleted = await adapter.deleteBacklinksOf(
			{
				ids: [SOURCE],
				mirrors: [],
			},
		);

		expect(
			{
				deleted,
				pushes,
				treeDataReads: treeDataReads(api),
			},
		).toStrictEqual(
			{
				deleted: [],
				pushes: [],
				treeDataReads: 0,
			},
		);
	});

	it("deletes a deleted source's backlink item known only through a mirrors row the cache delete ended", async () =>
	{
		const {api, adapter, pushes, server, db, cacheService} = await tracked([
			[
				SOURCE,
				node(
					`see ${link(TARGET)}`,
					ROOT,
					{
						mirror:
						{
							backlinkMirrorRootIds:
							{
								[OLD_ITEM]: true,
							},
						},
					},
				),
			],
			[TARGET, node("target", ROOT)],
			[
				OLD_ROOT,
				node(
					"",
					TARGET,
					{
						isReferencesRoot: true,
					},
				),
			],
			[
				OLD_ITEM,
				node(
					"",
					OLD_ROOT,
					{
						mirror:
						{
							originalId: SOURCE,
							isMirrorRoot: true,
						},
					},
				),
			],
			[OTHER, node("unrelated", ROOT)],
		]);
		const linked = linkedSourcesInSubtree(db, SOURCE);
		server.apply(
			"delete",
			{
				projectid: SOURCE,
			},
		);
		cacheService.deleteNode(SOURCE);

		const deleted = await adapter.deleteBacklinksOf(linked);

		expect(
			{
				linked,
				deleted,
				pushes: pushes.map((ops) => ops.map((op) => [op.type, op.data.projectid])),
				referencesChildren: server.children(OLD_ROOT),
				treeDataReads: treeDataReads(api),
			},
		).toStrictEqual(
			{
				linked:
				{
					ids: [SOURCE],
					mirrors: [
						{
							originalId: SOURCE,
							mirrorId: OLD_ITEM,
						},
					],
				},
				deleted: [OLD_ITEM],
				pushes: [[["delete", OLD_ITEM]]],
				referencesChildren: [],
				treeDataReads: 0,
			},
		);
	});

	it("deletes the backlink items of a deleted source whose text no longer links, leaving no stranded rows", async () =>
	{
		const {adapter, pushes, server, db, cacheService} = await tracked([
			[
				SOURCE,
				node(
					"link removed",
					ROOT,
					{
						mirror:
						{
							backlinkMirrorRootIds:
							{
								[OLD_ITEM]: true,
							},
						},
					},
				),
			],
			[TARGET, node("target", ROOT)],
			[
				OLD_ROOT,
				node(
					"",
					TARGET,
					{
						isReferencesRoot: true,
					},
				),
			],
			[
				OLD_ITEM,
				node(
					"",
					OLD_ROOT,
					{
						mirror:
						{
							originalId: SOURCE,
							isMirrorRoot: true,
						},
						backlink:
						{
							sourceID: SOURCE,
							targetID: TARGET,
						},
					},
				),
			],
		]);
		const linked = linkedSourcesInSubtree(db, SOURCE);
		server.apply(
			"delete",
			{
				projectid: SOURCE,
			},
		);
		cacheService.deleteNode(SOURCE);

		const deleted = await adapter.deleteBacklinksOf(linked);

		expect(
			{
				linked,
				deleted,
				pushes: pushes.map((ops) => ops.map((op) => [op.type, op.data.projectid])),
				referencesChildren: server.children(OLD_ROOT),
				stranded: countStrandedRows(db),
			},
		).toStrictEqual(
			{
				linked:
				{
					ids: [SOURCE],
					mirrors: [
						{
							originalId: SOURCE,
							mirrorId: OLD_ITEM,
						},
					],
				},
				deleted: [OLD_ITEM],
				pushes: [[["delete", OLD_ITEM]]],
				referencesChildren: [],
				stranded:
				{
					backlinkItems: 0,
					mirrors: 0,
					referencesRoots: 0,
				},
			},
		);
	});

	it("keeps the backlink items of a source promoted out of the deleted subtree into its mirror's slot", async () =>
	{
		const DELETED = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
		const MIRROR = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
		const {api, adapter, pushes, server, db, rows, cacheService} = await tracked([
			[DELETED, node("deleted", ROOT)],
			[
				SOURCE,
				node(
					`see ${link(TARGET)}`,
					DELETED,
					{
						mirror:
						{
							mirrorRootIds:
							{
								[MIRROR]: true,
							},
							backlinkMirrorRootIds:
							{
								[OLD_ITEM]: true,
							},
						},
					},
				),
			],
			[
				MIRROR,
				node(
					`see ${link(TARGET)}`,
					ROOT,
					{
						mirror:
						{
							originalId: SOURCE,
							isMirrorRoot: true,
						},
					},
				),
			],
			[TARGET, node("target", ROOT)],
			[
				OLD_ROOT,
				node(
					"",
					TARGET,
					{
						isReferencesRoot: true,
					},
				),
			],
			[
				OLD_ITEM,
				node(
					"",
					OLD_ROOT,
					{
						mirror:
						{
							originalId: SOURCE,
							isMirrorRoot: true,
						},
						backlink:
						{
							sourceID: SOURCE,
							targetID: TARGET,
						},
					},
				),
			],
		]);
		const linked = linkedSourcesInSubtree(db, DELETED);
		// The write-through delete promotes SOURCE into its mirror's slot, then deletes the rest of the subtree.
		server.apply(
			"delete",
			{
				projectid: MIRROR,
			},
		);
		cacheService.promoteOriginal(
			MIRROR,
			{
				id: SOURCE,
				name: `see ${link(TARGET)}`,
				note: null,
				parent_id: null,
				priority: 0,
				completed: false,
				createdAt: 0,
				modifiedAt: 0,
				completedAt: null,
			},
			null,
		);
		server.apply(
			"delete",
			{
				projectid: DELETED,
			},
		);
		cacheService.deleteNode(DELETED);

		const deleted = await adapter.deleteBacklinksOf(linked);

		expect(
			{
				linked,
				deleted,
				pushes,
				referencesChildren: server.children(OLD_ROOT),
				current: rows(`SELECT node_id FROM ${BACKLINKS} ORDER BY node_id`),
				treeDataReads: treeDataReads(api),
			},
		).toStrictEqual(
			{
				linked:
				{
					ids: [SOURCE],
					mirrors: [
						{
							originalId: SOURCE,
							mirrorId: OLD_ITEM,
						},
						{
							originalId: SOURCE,
							mirrorId: MIRROR,
						},
					],
				},
				deleted: [],
				pushes: [],
				referencesChildren: [OLD_ITEM],
				current: [
					{
						node_id: OLD_ITEM,
					},
				],
				treeDataReads: 0,
			},
		);
	});

	it("pushes nothing when the linked sources are still in the tree, as when a mirror was removed instead", async () =>
	{
		const {adapter, pushes} = await tracked([
			[
				SOURCE,
				node(
					`see ${link(TARGET)}`,
					ROOT,
					{
						mirror:
						{
							backlinkMirrorRootIds:
							{
								[OLD_ITEM]: true,
							},
						},
					},
				),
			],
			[TARGET, node("target", ROOT)],
			[
				OLD_ROOT,
				node(
					"",
					TARGET,
					{
						isReferencesRoot: true,
					},
				),
			],
			[
				OLD_ITEM,
				node(
					"",
					OLD_ROOT,
					{
						mirror:
						{
							originalId: SOURCE,
							isMirrorRoot: true,
						},
						backlink:
						{
							sourceID: SOURCE,
							targetID: TARGET,
						},
					},
				),
			],
		]);

		const deleted = await adapter.deleteBacklinksOf(
			{
				ids: [SOURCE],
				mirrors: [],
			},
		);

		expect(
			{
				deleted,
				pushes,
			},
		).toStrictEqual(
			{
				deleted: [],
				pushes: [],
			},
		);
	});
});
