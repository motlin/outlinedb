import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {Hono} from "hono";
import {join} from "node:path";
import type * as SharedCache from "@outlinedb/shared/cache";
import * as schema from "@outlinedb/shared/db";
import type {WorkflowyInternalAdapter} from "@outlinedb/shared/internal";
import type {WorkflowyNode} from "@outlinedb/shared/types";
import type {AppEnv, ServerContext} from "../src/server/context.js";
import {httpAppFor} from "./http-app-for.js";

const createNode = vi.hoisted(() => vi.fn<SharedCache.WorkflowyWriteThroughClient["createNode"]>());
const moveNode = vi.hoisted(() => vi.fn<SharedCache.WorkflowyWriteThroughClient["moveNode"]>());

vi.mock("@outlinedb/shared/cache", async (importOriginal) => {
	const actual = await importOriginal<typeof SharedCache>();
	return {
		...actual,
		WorkflowyWriteThroughClient: class {
			createNode = createNode;
			moveNode = moveNode;
		},
	};
});

const {CacheService} = await import("@outlinedb/shared/cache");

const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");
const NOT_CONFIGURED =
	"Workflowy internal API is not configured (set WORKFLOWY_USERNAME and WORKFLOWY_PASSWORD, or run './bin/run.js internal login')";

function apiNode(id: string, parentId: string | null, priority: number): WorkflowyNode {
	return {id, name: id.toUpperCase(), note: null, parent_id: parentId, priority, createdAt: 100, modifiedAt: 200};
}

function dto(id: string, parentId: string | null, priority: number, hasChildren = false) {
	return {
		id,
		parent_id: parentId,
		name: id.toUpperCase(),
		note: null,
		priority,
		data: {layoutMode: null},
		numberedStart: null,
		createdAt: 100,
		modifiedAt: 200,
		completedAt: null,
		hasChildren,
		hasUncompletedChildren: hasChildren,
		hasMirrors: false,
		isMirror: false,
		originalNodeId: null,
		attachment: null,
		defaultToBottom: false,
		calendar: null,
		table: null,
	};
}

interface FakeAdapter {
	createAt: ReturnType<typeof vi.fn<WorkflowyInternalAdapter["createAt"]>>;
	createTreesAt: ReturnType<typeof vi.fn<WorkflowyInternalAdapter["createTreesAt"]>>;
	moveTo: ReturnType<typeof vi.fn<WorkflowyInternalAdapter["moveTo"]>>;
	moveBlocks: ReturnType<typeof vi.fn<WorkflowyInternalAdapter["moveBlocks"]>>;
	restore: ReturnType<typeof vi.fn<WorkflowyInternalAdapter["restore"]>>;
}

/** Home holds `a`, `b`, `c` (priorities 0..2); `a` is empty. */
function setup(configured: boolean) {
	const sqlite = new DatabaseConstructor(":memory:");
	const db = drizzle(sqlite, {schema});
	migrate(db, {migrationsFolder});
	const cacheService = new CacheService(db);
	for (const [index, id] of ["a", "b", "c"].entries()) {
		cacheService.insertNode(apiNode(id, null, index), null);
	}
	const adapter: FakeAdapter = {
		createAt: vi.fn<WorkflowyInternalAdapter["createAt"]>(async (input) => {
			const id = input.id ?? "new";
			cacheService.insertNode(apiNode(id, input.parentId === "home" ? null : input.parentId, 1), null);
			return Promise.resolve({id});
		}),
		createTreesAt: vi.fn<WorkflowyInternalAdapter["createTreesAt"]>(async () =>
			Promise.resolve({ids: ["t1", "t2"]}),
		),
		moveTo: vi.fn<WorkflowyInternalAdapter["moveTo"]>(async () => {}),
		moveBlocks: vi.fn<WorkflowyInternalAdapter["moveBlocks"]>(async () => {}),
		restore: vi.fn<WorkflowyInternalAdapter["restore"]>(async (input) => {
			cacheService.insertNode(apiNode(input.id, null, 0), null);
			return Promise.resolve();
		}),
	};
	const ctx = {
		db,
		cacheService,
		apiKey: "test-key",
		config: {} as ServerContext["config"],
		internalAuth: configured ? {} : undefined,
		internalAdapter: () => (configured ? (adapter as unknown as WorkflowyInternalAdapter) : undefined),
	} as unknown as ServerContext;
	const app = new Hono<AppEnv>();
	app.use("*", async (c, next) => {
		c.set("ctx", ctx);
		await next();
	});
	app.route("/", httpAppFor(ctx));
	const post = async (path: string, body: unknown) =>
		app.fetch(
			new Request(`http://x/api/v1/nodes${path}`, {
				method: "POST",
				headers: {"content-type": "application/json"},
				body: JSON.stringify(body),
			}),
		);
	return {adapter, cacheService, post};
}

beforeEach(() => {
	createNode.mockReset();
	moveNode.mockReset();
});

describe("POST /api/v1/nodes with the internal API", () => {
	it("creates at the exact index", async () => {
		const {adapter, post} = setup(true);

		const res = await post("", {parent_id: "home", name: "", index: 1});

		expect(res.status).toBe(201);
		expect(adapter.createAt.mock.calls).toStrictEqual([[{parentId: "home", index: 1, name: ""}]]);
		await expect(res.json()).resolves.toStrictEqual({node: dto("new", null, 1)});
	});

	it("creates at the bottom when the index is omitted", async () => {
		const {adapter, post} = setup(true);

		await post("", {parent_id: "home", name: "x"});

		expect(adapter.createAt.mock.calls).toStrictEqual([[{parentId: "home", name: "x"}]]);
	});

	it("passes note and layoutMode through and treats a null parent as Home", async () => {
		const {adapter, post} = setup(true);

		await post("", {parent_id: null, name: "x", note: "n", layoutMode: "board", index: 0});

		expect(adapter.createAt.mock.calls).toStrictEqual([
			[{parentId: "home", index: 0, name: "x", note: "n", metadata: {layoutMode: "board"}}],
		]);
	});

	it("creates under a client-generated id so the client can edit the row before the reply", async () => {
		const {adapter, post} = setup(true);
		const id = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

		await post("", {parent_id: "home", name: "", index: 1, id});

		expect(adapter.createAt.mock.calls).toStrictEqual([[{parentId: "home", index: 1, name: "", id}]]);
	});

	it("rejects a malformed or already used client id", async () => {
		const {adapter, post} = setup(true);

		const id = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
		const malformed = await post("", {parent_id: "home", name: "", id: "not-a-uuid"});
		await post("", {parent_id: "home", name: "", id});
		const taken = await post("", {parent_id: "home", name: "", id});

		expect({
			malformed: [malformed.status, await malformed.json()],
			taken: [taken.status, await taken.json()],
			calls: adapter.createAt.mock.calls.length,
		}).toStrictEqual({
			malformed: [400, {error: "Invalid request body"}],
			taken: [409, {error: `Node already exists: ${id}`}],
			calls: 1,
		});
	});

	it("maps a legacy negative position to the top", async () => {
		const {adapter, post} = setup(true);

		await post("", {parent_id: "a", name: "x", position: -1});

		expect(adapter.createAt.mock.calls).toStrictEqual([[{parentId: "a", index: 0, name: "x"}]]);
	});
});

describe("POST /api/v1/nodes/:id/move with the internal API", () => {
	it("moves to the exact index and returns the affected sibling lists", async () => {
		const {adapter, post} = setup(true);

		const res = await post("/c/move", {parent_id: "home", index: 0});

		expect(res.status).toBe(200);
		expect(adapter.moveTo.mock.calls).toStrictEqual([[{ids: ["c"], parentId: "home", index: 0}]]);
		await expect(res.json()).resolves.toStrictEqual({
			nodes: [dto("a", null, 0), dto("b", null, 1), dto("c", null, 2)],
		});
	});

	it("moves to the bottom when the index is omitted", async () => {
		const {adapter, post} = setup(true);

		const res = await post("/c/move", {parent_id: "a"});

		expect(adapter.moveTo.mock.calls).toStrictEqual([[{ids: ["c"], parentId: "a"}]]);
		await expect(res.json()).resolves.toStrictEqual({
			nodes: [dto("a", null, 0), dto("b", null, 1), dto("c", null, 2)],
		});
	});
});

describe("POST /api/v1/nodes/move with the internal API", () => {
	it("moves a block in one call", async () => {
		const {adapter, post} = setup(true);

		const res = await post("/move", {ids: ["b", "c"], parent_id: "a", index: 0});

		expect(res.status).toBe(200);
		expect(adapter.moveTo.mock.calls).toStrictEqual([[{ids: ["b", "c"], parentId: "a", index: 0}]]);
		await expect(res.json()).resolves.toStrictEqual({
			nodes: [dto("a", null, 0), dto("b", null, 1), dto("c", null, 2)],
		});
	});

	it("moves several blocks in one push", async () => {
		const {adapter, post} = setup(true);

		const res = await post("/move", {
			moves: [
				{ids: ["c"], parent_id: "b", index: 0},
				{ids: ["a"], parent_id: null},
			],
		});

		expect(res.status).toBe(200);
		expect({moveTo: adapter.moveTo.mock.calls, moveBlocks: adapter.moveBlocks.mock.calls}).toStrictEqual({
			moveTo: [],
			moveBlocks: [
				[
					[
						{ids: ["c"], parentId: "b", index: 0},
						{ids: ["a"], parentId: "home"},
					],
				],
			],
		});
		await expect(res.json()).resolves.toStrictEqual({
			nodes: [dto("a", null, 0), dto("b", null, 1), dto("c", null, 2)],
		});
	});

	it("rejects a body without ids", async () => {
		const {adapter, post} = setup(true);

		const res = await post("/move", {parent_id: "a", index: 0});

		expect(res.status).toBe(400);
		await expect(res.json()).resolves.toStrictEqual({error: "Invalid request body"});
		expect(adapter.moveTo.mock.calls).toStrictEqual([]);
	});
});

describe("POST /api/v1/nodes/:id/restore", () => {
	/** The public API's GET /api/v1/nodes/<id>: the `live` ids answer with the node, any other id 404s. */
	function liveApi(live: string[]) {
		const fetchMock = vi.fn<(url: string) => Promise<Response>>(async (url) => {
			const id = url.split("/api/v1/nodes/")[1] ?? "";
			return Promise.resolve(
				live.includes(id)
					? Response.json({node: apiNode(id, null, 0)})
					: new Response("Not Found", {status: 404, statusText: "Not Found"}),
			);
		});
		vi.stubGlobal("fetch", fetchMock);
		return fetchMock;
	}

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("restores into the given slot and returns the node under its original id", async () => {
		const {adapter, post} = setup(true);
		const fetchMock = liveApi([]);

		const res = await post("/gone/restore", {parent_id: "home", index: 0});

		expect(res.status).toBe(200);
		expect(fetchMock.mock.calls.map(([url]) => url)).toStrictEqual(["https://workflowy.com/api/v1/nodes/gone"]);
		expect(adapter.restore.mock.calls).toStrictEqual([[{id: "gone", parentId: "home", index: 0}]]);
		await expect(res.json()).resolves.toStrictEqual({node: dto("gone", null, 0)});
	});

	it("restores to the original location without a slot", async () => {
		const {adapter, post} = setup(true);
		liveApi([]);

		await post("/gone/restore", {});

		expect(adapter.restore.mock.calls).toStrictEqual([[{id: "gone"}]]);
	});

	it("answers 409 when the node is not deleted", async () => {
		const {adapter, post} = setup(true);
		liveApi(["a"]);

		const res = await post("/a/restore", {});

		expect(res.status).toBe(409);
		await expect(res.json()).resolves.toStrictEqual({error: "Node is not deleted"});
		expect(adapter.restore.mock.calls).toStrictEqual([]);
	});

	it("answers 409 when the node is live upstream though missing from the cache", async () => {
		const {adapter, post} = setup(true);
		liveApi(["fresh"]);

		const res = await post("/fresh/restore", {});

		expect(res.status).toBe(409);
		await expect(res.json()).resolves.toStrictEqual({error: "Node is not deleted"});
		expect(adapter.restore.mock.calls).toStrictEqual([]);
	});

	it("restores a node deleted upstream though still cached, ending its stale rows", async () => {
		const {adapter, cacheService, post} = setup(true);
		cacheService.insertNode(apiNode("a1", "a", 0), "a");
		liveApi([]);

		const res = await post("/a/restore", {});

		expect(res.status).toBe(200);
		expect(adapter.restore.mock.calls).toStrictEqual([[{id: "a"}]]);
		expect(cacheService.getNode("a1")).toBeUndefined();
		await expect(res.json()).resolves.toStrictEqual({node: dto("a", null, 0)});
	});

	it("answers 503 when the internal API is not configured", async () => {
		const {post} = setup(false);

		const res = await post("/gone/restore", {});

		expect(res.status).toBe(503);
		await expect(res.json()).resolves.toStrictEqual({error: NOT_CONFIGURED});
	});
});

describe("public-API fallback when the internal API is not configured", () => {
	const created = {...apiNode("n1", "a", 0), completedAt: null};

	it("maps create index 0 to top and the child count to bottom", async () => {
		const {post} = setup(false);
		createNode.mockResolvedValue(created);

		const top = await post("", {parent_id: "home", name: "x", index: 0});
		const bottom = await post("", {parent_id: "home", name: "y", index: 3});
		const omitted = await post("", {parent_id: "home", name: "z"});

		expect([top.status, bottom.status, omitted.status]).toStrictEqual([201, 201, 201]);
		expect(createNode.mock.calls).toStrictEqual([
			[{parent_id: "home", name: "x", note: undefined, layoutMode: undefined, position: "top"}],
			[{parent_id: "home", name: "y", note: undefined, layoutMode: undefined, position: "bottom"}],
			[{parent_id: "home", name: "z", note: undefined, layoutMode: undefined, position: "bottom"}],
		]);
		const {hasMirrors: _omitted, ...publicShape} = dto("n1", null, 0, true);
		await expect(top.json()).resolves.toStrictEqual({node: publicShape});
	});

	it("creates at a middle index by rotating the shorter side of the siblings", async () => {
		const {post} = setup(false);
		createNode.mockResolvedValue(created);
		moveNode.mockResolvedValue(apiNode("a", null, 0));

		const res = await post("", {parent_id: "home", name: "x", index: 1});

		expect(res.status).toBe(201);
		expect(createNode.mock.calls).toStrictEqual([
			[{parent_id: "home", name: "x", note: undefined, layoutMode: undefined, position: "top"}],
		]);
		expect(moveNode.mock.calls).toStrictEqual([["a", null, -1]]);
	});

	it("maps move index 0 to top and the child count to bottom, and rotates a middle index", async () => {
		const {post} = setup(false);
		moveNode.mockResolvedValue(apiNode("c", null, 0));

		const top = await post("/c/move", {parent_id: "home", index: 0});
		const bottom = await post("/c/move", {parent_id: "home", index: 3});
		const middle = await post("/c/move", {parent_id: "home", index: 1});

		expect([top.status, bottom.status, middle.status]).toStrictEqual([200, 200, 200]);
		expect(moveNode.mock.calls).toStrictEqual([
			["c", null, -1],
			["c", null, 0],
			["c", null, -1],
			["a", null, -1],
		]);
	});

	it("moves a block to the top last-first so it keeps its order", async () => {
		const {post} = setup(false);
		moveNode.mockResolvedValue(apiNode("b", null, 0));

		const res = await post("/move", {ids: ["b", "c"], parent_id: "home", index: 0});

		expect(res.status).toBe(200);
		expect(moveNode.mock.calls).toStrictEqual([
			["c", null, -1],
			["b", null, -1],
		]);
	});

	it("moves several blocks one after another", async () => {
		const {post} = setup(false);
		moveNode.mockResolvedValue(apiNode("c", null, 0));

		const res = await post("/move", {
			moves: [
				{ids: ["c"], parent_id: "home", index: 0},
				{ids: ["a"], parent_id: "home"},
			],
		});

		expect(res.status).toBe(200);
		expect(moveNode.mock.calls).toStrictEqual([
			["c", null, -1],
			["a", null, 0],
		]);
	});
});

describe("POST /api/v1/nodes/trees", () => {
	it("creates the trees in one adapter call and returns the ids", async () => {
		const {adapter, post} = setup(true);

		const res = await post("/trees", {
			parent_id: null,
			index: 1,
			after_id: "a",
			trees: [
				{name: "x", note: "n", completed: true, layoutMode: "h1", children: [{name: "y", numberedStart: 3}]},
				{name: "z"},
			],
		});

		expect({status: res.status, body: await res.json(), calls: adapter.createTreesAt.mock.calls}).toStrictEqual({
			status: 201,
			body: {ids: ["t1", "t2"]},
			calls: [
				[
					{
						parentId: "home",
						index: 1,
						afterId: "a",
						trees: [
							{
								name: "x",
								note: "n",
								completed: true,
								metadata: {layoutMode: "h1"},
								children: [{name: "y", metadata: {numbered_start: 3}}],
							},
							{name: "z"},
						],
					},
				],
			],
		});
	});

	it("rejects more than 10000 nodes in total", async () => {
		const {adapter, post} = setup(true);
		const trees = [{name: "p", children: Array.from({length: 10_000}, () => ({name: "c"}))}];

		const res = await post("/trees", {parent_id: "home", index: 0, trees});

		expect({
			status: res.status,
			body: await res.json(),
			calls: adapter.createTreesAt.mock.calls.length,
		}).toStrictEqual({status: 400, body: {error: "Too many nodes: 10001 (max 10000)"}, calls: 0});
	});

	it("needs the internal adapter", async () => {
		const {post} = setup(false);

		const res = await post("/trees", {parent_id: "home", index: 0, trees: [{name: "a"}]});

		expect(res.status).toBe(503);
	});
});
