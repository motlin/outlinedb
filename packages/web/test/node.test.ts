import {describe, expect, it, afterEach, vi} from "vite-plus/test";
import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {Hono} from "hono";
import {join} from "node:path";
import {CacheService, storeInternalMetadata} from "@outlinedb/shared/cache";
import * as schema from "@outlinedb/shared/db";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import type {WorkflowyNode} from "@outlinedb/shared/types";
import type {AppEnv, ServerContext} from "../src/server/context.js";
import {httpAppFor} from "./http-app-for.js";
import {QueryClient} from "@tanstack/react-query";
import {
	cachedAncestors,
	cachedResolvedId,
	nodeKeys,
	patchCachedNode,
	readChildren,
	readDetail,
	readItemNode,
	readNode,
	removeFoundDates,
	seedResolvedId,
	spliceBlock,
	spliceChildren,
} from "../src/client/node-cache.js";
import type {NodeResponse} from "../src/node-types.js";
import {sql} from "drizzle-orm";
import {z} from "zod";
import type {AppDatabase} from "@outlinedb/shared/db";
import {
	TreeEventBus,
	accountChangePublisher,
	expansionChangePublisher,
	withTreeChangePublish,
} from "../src/server/node-events.js";
import {nodeEventsSocketHandlers} from "../src/server/node-events-socket.js";
import {defineOp, ok} from "../src/server/ops/define.js";
import {inProcessStore} from "../src/server/store.js";

describe("node attachment route", () => {
	const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");

	function apiNode(id: string): WorkflowyNode {
		return {id, name: "", note: null, parent_id: null, priority: 0, createdAt: 100, modifiedAt: 200};
	}

	function setup() {
		const sqlite = new DatabaseConstructor(":memory:");
		const db = drizzle(sqlite, {schema});
		migrate(db, {migrationsFolder});
		const cacheService = new CacheService(db);
		cacheService.insertNode(apiNode("n1"), null);
		sqlite
			.prepare(
				"INSERT INTO s3_files (node_id, file_name, file_type, object_folder, is_animated_gif, image_original_width, image_original_height, image_original_pixels, is_deleted, system_from, system_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				"n1",
				"IMG.png",
				"image/png",
				"folder-1",
				1,
				1440,
				1020,
				2.5,
				0,
				"2026-01-01T00:00:00.000Z",
				FAR_FUTURE_DATE,
			);
		const ctx = {db, cacheService} as unknown as ServerContext;
		const app = new Hono<AppEnv>();
		app.use("*", async (c, next) => {
			c.set("ctx", ctx);
			await next();
		});
		app.route("/", httpAppFor(ctx));
		return app;
	}

	describe("GET /api/v1/nodes/:id attachment", () => {
		it("exposes the fractional pixel density and the animated GIF flag", async () => {
			const res = await setup().fetch(new Request("http://x/api/v1/nodes/n1"));
			const body = (await res.json()) as {node: {attachment: unknown}};

			expect(body.node.attachment).toStrictEqual({
				fileName: "IMG.png",
				fileType: "image/png",
				objectFolder: "folder-1",
				imageOriginalWidth: 1440,
				imageOriginalHeight: 1020,
				imageOriginalPixels: 2.5,
				isAnimatedGif: true,
				isDeleted: false,
			});
		});
	});
});

describe("node cache", () => {
	describe("nodeKeys", () => {
		it("builds stable, namespaced keys", () => {
			expect(nodeKeys.all).toStrictEqual(["nodes"]);
			expect(nodeKeys.children("p")).toStrictEqual(["nodes", "children", "p"]);
			expect(nodeKeys.children(null)).toStrictEqual(["nodes", "children", null]);
			expect(nodeKeys.detail("n")).toStrictEqual(["nodes", "detail", "n"]);
			expect(nodeKeys.ancestors("n")).toStrictEqual(["nodes", "ancestors", "n"]);
		});
	});

	describe("readChildren / readDetail", () => {
		it("reads through the matching key", () => {
			const qc = new QueryClient();
			const kids: NodeResponse[] = [
				{
					id: "a",
					parent_id: "parent",
					name: "a",
					note: null,
					priority: 0,
					data: {layoutMode: null},
					createdAt: null,
					modifiedAt: null,
					completedAt: null,
				},
			];
			qc.setQueryData(nodeKeys.children("parent"), kids);
			qc.setQueryData(nodeKeys.detail("n"), {id: "n"});

			expect(readChildren(qc, "parent")).toBe(kids);
			expect(readDetail(qc, "n")).toStrictEqual({id: "n"});
		});

		it("returns undefined on a cache miss", () => {
			const qc = new QueryClient();
			expect(readChildren(qc, "absent")).toBeUndefined();
			expect(readDetail(qc, "absent")).toBeUndefined();
		});
	});

	function row(id: string, priority: number): NodeResponse {
		return {
			id,
			parent_id: "p",
			name: id,
			note: null,
			priority,
			data: {layoutMode: null},
			createdAt: null,
			modifiedAt: null,
			completedAt: null,
		};
	}

	const ids = (rows: NodeResponse[]) => rows.map((r) => r.id);

	describe("spliceChildren", () => {
		const abc = [row("a", 100), row("b", 200), row("c", 300)];

		it("moves a row within its parent to a slot counted before removal, without duplicating it", () => {
			expect([
				ids(spliceChildren(abc, abc[0], 2)),
				ids(spliceChildren(abc, abc[0], 1)),
				ids(spliceChildren(abc, abc[2], 0)),
				ids(spliceChildren(abc, abc[0], 3)),
			]).toStrictEqual([
				["b", "a", "c"],
				["a", "b", "c"],
				["c", "a", "b"],
				["b", "c", "a"],
			]);
		});

		it("inserts a new row at the index", () => {
			expect(ids(spliceChildren([row("y", 5), row("z", 9)], row("x", 0), 0))).toStrictEqual(["x", "y", "z"]);
		});

		it("clamps an index past the end", () => {
			expect(ids(spliceChildren(abc, row("x", 0), 9))).toStrictEqual(["a", "b", "c", "x"]);
		});

		it("sorts by priority and fits the row into the gap before the first row, keeping the others' priorities", () => {
			const shuffled = [row("c", 30), row("a", 10), row("b", 20)];
			expect(spliceChildren(shuffled, shuffled[0], 0).map((r) => [r.id, r.priority])).toStrictEqual([
				["c", 4],
				["a", 10],
				["b", 20],
			]);
		});
	});

	describe("spliceBlock", () => {
		it("removes every moved row then inserts the block contiguously in order", () => {
			const children = [row("d", 1), row("c", 2), row("b", 3), row("a", 4)];
			expect([
				ids(spliceBlock(children, [children[1], children[2]], 4)),
				ids(spliceBlock(children, [children[1], children[2]], 3)),
				ids(spliceBlock(children, [children[1], children[2]], 0)),
			]).toStrictEqual([
				["d", "a", "c", "b"],
				["d", "c", "b", "a"],
				["c", "b", "d", "a"],
			]);
		});

		it("appends after the last row's priority and seeds an empty list from 100, keeping every unmoved row", () => {
			const children = [row("a", 100), row("b", 200)];
			const appended = spliceBlock(children, [row("x", 5), row("y", 6)], 2);
			expect({
				appended: appended.map((r) => [r.id, r.priority]),
				kept: appended.slice(0, 2).every((r, i) => r === children[i]),
				seeded: spliceBlock([], [row("x", 5), row("y", 6)], 0).map((r) => [r.id, r.priority]),
			}).toStrictEqual({
				appended: [
					["a", 100],
					["b", 200],
					["x", 300],
					["y", 400],
				],
				kept: true,
				seeded: [
					["x", 100],
					["y", 200],
				],
			});
		});

		it("spreads a block evenly over the gap between its neighbours", () => {
			const children = [row("a", 100), row("b", 400)];
			expect(spliceBlock(children, [row("x", 0), row("y", 0)], 1).map((r) => [r.id, r.priority])).toStrictEqual([
				["a", 100],
				["x", 200],
				["y", 300],
				["b", 400],
			]);
		});

		it("renumbers from 0 when the block has no gap, keeping each row whose slot did not change as the same object", () => {
			const children = [row("a", 0), row("b", 1), row("c", 2), row("d", 3)];
			const spliced = spliceBlock(children, [children[2]], 1);
			expect({
				order: spliced.map((r) => [r.id, r.priority]),
				kept: spliced.map((r) => children.includes(r)),
			}).toStrictEqual({
				order: [
					["a", 0],
					["c", 1],
					["b", 2],
					["d", 3],
				],
				kept: [true, false, false, true],
			});
		});
	});

	describe("patchCachedNode", () => {
		it("patches the node's detail and its row in every cached children list, leaving other rows alone", () => {
			const qc = new QueryClient();
			qc.setQueryData(nodeKeys.children("p"), [row("a", 100), row("b", 200)]);
			qc.setQueryData(nodeKeys.detail("a"), row("a", 100));
			patchCachedNode(qc, "a", (node) => ({...node, name: "alpha"}));
			expect({
				children: qc.getQueryData<NodeResponse[]>(nodeKeys.children("p"))?.map((r) => [r.id, r.name]),
				detail: qc.getQueryData<NodeResponse>(nodeKeys.detail("a"))?.name,
			}).toStrictEqual({
				children: [
					["a", "alpha"],
					["b", "b"],
				],
				detail: "alpha",
			});
		});

		it("returns snapshots that restore every touched entry", () => {
			const qc = new QueryClient();
			qc.setQueryData(nodeKeys.children("p"), [row("a", 100)]);
			const restore = patchCachedNode(qc, "a", (node) => ({...node, name: "alpha"}));
			restore();
			expect(qc.getQueryData<NodeResponse[]>(nodeKeys.children("p"))?.map((r) => r.name)).toStrictEqual(["a"]);
		});
	});

	describe("readItemNode", () => {
		it("falls back to the cached row while the edited node's fetch is still pending", () => {
			const qc = new QueryClient();
			qc.setQueryData(nodeKeys.children("p"), [row("a", 100), row("b", 200)]);
			expect(readItemNode(qc, "b", undefined)).toStrictEqual(row("b", 200));
		});

		it("prefers the fetched edited node when it is the item", () => {
			const qc = new QueryClient();
			qc.setQueryData(nodeKeys.children("p"), [row("a", 100)]);
			const fetched = {...row("a", 100), name: "fetched"};
			expect(readItemNode(qc, "a", fetched)).toStrictEqual(fetched);
		});

		it("reads the cache when the edited node is another row", () => {
			const qc = new QueryClient();
			qc.setQueryData(nodeKeys.children("p"), [row("a", 100), row("b", 200)]);
			expect(readItemNode(qc, "b", row("a", 100))).toStrictEqual(row("b", 200));
		});

		it("is undefined with no item or an uncached item", () => {
			const qc = new QueryClient();
			expect([readItemNode(qc, undefined, row("a", 100)), readItemNode(qc, "x", undefined)]).toStrictEqual([
				undefined,
				undefined,
			]);
		});
	});

	describe("Found Dates rows", () => {
		const found = (id: string): NodeResponse => ({...row(id, 1), isMirror: true, originalNodeId: id});

		it("readNode falls back to a cached Found Dates row, read as its original", () => {
			const qc = new QueryClient();
			qc.setQueryData(nodeKeys.foundDates("day"), {items: [{node: found("due"), crumbs: []}]});

			expect({due: readNode(qc, "due"), absent: readNode(qc, "absent")}).toStrictEqual({
				due: {...row("due", 1), isMirror: false, originalNodeId: null},
				absent: undefined,
			});
		});

		it("readNode prefers the node's own row to its Found Dates row", () => {
			const qc = new QueryClient();
			qc.setQueryData(nodeKeys.children("p"), [row("due", 1)]);
			qc.setQueryData(nodeKeys.foundDates("day"), {items: [{node: found("due"), crumbs: []}]});

			expect(readNode(qc, "due")).toStrictEqual(row("due", 1));
		});

		it("removeFoundDates drops the rows from every cached Found Dates list", () => {
			const qc = new QueryClient();
			qc.setQueryData(nodeKeys.foundDates("d1"), {
				items: [
					{node: found("a"), crumbs: []},
					{node: found("b"), crumbs: []},
				],
			});
			qc.setQueryData(nodeKeys.foundDates("d2"), {items: [{node: found("a"), crumbs: []}]});

			removeFoundDates(qc, ["a"]);

			expect({
				d1: qc.getQueryData(nodeKeys.foundDates("d1")),
				d2: qc.getQueryData(nodeKeys.foundDates("d2")),
			}).toStrictEqual({d1: {items: [{node: found("b"), crumbs: []}]}, d2: {items: []}});
		});
	});

	describe("seedResolvedId", () => {
		it("caches the node's short URL id as resolved, so the hash route zooms without a lookup request", () => {
			const queryClient = new QueryClient();
			seedResolvedId(queryClient, "4823cefa-5fc0-478c-88ac-35035d443bf1");
			expect(queryClient.getQueryData(nodeKeys.resolvedId("35035d443bf1"))).toBe(
				"4823cefa-5fc0-478c-88ac-35035d443bf1",
			);
		});
	});

	const ALICE = "4823cefa-5fc0-478c-88ac-35035d443bf1";
	const BOB = "9a1f6c2e-0b7d-4e5a-8c3f-aaaaaaaaaaaa";
	const CAROL = "1b2c3d4e-5f60-4718-9a0b-bbbbbbbbbbbb";

	function treeRow(id: string, parentId: string | null, fields: Partial<NodeResponse> = {}): NodeResponse {
		return {...row(id, 100), parent_id: parentId, ...fields};
	}

	function asAncestor(node: NodeResponse): NodeResponse {
		return {...node, hasChildren: true, hasUncompletedChildren: true, isMirror: false, originalNodeId: null};
	}

	describe("cachedResolvedId", () => {
		it("resolves a short URL id from any cached row, detail or ancestor chain, and misses an unknown one", () => {
			const queryClient = new QueryClient();
			queryClient.setQueryData(nodeKeys.children(null), [treeRow(ALICE, null)]);
			queryClient.setQueryData(nodeKeys.detail(BOB), treeRow(BOB, ALICE));
			queryClient.setQueryData(nodeKeys.ancestors("x"), [treeRow(CAROL, null)]);
			expect([
				cachedResolvedId(queryClient, "35035d443bf1"),
				cachedResolvedId(queryClient, "aaaaaaaaaaaa"),
				cachedResolvedId(queryClient, "bbbbbbbbbbbb"),
				cachedResolvedId(queryClient, ALICE),
				cachedResolvedId(queryClient, "cccccccccccc"),
			]).toStrictEqual([ALICE, BOB, CAROL, ALICE, undefined]);
		});
	});

	describe("cachedAncestors", () => {
		const alice = treeRow(ALICE, null);
		const bob = treeRow(BOB, ALICE, {isMirror: true, originalNodeId: "orig", hasChildren: false});
		const carol = treeRow(CAROL, BOB);

		it("extends the parent's cached chain with the node's cached row, as the ancestors route returns it", () => {
			const queryClient = new QueryClient();
			queryClient.setQueryData(nodeKeys.ancestors(ALICE), [asAncestor(alice)]);
			queryClient.setQueryData(nodeKeys.children(ALICE), [bob]);
			expect(cachedAncestors(queryClient, BOB)).toStrictEqual([asAncestor(alice), asAncestor(bob)]);
		});

		it("cuts an ancestor's chain out of any cached chain that passes through it", () => {
			const queryClient = new QueryClient();
			queryClient.setQueryData(nodeKeys.ancestors(CAROL), [
				asAncestor(alice),
				asAncestor(bob),
				asAncestor(carol),
			]);
			expect(cachedAncestors(queryClient, BOB)).toStrictEqual([asAncestor(alice), asAncestor(bob)]);
		});

		it("builds a top-level node's chain from its row alone", () => {
			const queryClient = new QueryClient();
			queryClient.setQueryData(nodeKeys.children(null), [alice]);
			expect(cachedAncestors(queryClient, ALICE)).toStrictEqual([asAncestor(alice)]);
		});

		it("misses when the node or its parent's chain is not cached", () => {
			const queryClient = new QueryClient();
			queryClient.setQueryData(nodeKeys.children(ALICE), [bob]);
			expect([cachedAncestors(queryClient, BOB), cachedAncestors(queryClient, CAROL)]).toStrictEqual([
				undefined,
				undefined,
			]);
		});
	});
});

describe("node calendar dto", () => {
	const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");

	function time(year: number, month: number, day: number): string {
		return `<time startYear="${year}" startMonth="${month}" startDay="${day}">${month}/${day}/${year}</time>`;
	}

	/**
	 * [id, parent, name]: a 📆 Calendar whose root carries stored calendar metadata,
	 * a day tagged only by a backup import, a day tagged by `/get_tree_data/`, a day
	 * known only by its name, and `<time>` names that are not day nodes.
	 */
	const TREE: [string, string | null, string][] = [
		["cal", null, "📆 Calendar"],
		["elsewhere", null, time(2026, 10, 1)],
		["y2026", "cal", "2026"],
		["m09", "y2026", "09"],
		["d0930", "m09", "Sept 30"],
		["m10", "y2026", "10"],
		["entry", "m10", `Kickoff ${time(2026, 10, 1)}`],
		["d1001", "m10", time(2026, 10, 1)],
		["d1002", "m10", time(2026, 10, 2)],
		["wrongday", "m10", time(2026, 9, 3)],
	];

	const ROOT_METADATA = {
		calendar: {root: true, levels: {day: true, month: true, year: true}, found_dates: true, day_prefix: false},
	};
	const INTERNAL: Record<string, Record<string, unknown>> = {
		cal: ROOT_METADATA,
		d0930: {layoutMode: "bullets"},
		d1002: {restorableUniqueNode: true, calendar: {level: "day", value: "2", dateId: 20_261_002, timestamp: 0}},
	};

	/** A day tagged only by a backup import, written without a tagged root (a `/get_tree_data/` import would phase it out). */
	const BACKUP: {nodeId: string; level: string; dateId: number}[] = [
		{nodeId: "d0930", level: "day", dateId: 20_260_930},
	];

	const open: DatabaseConstructor.Database[] = [];
	afterEach(() => {
		for (const sqlite of open.splice(0)) {
			sqlite.close();
		}
	});

	function setup({taggedRoot = true}: {taggedRoot?: boolean} = {}) {
		const sqlite = new DatabaseConstructor(":memory:");
		open.push(sqlite);
		const db = drizzle(sqlite, {schema});
		migrate(db, {migrationsFolder});
		const cacheService = new CacheService(db);
		TREE.forEach(([id, parentId, name], priority) => {
			cacheService.insertNode(
				{id, name, note: null, parent_id: parentId, priority, createdAt: 1, modifiedAt: 1},
				parentId,
			);
		});
		for (const [nodeId, metadata] of Object.entries(INTERNAL)) {
			if (!taggedRoot && (nodeId === "cal" || nodeId === "d0930")) {
				continue;
			}
			storeInternalMetadata(db, new Map([[nodeId, metadata]]));
		}
		for (const row of taggedRoot ? [] : BACKUP) {
			db.insert(schema.calendarMetadata)
				.values({...row, systemFrom: "2026-01-01", systemTo: FAR_FUTURE_DATE})
				.run();
		}
		const ctx = {db, cacheService} as unknown as ServerContext;
		const app = new Hono<AppEnv>();
		app.use("*", async (c, next) => {
			c.set("ctx", ctx);
			await next();
		});
		app.route("/", httpAppFor(ctx));
		return async (path: string): Promise<unknown> =>
			(await app.fetch(new Request(`http://x/api/v1${path}`))).json() as Promise<unknown>;
	}

	const day = (dateId: number, restorableUniqueNode = false) => ({
		level: "day",
		dateId,
		root: false,
		foundDates: null,
		dayPrefix: null,
		restorableUniqueNode,
	});

	describe("node DTO calendar info", () => {
		it("carries the calendar root's settings from its internal metadata", async () => {
			const get = setup();

			await expect(get("/nodes/cal")).resolves.toMatchObject({
				node: {calendar: {level: null, dateId: null, root: true, foundDates: true, dayPrefix: false}},
			});
		});

		it("tags day nodes by stored calendar metadata (from /get_tree_data/ or a backup), then the year > month > <time> name walk without a tagged root", async () => {
			const get = setup({taggedRoot: false});

			const body = (await get("/nodes?parent_id=m10")) as {nodes: {id: string; calendar: unknown}[]};
			const single = (await get("/nodes/d0930")) as {node: {calendar: unknown}};

			expect({
				children: body.nodes.map(({id, calendar}) => ({id, calendar})),
				d0930: single.node.calendar,
			}).toStrictEqual({
				children: [
					{id: "entry", calendar: null},
					{id: "d1001", calendar: day(20_261_001)},
					{id: "d1002", calendar: day(20_261_002, true)},
					{id: "wrongday", calendar: null},
				],
				d0930: day(20_260_930),
			});
		});

		it("trusts only stored calendar metadata, never the name walk, once the calendar root is tagged", async () => {
			const get = setup();

			const body = (await get("/nodes?parent_id=m10")) as {nodes: {id: string; calendar: unknown}[]};
			const single = (await get("/nodes/d0930")) as {node: {calendar: unknown}};

			expect({
				children: body.nodes.map(({id, calendar}) => ({id, calendar})),
				d0930: single.node.calendar,
			}).toStrictEqual({
				children: [
					{id: "entry", calendar: null},
					{id: "d1001", calendar: null},
					{id: "d1002", calendar: day(20_261_002, true)},
					{id: "wrongday", calendar: null},
				],
				d0930: null,
			});
		});

		it("leaves a <time>-named node outside the calendar untagged", async () => {
			const get = setup();

			await expect(get("/nodes/elsewhere")).resolves.toMatchObject({node: {calendar: null}});
		});

		it("carries each ancestor's calendar role, so a day page can read the root's settings", async () => {
			const get = setup();

			const body = (await get("/nodes/d1001/ancestors")) as {ancestors: {id: string; calendar: unknown}[]};

			expect(body.ancestors.map(({id, calendar}) => ({id, calendar}))).toStrictEqual([
				{
					id: "cal",
					calendar: {
						level: null,
						dateId: null,
						root: true,
						foundDates: true,
						dayPrefix: false,
						restorableUniqueNode: false,
					},
				},
				{id: "y2026", calendar: null},
				{id: "m10", calendar: null},
				{id: "d1001", calendar: null},
			]);
		});
	});
});

describe("node events socket", () => {
	const MARK = "2026-11-05 12:00:00.000";

	function connect(bus: TreeEventBus) {
		const ws = {send: vi.fn<(data: string) => void>()};
		const handlers = nodeEventsSocketHandlers(bus);
		handlers.onOpen?.({}, ws);
		return {ws, handlers};
	}

	const open: DatabaseConstructor.Database[] = [];
	afterEach(() => {
		for (const sqlite of open.splice(0)) {
			sqlite.close();
		}
	});

	function scratchDb(): AppDatabase {
		const sqlite = new DatabaseConstructor(":memory:");
		open.push(sqlite);
		const db = drizzle(sqlite, {schema});
		// The tree.changed watermark reads the bulk-import lease from the migrated schema.
		migrate(db, {migrationsFolder: join(import.meta.dirname, "../../shared/src/db/migrations")});
		db.run(sql`CREATE TABLE scratch (x INTEGER)`);
		return db;
	}

	function framesOf(ws: {send: {mock: {calls: [string][]}}}) {
		return ws.send.mock.calls.map(([frame]) => JSON.parse(frame) as unknown);
	}

	describe("nodeEventsSocketHandlers", () => {
		it("sends exactly one tree.changed frame per published change to every connected socket", () => {
			const bus = new TreeEventBus();
			const first = connect(bus);
			const second = connect(bus);
			bus.publish(MARK);
			const expected = [{type: "tree.changed", latest: MARK}];
			expect({first: framesOf(first.ws), second: framesOf(second.ws)}).toStrictEqual({
				first: expected,
				second: expected,
			});
			expect(first.ws.send.mock.calls).toStrictEqual([[`{"type":"tree.changed","latest":"${MARK}"}`]]);
		});

		it("stops sending to a socket after it closes", () => {
			const bus = new TreeEventBus();
			const closed = connect(bus);
			const live = connect(bus);
			closed.handlers.onClose?.({}, closed.ws);
			bus.publish(MARK);
			expect({closed: framesOf(closed.ws), live: framesOf(live.ws)}).toStrictEqual({
				closed: [],
				live: [{type: "tree.changed", latest: MARK}],
			});
		});

		it("drops a socket whose send throws without starving the others", () => {
			const bus = new TreeEventBus();
			const broken = connect(bus);
			broken.ws.send.mockImplementation(() => {
				throw new Error("socket closed");
			});
			const live = connect(bus);
			bus.publish(MARK);
			bus.publish(MARK);
			expect({broken: broken.ws.send.mock.calls.length, live: live.ws.send.mock.calls.length}).toStrictEqual({
				broken: 1,
				live: 2,
			});
		});
	});

	describe("withTreeChangePublish", () => {
		it("publishes one change after a unit of work that wrote, and none after one that only read", async () => {
			const db = scratchDb();
			const bus = new TreeEventBus();
			const {ws} = connect(bus);
			const now = () => MARK;
			await withTreeChangePublish(db, bus, async () => Promise.resolve(db.all(sql`SELECT * FROM scratch`)), now);
			expect(framesOf(ws)).toStrictEqual([]);
			await withTreeChangePublish(
				db,
				bus,
				async () => {
					db.run(sql`INSERT INTO scratch VALUES (1)`);
					db.run(sql`INSERT INTO scratch VALUES (2)`);
					return Promise.resolve();
				},
				now,
			);
			expect(framesOf(ws)).toStrictEqual([{type: "tree.changed", latest: MARK}]);
		});

		it("still publishes when the unit of work wrote and then threw", async () => {
			const db = scratchDb();
			const bus = new TreeEventBus();
			const {ws} = connect(bus);
			await expect(
				withTreeChangePublish(
					db,
					bus,
					async () => {
						db.run(sql`INSERT INTO scratch VALUES (1)`);
						return Promise.reject(new Error("late failure"));
					},
					() => MARK,
				),
			).rejects.toThrow("late failure");
			expect(framesOf(ws)).toStrictEqual([{type: "tree.changed", latest: MARK}]);
		});
	});

	describe("inProcessStore with treeEvents", () => {
		it("announces each op that wrote and stays quiet for reads", async () => {
			const db = scratchDb();
			const bus = new TreeEventBus();
			const {ws} = connect(bus);
			const ops = {
				read: defineOp({
					input: z.object({}),
					output: z.null(),
					run: (ctx: ServerContext) => {
						ctx.db.all(sql`SELECT * FROM scratch`);
						return ok(null);
					},
				}),
				write: defineOp({
					input: z.object({}),
					output: z.null(),
					run: (ctx: ServerContext) => {
						ctx.db.run(sql`INSERT INTO scratch VALUES (1)`);
						return ok(null);
					},
				}),
			};
			const store = inProcessStore({db} as ServerContext, ops, {treeEvents: bus});
			await store.call("read" as never, {} as never);
			await store.call("write" as never, {} as never);
			const frames = framesOf(ws) as {type: string; latest: string}[];
			expect(frames.map(({type}) => type)).toStrictEqual(["tree.changed"]);
			expect(frames[0].latest).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/u);
		});
	});

	describe("expansionChangePublisher", () => {
		it("sends one expansion.changed frame when the keys' version moves, and none while it holds", () => {
			const bus = new TreeEventBus();
			const {ws} = connect(bus);
			let current: string | undefined = "aaaaaaaaaaaaaaaa";
			const check = expansionChangePublisher(bus, () => current);
			check();
			current = "bbbbbbbbbbbbbbbb";
			check();
			check();
			current = undefined;
			check();
			expect(ws.send.mock.calls).toStrictEqual([['{"type":"expansion.changed","version":"bbbbbbbbbbbbbbbb"}']]);
		});
	});

	describe("accountChangePublisher", () => {
		it("sends one account.changed frame when the account tables' version moves, and none while it holds", () => {
			const bus = new TreeEventBus();
			const {ws} = connect(bus);
			let current = "aaaaaaaaaaaaaaaa";
			const check = accountChangePublisher(bus, () => current);
			check();
			current = "bbbbbbbbbbbbbbbb";
			check();
			check();
			expect(ws.send.mock.calls).toStrictEqual([['{"type":"account.changed","version":"bbbbbbbbbbbbbbbb"}']]);
		});
	});
});
