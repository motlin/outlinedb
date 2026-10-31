import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {join} from "node:path";
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {z} from "zod";
import {WorkflowyApiClient} from "../src/api/workflowy-client.js";
import {WorkflowyInternalClient} from "../src/api/workflowy-internal-client.js";
import {CacheService} from "../src/cache/cache-service.js";
import {currentBacklinkItems, emptyItemRelationships} from "../src/cache/item-relationships.js";
import {WorkflowyWriteThroughClient} from "../src/cache/workflowy-write-through-client.js";
import {readInternalMetadata} from "../src/cache/internal-metadata.js";
import {storeTreeTxId} from "../src/cache/tree-transaction.js";
import * as schema from "../src/db/schema.js";
import {WorkflowyInternalAdapter} from "../src/internal/adapter.js";
import {OperationRejected} from "../src/internal/errors.js";
import {createFakeInternalApi, forbidTreeData, json, treeDataReads} from "./helpers/fake-internal-api.js";
import type {RecordedRequest} from "./helpers/fake-internal-api.js";

const migrationsFolder = join(import.meta.dirname, "../src/db/migrations");
const START_MS = 1_800_000_000_000;
/** The fake server's key for Home's children, matching upstream's root project id. */
const ROOT = "None";

const PushDataSchema = z.array(
	z.object({
		operations: z.array(z.object({type: z.string(), data: z.record(z.string(), z.unknown())}).loose()).optional(),
	}),
);
const OpDataSchema = z.object({
	projectid: z.string().optional(),
	parentid: z.string().optional(),
	priority: z.number().optional(),
	starting_priority: z.number().optional(),
	project_trees: z.string().optional(),
	projectids_json: z.string().optional(),
});
interface PushedTree {
	id: string;
	nm: string;
	ch?: PushedTree[] | undefined;
}
const TreeSchema: z.ZodType<PushedTree> = z.lazy(() =>
	z.object({id: z.string(), nm: z.string(), ch: z.array(TreeSchema).optional()}).loose(),
);
const TreesSchema = z.array(TreeSchema);
const IdsSchema = z.array(z.string());

interface ServerNode {
	name: string;
	parent: string;
}

/**
 * One server state behind both fakes: the internal `/push_and_poll` applies
 * ops to it, and the public `/api/v1/nodes*` reads it. Home holds `a,b,c`;
 * `a` holds `x`; `gone` was deleted from slot 1 of Home with its child `kid`
 * and grandchild `grandkid`, which come back with it.
 */
function createServer() {
	const nodes = new Map<string, ServerNode>([
		["a", {name: "a", parent: ROOT}],
		["b", {name: "b", parent: ROOT}],
		["c", {name: "c", parent: ROOT}],
		["x", {name: "x", parent: "a"}],
	]);
	const order = new Map<string, string[]>([
		[ROOT, ["a", "b", "c"]],
		["a", ["x"]],
	]);
	const trash = new Map<string, {node: ServerNode; index: number; descendants: [string, ServerNode][]}>([
		[
			"gone",
			{
				node: {name: "gone", parent: ROOT},
				index: 1,
				descendants: [
					["kid", {name: "kid", parent: "gone"}],
					["grandkid", {name: "grandkid", parent: "kid"}],
				],
			},
		],
	]);
	const bringBackDescendants = (deleted: {descendants: [string, ServerNode][]} | undefined) => {
		for (const [id, node] of deleted?.descendants ?? []) {
			nodes.set(id, node);
			order.set(node.parent, [...children(node.parent), id]);
		}
	};
	const children = (parent: string) => order.get(parent) ?? [];
	const insert = (parent: string, index: number, ids: string[]) => {
		const list = [...children(parent)];
		list.splice(Math.min(index, list.length), 0, ...ids);
		order.set(parent, list);
	};
	const detach = (id: string) => {
		const node = nodes.get(id);
		if (node) {
			order.set(
				node.parent,
				children(node.parent).filter((child) => child !== id),
			);
		}
	};
	const place = (id: string, parent: string) => {
		const node = nodes.get(id) ?? {name: id, parent};
		nodes.set(id, {...node, parent});
	};

	function apply(type: string, rawData: Record<string, unknown>): void {
		const data = OpDataSchema.parse(rawData);
		const parent = data.parentid ?? ROOT;
		if (type === "bulk_create") {
			const trees = TreesSchema.parse(JSON.parse(data.project_trees ?? "[]"));
			const createUnder = (under: string, subtrees: PushedTree[]) => {
				for (const tree of subtrees) {
					nodes.set(tree.id, {name: tree.nm, parent: under});
					createUnder(tree.id, tree.ch ?? []);
					order.set(
						tree.id,
						(tree.ch ?? []).map((child) => child.id),
					);
				}
			};
			createUnder(parent, trees);
			insert(
				parent,
				data.starting_priority ?? 0,
				trees.map((tree) => tree.id),
			);
		} else if (type === "move" && data.projectid !== undefined) {
			detach(data.projectid);
			place(data.projectid, parent);
			insert(parent, data.priority ?? 0, [data.projectid]);
		} else if (type === "bulk_move") {
			const ids = IdsSchema.parse(JSON.parse(data.projectids_json ?? "[]"));
			for (const id of ids) {
				detach(id);
				place(id, parent);
			}
			insert(parent, data.priority ?? 0, ids);
		} else if (type === "undelete" && data.projectid !== undefined) {
			const deleted = trash.get(data.projectid);
			trash.delete(data.projectid);
			nodes.set(data.projectid, {name: deleted?.node.name ?? data.projectid, parent});
			insert(parent, data.priority ?? 0, [data.projectid]);
			bringBackDescendants(deleted);
		}
	}

	function restoreFromTrash(id: string): boolean {
		const deleted = trash.get(id);
		if (!deleted) {
			return false;
		}
		trash.delete(id);
		nodes.set(id, deleted.node);
		insert(deleted.node.parent, deleted.index, [id]);
		bringBackDescendants(deleted);
		return true;
	}

	function toApi(id: string) {
		const node = nodes.get(id);
		if (!node) {
			throw new Error(`no node ${id}`);
		}
		return {
			id,
			name: node.name,
			note: null,
			parent_id: node.parent === ROOT ? null : node.parent,
			priority: children(node.parent).indexOf(id) * 100,
			completed: false,
			createdAt: 0,
			modifiedAt: 0,
			completedAt: null,
		};
	}

	function publicFetch(url: string): Response {
		const path = url.replace("https://workflowy.test/api/v1", "");
		if (path === "/nodes" || path.startsWith("/nodes?")) {
			const parent = new URLSearchParams(path.split("?")[1] ?? "").get("parent_id") ?? ROOT;
			return Response.json({nodes: children(parent).map(toApi)});
		}
		const id = path.split("/")[2] ?? "";
		if (!nodes.has(id)) {
			return Response.json({error: "not found"}, {status: 404});
		}
		return Response.json({node: toApi(id)});
	}

	return {apply, restoreFromTrash, publicFetch};
}

const SERVER_RUN = JSON.stringify({ops: [], client_timestamp: 300_000_000});

function pushedOps(request: RecordedRequest): {type: string; data: Record<string, unknown>}[] {
	const fields = new URLSearchParams(request.body ?? "");
	const trees = PushDataSchema.parse(JSON.parse(fields.get("push_poll_data") ?? "[]"));
	return trees.flatMap((tree) => tree.operations ?? []);
}

function setup(generateId: () => string = () => "new") {
	const sqlite = new DatabaseConstructor(":memory:");
	const db = drizzle(sqlite, {schema});
	migrate(db, {migrationsFolder});
	// A whole-tree import seeded the transaction-log position at the fake init's id.
	storeTreeTxId(db, "4567");
	const server = createServer();
	const publicCalls: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			publicCalls.push(`${init?.method ?? "GET"} ${url.replace("https://workflowy.test/api/v1", "")}`);
			return Promise.resolve(server.publicFetch(url));
		}),
	);
	const api = createFakeInternalApi();
	const pushes: {type: string; data: Record<string, unknown>}[][] = [];
	api.respond("/push_and_poll", (request) => {
		const ops = pushedOps(request);
		if (ops.length > 0) {
			pushes.push(ops);
		}
		for (const op of ops) {
			server.apply(op.type, op.data);
		}
		return json({
			results: [
				{
					new_most_recent_operation_transaction_id: "4568",
					server_run_operation_transaction_json: SERVER_RUN,
					concurrent_remote_operation_transactions: [],
				},
			],
		});
	});
	const restores: string[] = [];
	const internalFetch: typeof fetch = async (input, init) => {
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		const match = /^\/trash\/restore\/([^/]+)\/$/u.exec(url.pathname);
		if (match?.[1] !== undefined && init?.method === "POST") {
			restores.push(match[1]);
			return Promise.resolve(json({succeeded: server.restoreFromTrash(match[1])}));
		}
		return api.fetch(input, init);
	};
	const client = new WorkflowyInternalClient({
		credentials: {username: "alice@example.com", password: "hunter2"},
		fetch: internalFetch,
		baseUrl: "https://workflowy.test",
		transientId: "6f1c1d1e-0000-4000-8000-000000000001",
	});
	const apiClient = new WorkflowyApiClient("test-key", undefined, "https://workflowy.test", {
		maxRetries: 0,
		baseDelayMs: 0,
		maxDelayMs: 0,
	});
	const cacheService = new CacheService(db);
	const writeThrough = new WorkflowyWriteThroughClient(apiClient, cacheService);
	const adapter = new WorkflowyInternalAdapter({
		client,
		db,
		writeThrough,
		now: () => START_MS,
		generateId,
		pushAndPoll: {randomId: () => "pollid01", timezone: "America/New_York", sleep: async () => {}},
	});
	const order = (parentId: string | null) => cacheService.getChildren(parentId).map((node) => node.id);
	return {sqlite, api, adapter, writeThrough, cacheService, pushes, restores, publicCalls, order};
}

describe("WorkflowyInternalAdapter tree writes", () => {
	let open: DatabaseConstructor.Database[] = [];
	afterEach(() => {
		for (const sqlite of open) {
			sqlite.close();
		}
		open = [];
		vi.unstubAllGlobals();
	});
	async function tracked(generateId?: () => string) {
		const result = setup(generateId);
		open.push(result.sqlite);
		await result.writeThrough.refreshChildren([null, "a"]);
		return result;
	}

	it("creates at an exact index with one bulk_create carrying the client-chosen id, then refreshes Home's order", async () => {
		const {adapter, pushes, order} = await tracked();

		await expect(adapter.createAt({parentId: "home", index: 1, name: ""})).resolves.toStrictEqual({id: "new"});

		expect(pushes).toStrictEqual([
			[
				{
					type: "bulk_create",
					data: {
						parentid: "None",
						starting_priority: 1,
						project_trees: JSON.stringify([{id: "new", nm: "", ct: 300_000_000, cb: 123, ch: []}]),
						isForSearch: false,
					},
					client_timestamp: 300_000_000,
					undo_data: {},
				},
			],
		]);
		expect(order(null)).toStrictEqual(["a", "new", "b", "c"]);
	});

	it("creates an omitted index after the live last child, not the stale cached count", async () => {
		const {adapter, pushes, cacheService} = await tracked();
		cacheService.deleteNode("c");

		await adapter.createAt({parentId: "home", name: "x"});

		expect(
			pushes.map((ops) => ops.map((op) => [op.type, OpDataSchema.parse(op.data).starting_priority])),
		).toStrictEqual([[["bulk_create", 3]]]);
	});

	it("moves an omitted index to the live bottom, not the stale cached count", async () => {
		const {adapter, pushes, cacheService} = await tracked();
		cacheService.deleteNode("c");

		await adapter.moveTo({ids: ["a"], parentId: "home"});

		expect(pushes.map((ops) => ops.map((op) => [op.type, op.data]))).toStrictEqual([
			[["move", {projectid: "a", parentid: "None", priority: 2}]],
		]);
	});

	it.each([
		{afterId: "b", index: 0, expected: ["a", "b", "new", "c"]},
		{afterId: null, index: 2, expected: ["new", "a", "b", "c"]},
		{afterId: "gone", index: 1, expected: ["a", "new", "b", "c"]},
	])("creates below the live sibling $afterId over the stale index $index", async ({afterId, index, expected}) => {
		const {adapter, order} = await tracked();

		await adapter.createAt({parentId: "home", index, afterId, name: ""});

		expect(order(null)).toStrictEqual(expected);
	});

	it("clamps a create index past the end to the fresh sibling count", async () => {
		const {adapter, pushes, order} = await tracked();

		await adapter.createAt({parentId: "a", index: 9, name: "y", note: "n", metadata: {layoutMode: "board"}});

		expect(pushes.map((ops) => ops.map((op) => op.data))).toStrictEqual([
			[
				{
					parentid: "a",
					starting_priority: 1,
					project_trees: JSON.stringify([
						{
							id: "new",
							nm: "y",
							no: "n",
							metadata: {layoutMode: "board"},
							ct: 300_000_000,
							cb: 123,
							ch: [],
						},
					]),
					isForSearch: false,
				},
			],
		]);
		expect(order("a")).toStrictEqual(["x", "new"]);
	});

	it("creates with a caller-chosen id and caches the kept part of its metadata", async () => {
		const {adapter, pushes, order, sqlite} = await tracked();
		const calendar = {level: "day", value: "17", timestamp: 1, dateId: 20_261_017};

		await expect(
			adapter.createAt({
				parentId: "a",
				index: 0,
				id: "day-id",
				name: "d",
				metadata: {restorableUniqueNode: true, calendar},
			}),
		).resolves.toStrictEqual({id: "day-id"});

		expect({
			trees: pushes.map((ops) => ops.map((op) => JSON.parse(String(op.data.project_trees)) as unknown)),
			order: order("a"),
			cached: cachedMetadata(sqlite, ["day-id"]),
		}).toStrictEqual({
			trees: [
				[
					[
						{
							id: "day-id",
							nm: "d",
							metadata: {restorableUniqueNode: true, calendar},
							ct: 300_000_000,
							cb: 123,
							ch: [],
						},
					],
				],
			],
			order: ["day-id", "x"],
			cached: {"day-id": {calendar, restorableUniqueNode: true}},
		});
	});

	it("moves one node to the top with one move at priority 0", async () => {
		const {adapter, pushes, order} = await tracked();

		await adapter.moveTo({ids: ["c"], parentId: "home", index: 0});

		expect(pushes.map((ops) => ops.map((op) => [op.type, op.data]))).toStrictEqual([
			[["move", {projectid: "c", parentid: "None", priority: 0}]],
		]);
		expect(order(null)).toStrictEqual(["c", "a", "b"]);
	});

	it("moves a node down within its parent with the post-removal priority", async () => {
		const {adapter, pushes, order} = await tracked();

		await adapter.moveTo({ids: ["a"], parentId: "home", index: 3});

		expect(pushes.map((ops) => ops.map((op) => [op.type, op.data]))).toStrictEqual([
			[["move", {projectid: "a", parentid: "None", priority: 2}]],
		]);
		expect(order(null)).toStrictEqual(["b", "c", "a"]);
	});

	it("moves several nodes with one bulk_move and refreshes both parents", async () => {
		const {adapter, pushes, order} = await tracked();

		await adapter.moveTo({ids: ["b", "c"], parentId: "x", index: 0});

		expect(pushes.map((ops) => ops.map((op) => [op.type, op.data]))).toStrictEqual([
			[["bulk_move", {projectids_json: JSON.stringify(["b", "c"]), parentid: "x", priority: 0}]],
		]);
		expect({home: order(null), x: order("x")}).toStrictEqual({home: ["a"], x: ["b", "c"]});
	});

	it("moves several blocks in one push, planning each against the outline the earlier ones leave", async () => {
		const {adapter, pushes, order} = await tracked();

		await adapter.moveBlocks([
			{ids: ["c"], parentId: "home", index: 0},
			{ids: ["a"], parentId: "home", index: 3},
			{ids: ["b"], parentId: "x"},
		]);

		expect(pushes.map((ops) => ops.map((op) => [op.type, op.data]))).toStrictEqual([
			[
				["move", {projectid: "c", parentid: "None", priority: 0}],
				["move", {projectid: "a", parentid: "None", priority: 2}],
				["move", {projectid: "b", parentid: "x", priority: 0}],
			],
		]);
		expect({home: order(null), x: order("x")}).toStrictEqual({home: ["c", "a"], x: ["b"]});
	});

	it("restores into a given slot with one undelete", async () => {
		const {adapter, pushes, restores, order} = await tracked();

		await adapter.restore({id: "gone", parentId: "home", index: 0});

		expect({restores, pushes: pushes.map((ops) => ops.map((op) => [op.type, op.data]))}).toStrictEqual({
			restores: [],
			pushes: [[["undelete", {projectid: "gone", parentid: "None", priority: 0}]]],
		});
		expect({home: order(null), gone: order("gone"), kid: order("kid")}).toStrictEqual({
			home: ["gone", "a", "b", "c"],
			gone: ["kid"],
			kid: ["grandkid"],
		});
	});

	it("restores to the original place through /trash/restore when no slot is given", async () => {
		const {adapter, pushes, restores, order} = await tracked();

		await adapter.restore({id: "gone"});

		expect({restores, pushes}).toStrictEqual({restores: ["gone"], pushes: []});
		expect({home: order(null), gone: order("gone"), kid: order("kid")}).toStrictEqual({
			home: ["a", "gone", "b", "c"],
			gone: ["kid"],
			kid: ["grandkid"],
		});
	});

	it("sets node metadata with one edit, and maps home to None", async () => {
		const {adapter, pushes} = await tracked();

		await adapter.setNodeMeta("a", ["layoutMode"], "board");
		await adapter.setNodeMeta("home", ["layoutMode"], "board");

		expect(pushes.map((ops) => ops.map((op) => [op.type, op.data]))).toStrictEqual([
			[
				[
					"edit",
					{
						projectid: "a",
						metadataPatches: [{op: "add", path: ["layoutMode"], value: "board"}],
						metadataInversePatches: [{op: "remove", path: ["layoutMode"]}],
					},
				],
			],
			[
				[
					"edit",
					{
						projectid: "None",
						metadataPatches: [{op: "add", path: ["layoutMode"], value: "board"}],
						metadataInversePatches: [{op: "remove", path: ["layoutMode"]}],
					},
				],
			],
		]);
	});

	it("sets several node metadata values with one edit and caches the kept ones", async () => {
		const {adapter, pushes, sqlite} = await tracked();

		await adapter.setNodeMetaValues("a", [
			{path: ["layoutMode"], value: "numbered"},
			{path: ["numbered_start"], value: 5},
		]);

		expect({
			pushes: pushes.map((ops) => ops.map((op) => [op.type, op.data])),
			cached: cachedMetadata(sqlite, ["a"]),
		}).toStrictEqual({
			pushes: [
				[
					[
						"edit",
						{
							projectid: "a",
							metadataPatches: [
								{op: "add", path: ["layoutMode"], value: "numbered"},
								{op: "add", path: ["numbered_start"], value: 5},
							],
							metadataInversePatches: [
								{op: "remove", path: ["numbered_start"]},
								{op: "remove", path: ["layoutMode"]},
							],
						},
					],
				],
			],
			cached: {a: {numbered_start: 5, layoutMode: "numbered"}},
		});
	});

	it("sends home's metadata values to the root as one edit", async () => {
		const {adapter, pushes} = await tracked();

		await adapter.setNodeMetaValues("home", [{path: ["layoutMode"], value: "board"}]);

		expect(pushes.map((ops) => ops.map((op) => [op.type, op.data]))).toStrictEqual([
			[
				[
					"edit",
					{
						projectid: "None",
						metadataPatches: [{op: "add", path: ["layoutMode"], value: "board"}],
						metadataInversePatches: [{op: "remove", path: ["layoutMode"]}],
					},
				],
			],
		]);
	});

	it("patches the cached internal metadata after each accepted node metadata edit", async () => {
		const {adapter, sqlite} = await tracked();
		const display = () =>
			sqlite
				.prepare(
					"SELECT numbered_start, priority_default_to_bottom, system_to FROM node_display_metadata WHERE node_id = 'a' ORDER BY system_from",
				)
				.all()
				.map((row) => ({
					...z.record(z.string(), z.unknown()).parse(row),
					system_to: Reflect.get(Object(row), "system_to") === "9999-12-31 23:59:59" ? "live" : "closed",
				}));

		await adapter.setNodeMeta("a", ["numbered_start"], 5);
		await adapter.setNodeMeta("a", ["priority", "defaultToBottom"], true);
		const afterSet = cachedMetadata(sqlite, ["a"]);
		await adapter.setNodeMeta("a", ["numbered_start"], undefined);
		await adapter.setNodeMeta("a", ["priority", "defaultToBottom"], undefined);

		expect({afterSet, afterRemove: cachedMetadata(sqlite, ["a"]), versions: display()}).toStrictEqual({
			afterSet: {a: {numbered_start: 5, priority: {defaultToBottom: true}}},
			afterRemove: {},
			versions: [
				{numbered_start: 5, priority_default_to_bottom: null, system_to: "closed"},
				{numbered_start: 5, priority_default_to_bottom: 1, system_to: "closed"},
				{numbered_start: null, priority_default_to_bottom: 1, system_to: "closed"},
			],
		});
	});

	it("leaves the cache untouched and reads nothing back when the push is rejected", async () => {
		const {api, adapter, order, publicCalls} = await tracked();
		api.respond("/push_and_poll", () =>
			json({results: [{new_most_recent_operation_transaction_id: "4568", error: "bad op"}]}),
		);
		const callsBefore = publicCalls.length;

		await expect(adapter.moveTo({ids: ["c"], parentId: "home", index: 0})).rejects.toBeInstanceOf(
			OperationRejected,
		);

		expect(order(null)).toStrictEqual(["a", "b", "c"]);
		expect(publicCalls.slice(callsBefore)).toStrictEqual(["GET /nodes/c", "GET /nodes"]);
	});

	function serveTreeData(api: ReturnType<typeof setup>["api"], items: {id: string; metadata?: unknown}[]): void {
		api.respond("/get_tree_data/", () =>
			json({
				items,
				shared_projects: {},
				most_recent_operation_transaction_id: "9999",
				server_expanded_projects_list: [],
			}),
		);
	}

	/** The kept metadata stored for `ids`, keyed by id; ids with none are absent. */
	function cachedMetadata(sqlite: DatabaseConstructor.Database, ids: string[]): Record<string, unknown> {
		return Object.fromEntries(readInternalMetadata(drizzle(sqlite, {schema}), ids));
	}

	function mirrorRows(sqlite: DatabaseConstructor.Database): unknown[] {
		return sqlite.prepare("SELECT original_id, mirror_id FROM mirrors ORDER BY mirror_id").all();
	}

	/** Seed `mirrors` edge rows (mirror id to original id), as a whole-tree import would have. */
	function seedMirrors(cacheService: CacheService, rows: Record<string, string>): void {
		cacheService.recordRelationships({
			...emptyItemRelationships(),
			mirrors: Object.entries(rows).map(([mirrorId, originalId]) => ({mirrorId, originalId})),
		});
	}

	it("mirrors a node at Home with one push: a bulk_create of an empty mirror root, then a leaf edit adding it to the original's mirrorRootIds, with no tree read", async () => {
		const {api, adapter, pushes, order, sqlite, cacheService} = await tracked();
		seedMirrors(cacheService, {old: "b"});
		forbidTreeData(api);

		const result = await adapter.createMirrorAt({originalId: "b", parentId: "home", index: 0});

		expect({
			result,
			pushes: pushes.map((ops) => ops.map((op) => [op.type, op.data])),
			order: order(null),
			mirrors: mirrorRows(sqlite),
			reads: treeDataReads(api),
		}).toStrictEqual({
			result: {mirrorId: "new", originId: "b"},
			pushes: [
				[
					[
						"bulk_create",
						{
							parentid: "None",
							starting_priority: 0,
							project_trees: JSON.stringify([
								{
									id: "new",
									nm: "",
									metadata: {mirror: {originalId: "b", isMirrorRoot: true}},
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
							projectid: "b",
							metadataPatches: [{op: "add", path: ["mirror", "mirrorRootIds", "new"], value: true}],
							metadataInversePatches: [{op: "remove", path: ["mirror", "mirrorRootIds", "new"]}],
						},
					],
				],
			],
			order: ["new", "a", "b", "c"],
			mirrors: [
				{original_id: "b", mirror_id: "new"},
				{original_id: "b", mirror_id: "old"},
			],
			reads: 0,
		});
	});

	it("catches up before deciding: a mirror added upstream since the import makes the edit a leaf add that keeps it", async () => {
		const {api, adapter, pushes, sqlite} = await tracked();
		forbidTreeData(api);
		api.respondOnce("/push_and_poll", () =>
			json({
				results: [
					{
						new_most_recent_operation_transaction_id: "4568",
						concurrent_remote_operation_transactions: [
							JSON.stringify({
								id: 4568,
								client_timestamp: 300_000_000,
								ops: [
									{
										type: "edit",
										data: {
											projectid: "b",
											metadataPatches: [
												{op: "add", path: ["mirror", "mirrorRootIds", "other"], value: true},
											],
										},
									},
								],
							}),
						],
					},
				],
			}),
		);

		await adapter.createMirrorAt({originalId: "b", parentId: "home", index: 0});

		expect({
			edits: pushes.flatMap((ops) => ops.filter((op) => op.type === "edit").map((op) => op.data)),
			mirrors: mirrorRows(sqlite),
			reads: treeDataReads(api),
		}).toStrictEqual({
			edits: [
				{
					projectid: "b",
					metadataPatches: [{op: "add", path: ["mirror", "mirrorRootIds", "new"], value: true}],
					metadataInversePatches: [{op: "remove", path: ["mirror", "mirrorRootIds", "new"]}],
				},
			],
			mirrors: [
				{original_id: "b", mirror_id: "new"},
				{original_id: "b", mirror_id: "other"},
			],
			reads: 0,
		});
	});

	it("mirrors a mirror's original, resolved through the mirrors table", async () => {
		const {api, adapter, pushes, sqlite, cacheService} = await tracked();
		seedMirrors(cacheService, {b: "a"});
		forbidTreeData(api);

		const result = await adapter.createMirrorAt({originalId: "b", parentId: "home", index: 9});

		expect({
			result,
			edits: pushes.flatMap((ops) => ops.filter((op) => op.type === "edit").map((op) => op.data)),
			mirrors: mirrorRows(sqlite),
			reads: treeDataReads(api),
		}).toStrictEqual({
			result: {mirrorId: "new", originId: "a"},
			edits: [
				{
					projectid: "a",
					metadataPatches: [{op: "add", path: ["mirror", "mirrorRootIds", "new"], value: true}],
					metadataInversePatches: [{op: "remove", path: ["mirror", "mirrorRootIds", "new"]}],
				},
			],
			mirrors: [
				{original_id: "a", mirror_id: "b"},
				{original_id: "a", mirror_id: "new"},
			],
			reads: 0,
		});
	});

	it("adds the whole mirror object to an original the edge tables show without one, so an open upstream tab can apply it", async () => {
		const {api, adapter, pushes, order} = await tracked();
		forbidTreeData(api);

		await adapter.createMirrorAt({originalId: "c", parentId: "home", index: 9});

		expect({
			edits: pushes.flatMap((ops) => ops.filter((op) => op.type === "edit").map((op) => op.data)),
			order: order(null),
			reads: treeDataReads(api),
		}).toStrictEqual({
			edits: [
				{
					projectid: "c",
					metadataPatches: [{op: "add", path: ["mirror"], value: {mirrorRootIds: {new: true}}}],
					metadataInversePatches: [{op: "remove", path: ["mirror"]}],
				},
			],
			order: ["a", "b", "c", "new"],
			reads: 0,
		});
	});

	it("refuses to mirror a node that is neither cached nor on Workflowy, pushing nothing", async () => {
		const {api, adapter, pushes, sqlite} = await tracked();
		forbidTreeData(api);

		await expect(adapter.createMirrorAt({originalId: "zzz", parentId: "home", index: 0})).rejects.toThrow(
			"Cannot mirror zzz: it is not in the Workflowy tree",
		);

		expect({pushes, mirrors: mirrorRows(sqlite), reads: treeDataReads(api)}).toStrictEqual({
			pushes: [],
			mirrors: [],
			reads: 0,
		});
	});

	it("mirrors several nodes at consecutive slots with one push: N empty mirror roots and one edit per original", async () => {
		let next = 0;
		const {api, adapter, pushes, order, sqlite, cacheService} = await tracked(() => `m${++next}`);
		seedMirrors(cacheService, {old: "b"});
		forbidTreeData(api);

		const result = await adapter.createMirrorsAt({originalIds: ["b", "a", "b"], parentId: "home", index: 1});

		expect({
			result,
			shape: pushes.map((ops) => ops.map((op) => [op.type, op.data.projectid ?? op.data.starting_priority])),
			edits: pushes.flatMap((ops) => ops.filter((op) => op.type === "edit").map((op) => op.data)),
			order: order(null),
			mirrors: mirrorRows(sqlite),
		}).toStrictEqual({
			result: {
				mirrors: [
					{mirrorId: "m1", originId: "b"},
					{mirrorId: "m2", originId: "a"},
					{mirrorId: "m3", originId: "b"},
				],
			},
			shape: [
				[
					["bulk_create", 1],
					["edit", "b"],
					["edit", "a"],
				],
			],
			edits: [
				{
					projectid: "b",
					metadataPatches: [
						{op: "add", path: ["mirror", "mirrorRootIds", "m1"], value: true},
						{op: "add", path: ["mirror", "mirrorRootIds", "m3"], value: true},
					],
					metadataInversePatches: [
						{op: "remove", path: ["mirror", "mirrorRootIds", "m3"]},
						{op: "remove", path: ["mirror", "mirrorRootIds", "m1"]},
					],
				},
				{
					projectid: "a",
					metadataPatches: [{op: "add", path: ["mirror"], value: {mirrorRootIds: {m2: true}}}],
					metadataInversePatches: [{op: "remove", path: ["mirror"]}],
				},
			],
			order: ["a", "m1", "m2", "m3", "b", "c"],
			mirrors: [
				{original_id: "b", mirror_id: "m1"},
				{original_id: "a", mirror_id: "m2"},
				{original_id: "b", mirror_id: "m3"},
				{original_id: "b", mirror_id: "old"},
			],
		});
	});

	it.each([
		{
			label: "a pasted tree with grandchildren",
			trees: [{name: "p", children: [{name: "c", children: [{name: "g"}]}]}],
			expected: {home: ["t1", "a", "b", "c"], t1: ["t2"], t2: ["t3"], t3: []},
		},
		{
			label: "duplicated trees, each with children",
			trees: [
				{name: "p", children: [{name: "c"}]},
				{name: "q", completed: true, children: [{name: "d", children: [{name: "e"}]}]},
			],
			expected: {home: ["t1", "t3", "a", "b", "c"], t1: ["t2"], t2: [], t3: ["t4"], t4: ["t5"], t5: []},
		},
		{
			label: "a detached mirror copy holding a nested mirror root",
			trees: [
				{
					name: "copy",
					children: [
						{name: "c", children: [{name: "", metadata: {mirror: {originalId: "b", isMirrorRoot: true}}}]},
					],
				},
			],
			expected: {home: ["t1", "a", "b", "c"], t1: ["t2"], t2: ["t3"], t3: []},
		},
	])("caches every level of $label", async ({trees, expected}) => {
		let next = 0;
		const {api, adapter, order} = await tracked(() => `t${++next}`);
		serveTreeData(api, [{id: "a"}, {id: "b"}, {id: "c"}]);

		await adapter.createTreesAt({parentId: "home", index: 0, trees});

		expect(
			Object.fromEntries(Object.keys(expected).map((id) => [id, order(id === "home" ? null : id)])),
		).toStrictEqual(expected);
	});

	it("lists a mirror root created inside a tree on its original in the same push, with no tree read", async () => {
		let next = 0;
		const {api, adapter, pushes, sqlite} = await tracked(() => `t${++next}`);
		forbidTreeData(api);

		await adapter.createTreesAt({
			parentId: "home",
			index: 0,
			trees: [{name: "copy", children: [{name: "", metadata: {mirror: {originalId: "b", isMirrorRoot: true}}}]}],
		});

		expect({
			types: pushes.map((ops) => ops.map((op) => [op.type, op.data.projectid])),
			edits: pushes.flatMap((ops) => ops.filter((op) => op.type === "edit").map((op) => op.data)),
			mirrors: mirrorRows(sqlite),
			reads: treeDataReads(api),
		}).toStrictEqual({
			types: [
				[
					["bulk_create", undefined],
					["edit", "b"],
				],
			],
			edits: [
				{
					projectid: "b",
					metadataPatches: [{op: "add", path: ["mirror"], value: {mirrorRootIds: {t2: true}}}],
					metadataInversePatches: [{op: "remove", path: ["mirror"]}],
				},
			],
			mirrors: [{original_id: "b", mirror_id: "t2"}],
			reads: 0,
		});
	});

	it("catches up before listing a pasted mirror root: an original with a mirror added upstream gets a leaf add that keeps it", async () => {
		let next = 0;
		const {api, adapter, pushes, sqlite} = await tracked(() => `t${++next}`);
		forbidTreeData(api);
		api.respondOnce("/push_and_poll", () =>
			json({
				results: [
					{
						new_most_recent_operation_transaction_id: "4568",
						concurrent_remote_operation_transactions: [
							JSON.stringify({
								id: 4568,
								client_timestamp: 300_000_000,
								ops: [
									{
										type: "edit",
										data: {
											projectid: "b",
											metadataPatches: [
												{op: "add", path: ["mirror", "mirrorRootIds", "other"], value: true},
											],
										},
									},
								],
							}),
						],
					},
				],
			}),
		);

		await adapter.createTreesAt({
			parentId: "home",
			index: 0,
			trees: [{name: "", metadata: {mirror: {originalId: "b", isMirrorRoot: true}}}],
		});

		expect({
			edits: pushes.flatMap((ops) => ops.filter((op) => op.type === "edit").map((op) => op.data)),
			mirrors: mirrorRows(sqlite),
			reads: treeDataReads(api),
		}).toStrictEqual({
			edits: [
				{
					projectid: "b",
					metadataPatches: [{op: "add", path: ["mirror", "mirrorRootIds", "t1"], value: true}],
					metadataInversePatches: [{op: "remove", path: ["mirror", "mirrorRootIds", "t1"]}],
				},
			],
			mirrors: [
				{original_id: "b", mirror_id: "other"},
				{original_id: "b", mirror_id: "t1"},
			],
			reads: 0,
		});
	});

	it("caches the references roots and backlink items a created tree carries as edge rows at one system time", async () => {
		let next = 0;
		const {api, adapter, sqlite} = await tracked(() => `t${++next}`);
		serveTreeData(api, [{id: "a"}, {id: "b"}, {id: "c"}]);

		await adapter.createTreesAt({
			parentId: "home",
			index: 0,
			trees: [
				{
					name: "copy",
					children: [
						{
							name: "",
							metadata: {isReferencesRoot: true},
							children: [
								{
									name: "",
									metadata: {
										mirror: {originalId: "b", isMirrorRoot: true},
										backlink: {sourceID: "b", targetID: "t1"},
									},
								},
							],
						},
					],
				},
			],
		});

		expect({
			mirrors: mirrorRows(sqlite),
			backlinks: currentBacklinkItems(drizzle(sqlite), undefined),
			referencesRoots: sqlite.prepare("SELECT node_id FROM references_roots").all(),
			systemTimes: sqlite
				.prepare(
					"SELECT COUNT(DISTINCT system_from) AS n FROM (SELECT system_from FROM mirrors UNION ALL SELECT system_from FROM references_roots)",
				)
				.get(),
		}).toStrictEqual({
			mirrors: [{original_id: "b", mirror_id: "t3"}],
			backlinks: [{nodeId: "t3", sourceId: "b", targetId: "t1"}],
			referencesRoots: [{node_id: "t2"}],
			systemTimes: {n: 1},
		});
	});

	it.each([
		{
			label: "createTreesAt with a mirror root",
			run: async (adapter: WorkflowyInternalAdapter) =>
				adapter.createTreesAt({
					parentId: "home",
					trees: [{name: "", metadata: {mirror: {originalId: "b", isMirrorRoot: true}}}],
				}),
		},
		{
			label: "createMirrorsAt",
			run: async (adapter: WorkflowyInternalAdapter) =>
				adapter.createMirrorsAt({originalIds: ["b"], parentId: "home", index: 0}),
		},
	])("writes no edge rows when the push for $label is rejected", async ({run}) => {
		const {api, adapter, sqlite, order} = await tracked();
		serveTreeData(api, [{id: "a"}, {id: "b"}, {id: "c"}]);
		api.respond("/push_and_poll", () =>
			json({results: [{new_most_recent_operation_transaction_id: "4568", error: "bad op"}]}),
		);

		await expect(run(adapter)).rejects.toBeInstanceOf(OperationRejected);

		expect({mirrors: mirrorRows(sqlite), order: order(null)}).toStrictEqual({
			mirrors: [],
			order: ["a", "b", "c"],
		});
	});
});
