import {beforeEach, describe, expect, it, vi} from "vite-plus/test";
import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {Hono} from "hono";
import {join} from "node:path";
import type * as SharedCache from "@outlinedb/shared/cache";
import * as schema from "@outlinedb/shared/db";
import type {WorkflowyInternalAdapter} from "@outlinedb/shared/internal";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import type {WorkflowyNode} from "@outlinedb/shared/types";
import type {AppEnv, ServerContext} from "../src/server/context.js";
import {httpAppFor} from "./http-app-for.js";

const deleteNode = vi.hoisted(() => vi.fn<SharedCache.WorkflowyWriteThroughClient["deleteNode"]>());

vi.mock("@outlinedb/shared/cache", async (importOriginal) => {
	const actual = await importOriginal<typeof SharedCache>();
	return {
		...actual,
		WorkflowyWriteThroughClient: class {
			deleteNode = deleteNode;
		},
	};
});

const {CacheService} = await import("@outlinedb/shared/cache");

const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");

function apiNode(
	id: string,
	parentId: string | null,
	priority: number,
	extra: Partial<WorkflowyNode> = {},
): WorkflowyNode {
	return {
		id,
		name: id.toLowerCase(),
		note: null,
		parent_id: parentId,
		priority,
		createdAt: 100,
		modifiedAt: 200,
		...extra,
	};
}

/**
 * Home holds P, O and X. O (completed, note "n") holds C (which holds G) and D, an original that has a mirror
 * under X, and E, a mirror of X. P holds A, M (mirror of O), B.
 */
function setup(expanded: string[] = []) {
	const sqlite = new DatabaseConstructor(":memory:");
	const db = drizzle(sqlite, {schema});
	migrate(db, {migrationsFolder});
	const cacheService = new CacheService(db);
	cacheService.insertNode(apiNode("P", null, 0), null);
	cacheService.insertNode(apiNode("O", null, 1, {note: "n", completed: true, completedAt: 5}), null);
	cacheService.insertNode(apiNode("X", null, 2), null);
	cacheService.insertNode(apiNode("C", "O", 0, {data: {layoutMode: "board"}}), "O");
	cacheService.insertNode(apiNode("G", "C", 0, {completed: true, completedAt: 6}), "C");
	cacheService.insertNode(apiNode("D", "O", 1), "O");
	cacheService.insertNode(apiNode("E", "O", 2), "O");
	cacheService.insertNode(apiNode("A", "P", 0), "P");
	cacheService.insertNode(apiNode("M", "P", 1), "P");
	cacheService.insertNode(apiNode("B", "P", 2), "P");
	cacheService.insertNode(apiNode("DM", "X", 0), "X");
	const link = sqlite.prepare(
		"INSERT INTO mirrors (mirror_id, original_id, system_from, system_to) VALUES (?, ?, ?, ?)",
	);
	link.run("M", "O", "2000-01-01T00:00:00.000Z", FAR_FUTURE_DATE);
	link.run("DM", "D", "2000-01-01T00:00:00.000Z", FAR_FUTURE_DATE);
	link.run("E", "X", "2000-01-01T00:00:00.000Z", FAR_FUTURE_DATE);
	const createTreesAt = vi.fn<WorkflowyInternalAdapter["createTreesAt"]>(async (input) => {
		cacheService.insertNode(apiNode("COPY", input.parentId === "home" ? null : input.parentId, 9), null);
		return Promise.resolve({ids: ["COPY"]});
	});
	const setExpanded = vi.fn<WorkflowyInternalAdapter["setExpanded"]>(async () => Promise.resolve());
	const expansionTest = vi.fn<WorkflowyInternalAdapter["expansionTest"]>(() => (id: string) => expanded.includes(id));
	const ctx = {
		db,
		cacheService,
		apiKey: "test-key",
		config: {} as ServerContext["config"],
		internalAuth: {},
		internalAdapter: () => ({createTreesAt, setExpanded, expansionTest}) as unknown as WorkflowyInternalAdapter,
	} as unknown as ServerContext;
	const app = new Hono<AppEnv>();
	app.use("*", async (c, next) => {
		c.set("ctx", ctx);
		await next();
	});
	app.route("/", httpAppFor(ctx));
	const post = async (path: string) => app.fetch(new Request(`http://x/api/v1/nodes${path}`, {method: "POST"}));
	return {createTreesAt, setExpanded, cacheService, post};
}

beforeEach(() => {
	deleteNode.mockReset();
	deleteNode.mockResolvedValue({mirrorIds: [], promotions: [], nodeId: "x"});
});

const anyId = expect.any(String) as string;

describe("POST /api/v1/nodes/:id/detach-mirror", () => {
	it("copies a mirror as an open item at its slot: descendant mirrors and originals-with-mirrors stay mirrors, then removes the mirror", async () => {
		const {createTreesAt, post} = setup();

		const res = await post("/M/detach-mirror");

		expect({status: res.status, calls: createTreesAt.mock.calls, deleted: deleteNode.mock.calls}).toStrictEqual({
			status: 201,
			calls: [
				[
					{
						parentId: "P",
						index: 1,
						trees: [
							{
								id: anyId,
								name: "o",
								note: "n",
								children: [
									{
										id: anyId,
										name: "c",
										metadata: {layoutMode: "board"},
										children: [{id: anyId, name: "g", completed: true}],
									},
									{id: anyId, name: "", metadata: {mirror: {originalId: "D", isMirrorRoot: true}}},
									{id: anyId, name: "", metadata: {mirror: {originalId: "X", isMirrorRoot: true}}},
								],
							},
						],
					},
				],
			],
			deleted: [["M"]],
		});
		expect(((await res.json()) as {node: {id: string; isMirror: boolean}}).node).toMatchObject({
			id: "COPY",
			isMirror: false,
		});
	});

	it("keeps an original's own completion when it detaches in place, and deletes it so its first mirror takes over", async () => {
		const {createTreesAt, post} = setup();

		const res = await post("/O/detach-mirror");

		expect({
			status: res.status,
			parent: createTreesAt.mock.calls[0]?.[0].parentId,
			index: createTreesAt.mock.calls[0]?.[0].index,
			completed: createTreesAt.mock.calls[0]?.[0].trees[0]?.completed,
			deleted: deleteNode.mock.calls,
		}).toStrictEqual({status: 201, parent: "home", index: 1, completed: true, deleted: [["O"]]});
	});

	it("opens the copy like the detached row", async () => {
		const {createTreesAt, setExpanded, post} = setup(["M", "C"]);

		await post("/M/detach-mirror");

		const [tree] = createTreesAt.mock.calls[0]?.[0].trees ?? [];
		expect(setExpanded.mock.calls).toStrictEqual([[{[tree.id ?? ""]: true, [tree.children?.[0]?.id ?? ""]: true}]]);
	});

	it("refuses a subtree of more than 2000 items without writing", async () => {
		const {createTreesAt, cacheService, post} = setup();
		for (let i = 0; i < 2000; i += 1) {
			cacheService.insertNode(apiNode(`bulk${i}`, "G", i), "G");
		}

		const res = await post("/M/detach-mirror");

		expect({
			status: res.status,
			body: await res.json(),
			created: createTreesAt.mock.calls.length,
			deleted: deleteNode.mock.calls.length,
		}).toStrictEqual({
			status: 400,
			body: {error: "Detaching mirror subtrees containing more than 2000 items is not supported."},
			created: 0,
			deleted: 0,
		});
	});

	it("refuses a plain node", async () => {
		const {createTreesAt, post} = setup();

		const res = await post("/A/detach-mirror");

		expect({status: res.status, calls: createTreesAt.mock.calls.length}).toStrictEqual({status: 400, calls: 0});
	});
});
