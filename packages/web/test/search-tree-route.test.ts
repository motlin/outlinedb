import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {nodeTreeHost} from "../src/server/node-host.js";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {z} from "zod";
import {buildServerContext} from "../src/server/context.js";
import {LadderEventBus} from "../src/server/ladder-events.js";
import {defineOp, ok} from "../src/server/ops/define.js";
import {inProcessStore} from "../src/server/store.js";
import * as schema from "@workflowy/shared/db";
import {aiMetadata, mirrors, nodeContent, nodeMetadata, referencesRoots} from "@workflowy/shared/db";
import {FAR_FUTURE_DATE, formatTemporalTimestamp} from "@workflowy/shared/temporal";
import {and, eq} from "drizzle-orm";
import {
	loadTreeRows,
	loadTreeRowsWithBacklinks,
	loadTreeRowText,
	loadTreeSearchRows,
	loadTreeSkeletonRows,
	loadSwitcherSkeleton,
	buildSwitcherSkeleton,
	peekSwitcherSkeleton,
	switcherTextScan,
	queryNeedsBacklinks,
	peekTreeSnapshotBuild,
	peekTreeSnapshotRows,
	scheduleTreeSnapshotRebuild,
	warmTreeSnapshot,
	bindTreeHost,
} from "../src/server/tree-snapshot.js";
import {computeTreeSearch} from "../src/server/tree-search.js";
import {compactSwitcherSkeleton, peekSwitcherText} from "../src/server/switcher-search.js";
import type {ServerContext} from "../src/server/context.js";
import {httpAppFor} from "./http-app-for.js";

const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");
const SEEDED_AT = "2026-01-01 00:00:00.000";
const CREATED = new Date("2026-02-01T00:00:00Z");
const MODIFIED = new Date("2026-03-01T00:00:00Z");
const COMPLETED = new Date("2026-04-01T00:00:00Z");

/*
 * root
 *   a         (todo layout, timestamps)
 *     a1
 *   mirror    (mirror of other; its own stale text is ignored)
 *   refs      (references root, excluded with its children)
 *     bl
 *   deleted   (no longer live)
 * other       (outside root)
 */
const TREE: [id: string, parentId: string | null, name: string][] = [
	["root", null, "Root"],
	["a", "root", "Alpha"],
	["a1", "a", "Alpha child"],
	["mirror", "root", "stale"],
	["refs", "root", ""],
	["bl", "refs", ""],
	["other", null, "Other"],
];

const open: DatabaseConstructor.Database[] = [];
const tempDirs: string[] = [];
afterEach(() => {
	vi.useRealTimers();
	for (const sqlite of open.splice(0)) {
		if (sqlite.open) {
			sqlite.close();
		}
	}
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, {recursive: true, force: true});
	}
});

function tempPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "tree-snapshot-"));
	tempDirs.push(dir);
	return join(dir, "cache.sqlite");
}

function connect(path: string) {
	const sqlite = new DatabaseConstructor(path);
	open.push(sqlite);
	const db = drizzle(sqlite, {schema});
	bindTreeHost(db, nodeTreeHost(sqlite));
	return db;
}

function setup(path = ":memory:") {
	const sqlite = new DatabaseConstructor(path);
	open.push(sqlite);
	const db = drizzle(sqlite, {schema});
	bindTreeHost(db, nodeTreeHost(sqlite));
	migrate(db, {migrationsFolder});
	TREE.forEach(([id, parentId, name], priority) => {
		db.insert(nodeContent)
			.values({
				id,
				name,
				note: id === "other" ? "other note" : null,
				parentId,
				systemFrom: SEEDED_AT,
				systemTo: FAR_FUTURE_DATE,
			})
			.run();
		db.insert(nodeMetadata)
			.values({
				nodeId: id,
				priority,
				createdAt: id === "a" ? CREATED : null,
				modifiedAt: id === "a" ? MODIFIED : null,
				completedAt: id === "a" ? COMPLETED : null,
				layoutMode: id === "a" ? "todo" : null,
				systemFrom: SEEDED_AT,
				systemTo: FAR_FUTURE_DATE,
			})
			.run();
	});
	db.insert(nodeContent)
		.values({id: "deleted", name: "Gone", note: null, parentId: "root", systemFrom: SEEDED_AT, systemTo: SEEDED_AT})
		.run();
	db.insert(referencesRoots).values({nodeId: "refs", systemFrom: SEEDED_AT, systemTo: FAR_FUTURE_DATE}).run();
	db.insert(mirrors)
		.values({mirrorId: "mirror", originalId: "other", systemFrom: SEEDED_AT, systemTo: FAR_FUTURE_DATE})
		.run();
	return db;
}

const NO_META = {createdAt: null, modifiedAt: null, completedAt: null, layoutMode: null};

describe("loadTreeSkeletonRows and loadTreeRowText", () => {
	it("loads the whole-tree search rows without text, and the live text (a mirror's from its original) by id", () => {
		const db = setup();
		expect({
			skeleton: loadTreeSkeletonRows(db),
			text: loadTreeRowText(db, ["mirror", "a", "deleted", "missing"]),
		}).toStrictEqual({
			skeleton: loadTreeSearchRows(db, null).map((row) => ({...row, name: null, note: null})),
			text: new Map([
				["a", {name: "Alpha", note: null}],
				["mirror", {name: "Other", note: "other note"}],
			]),
		});
	});
});

describe("jump-menu search with the tree snapshot off", () => {
	it("answers the switcher and the location picker exactly as the snapshot does", async () => {
		const db = setup();
		const post = async (treeSnapshot: boolean, path: string, body: object) => {
			const ctx = {db, config: {features: {treeSnapshot}}} as unknown as ServerContext;
			const response = await httpAppFor(ctx).fetch(
				new Request(`http://x/api/search/${path}`, {method: "POST", body: JSON.stringify(body)}),
			);
			return (await response.json()) as {results: unknown[]} | {matchIds: unknown[]};
		};
		const requests: [path: string, body: object][] = [
			["switcher", {query: "other"}],
			["switcher", {query: "root > child", showCompleted: true}],
			["switcher", {query: "alpha", showCompleted: true}],
			["locations", {query: "alpha", excludeId: "a1", showCompleted: true}],
			["tree", {query: "alpha", rootId: null}],
			["tree", {query: "root > child", rootId: null}],
			["tree", {query: "is:backlink", rootId: null}],
		];
		const answers = async (treeSnapshot: boolean) =>
			Promise.all(requests.map(async ([path, body]) => post(treeSnapshot, path, body)));
		const paged = await answers(false);
		expect(paged).toStrictEqual(await answers(true));
		const sizes = paged.map((answer) => ("matchIds" in answer ? answer.matchIds : answer.results).length);
		expect(sizes).toStrictEqual([1, 1, 2, 1, 2, 1, 1]);
	});

	it("answers accented, tagged and paged switcher queries exactly as the snapshot does", async () => {
		const db = setup();
		db.update(nodeContent).set({name: "Al<b>pha</b> \u00E9t\u00E9"}).where(eq(nodeContent.id, "a")).run();
		db.update(nodeContent).set({name: "Alpha child ete"}).where(eq(nodeContent.id, "a1")).run();
		const post = async (treeSnapshot: boolean, query: string, extra: object = {}) => {
			const ctx = {db, config: {features: {treeSnapshot}}} as unknown as ServerContext;
			const response = await httpAppFor(ctx).fetch(
				new Request("http://x/api/search/switcher", {
					method: "POST",
					body: JSON.stringify({query, showCompleted: true, ...extra}),
				}),
			);
			return (await response.json()) as {results: {id: string}[]};
		};
		const requests: [string, object][] = [
			["alpha", {}],
			["ete", {}],
			["\u00E9t\u00E9", {}],
			["alpha", {limit: 1}],
			["alpha", {offset: 1}],
			["oth", {}],
		];
		const answers = async (treeSnapshot: boolean) =>
			Promise.all(requests.map(async ([query, extra]) => post(treeSnapshot, query, extra)));
		const paged = await answers(false);
		expect(paged).toStrictEqual(await answers(true));
		expect(paged.map(({results}) => results.map(({id}) => id))).toStrictEqual([
			["a", "a1"],
			["a", "a1"],
			["a", "a1"],
			["a"],
			["a1"],
			["other"],
		]);
	});

	it("keeps the compact switcher skeleton between queries until the database changes", () => {
		const db = setup();
		const first = loadSwitcherSkeleton(db);
		const again = loadSwitcherSkeleton(db);
		db.update(nodeContent).set({name: "Renamed"}).where(eq(nodeContent.id, "a1")).run();
		const afterWrite = loadSwitcherSkeleton(db);
		expect({same: again === first, rebuilt: afterWrite !== first, ids: afterWrite.ids}).toStrictEqual({
			same: true,
			rebuilt: true,
			ids: ["root", "a", "a1", "mirror", "other"],
		});
	});

	it("builds the switcher skeleton from flat rows exactly as from the recursive tree rows", () => {
		const db = setup();
		const add = (id: string, parentId: string | null, priority: number, extra: {completed?: boolean} = {}) => {
			db.insert(nodeContent)
				.values({id, name: id, note: null, parentId, systemFrom: SEEDED_AT, systemTo: FAR_FUTURE_DATE})
				.run();
			db.insert(nodeMetadata)
				.values({
					nodeId: id,
					priority,
					modifiedAt: MODIFIED,
					completedAt: extra.completed === true ? COMPLETED : null,
					systemFrom: SEEDED_AT,
					systemTo: FAR_FUTURE_DATE,
				})
				.run();
		};
		// A backlink item's child hangs at the top; nothing below an `ai.inChat` item is reached; equal priorities keep
		// depth-then-id order; a row under a missing parent is unreachable.
		add("blChild", "bl", 0);
		add("chat", "root", 7);
		add("chatChild", "chat", 0);
		add("tieB", "other", 1);
		add("tieA", "other", 1);
		add("doneParent", "other", 2, {completed: true});
		add("underDone", "doneParent", 0);
		add("orphan", "missing", 0);
		db.insert(aiMetadata)
			.values({nodeId: "chat", inChat: 1, systemFrom: SEEDED_AT, systemTo: FAR_FUTURE_DATE})
			.run();
		// Sizes come from each row's own text; a mirror's is left unsized.
		db.update(nodeContent).set({name: "R<i>oo</i>t #x"}).where(eq(nodeContent.id, "root")).run();
		db.update(nodeContent).set({note: "caf\u00E9"}).where(eq(nodeContent.id, "a1")).run();
		db.update(nodeContent).set({name: "@who &amp; co"}).where(eq(nodeContent.id, "other")).run();
		expect(buildSwitcherSkeleton(db)).toStrictEqual(compactSwitcherSkeleton(loadTreeSearchRows(db, null)));
	});

	it("finds live rows whose raw text holds the LIKE fragment, and reads their own text by id", () => {
		const db = setup();
		db.update(nodeContent).set({name: "R<i>oo</i>t"}).where(eq(nodeContent.id, "root")).run();
		db.update(nodeContent).set({note: "ALPine caf\u00E9"}).where(eq(nodeContent.id, "other")).run();
		const scan = switcherTextScan(db, 2);
		const byId = <T extends {id: string}>(rows: Iterable<T>): T[] =>
			// oxlint-disable-next-line unicorn/no-array-sort -- a fresh copy; the test lib has no toSorted
			[...rows].sort((a, b) => a.id.localeCompare(b.id));
		expect({
			holding: new Set(scan.holding("alp")),
			text: byId(scan.read(["mirror", "a", "deleted"])),
		}).toStrictEqual({
			holding: new Set(["a", "a1", "other"]),
			text: byId([
				{id: "a", name: "Alpha", note: null},
				{id: "mirror", name: "stale", note: null},
			]),
		});
	});

	it("answers the whole-tree helper tags exactly as the snapshot does", async () => {
		const db = setup();
		db.update(nodeContent).set({name: "Alpha #Tag @Pat"}).where(eq(nodeContent.id, "a")).run();
		db.update(nodeContent).set({name: "Alpha child #tag @Pat"}).where(eq(nodeContent.id, "a1")).run();
		const helpers = async (treeSnapshot: boolean) => {
			const ctx = {db, config: {features: {treeSnapshot}}} as unknown as ServerContext;
			const response = await httpAppFor(ctx).fetch(new Request("http://x/api/search/helpers?rootId="));
			return (await response.json()) as unknown;
		};
		const paged = await helpers(false);
		expect(paged).toStrictEqual(await helpers(true));
		expect(paged).toStrictEqual({hashTags: ["#Tag"], atTags: ["@Pat"]});
	});
});

describe("loadTreeSearchRows", () => {
	it("loads the live subtree with metadata, mirror text and no references content", () => {
		expect(new Set(loadTreeSearchRows(setup(), "root"))).toStrictEqual(
			new Set([
				{
					id: "a",
					parentId: "root",
					priority: 1,
					name: "Alpha",
					note: null,
					createdAt: CREATED.getTime(),
					modifiedAt: MODIFIED.getTime(),
					completedAt: COMPLETED.getTime(),
					layoutMode: "todo",
					isMirror: false,
					isBacklink: false,
					fileType: null,
				},
				{
					id: "a1",
					parentId: "a",
					priority: 2,
					name: "Alpha child",
					note: null,
					...NO_META,
					isMirror: false,
					isBacklink: false,
					fileType: null,
				},
				{
					id: "mirror",
					parentId: "root",
					priority: 3,
					name: "Other",
					note: "other note",
					...NO_META,
					isMirror: true,
					isBacklink: false,
					fileType: null,
				},
				{
					id: "root",
					parentId: null,
					priority: 0,
					name: "Root",
					note: null,
					...NO_META,
					isMirror: false,
					isBacklink: false,
					fileType: null,
				},
			]),
		);
	});

	it("reads a mirror's completion from its original and ignores the mirror's own completedAt", () => {
		const db = setup();
		const completionOf = () =>
			loadTreeSearchRows(db, "root").find((row) => row.id === "mirror")?.completedAt ?? null;
		const initial = completionOf();
		rewriteMetadata(db, "mirror", {completedAt: COMPLETED});
		const staleOwn = completionOf();
		rewriteMetadata(db, "other", {completedAt: COMPLETED});
		const originalDone = completionOf();

		expect({initial, staleOwn, originalDone}).toStrictEqual({
			initial: null,
			staleOwn: null,
			originalDone: COMPLETED.getTime(),
		});
	});

	it("loads every live row when rootId is null", () => {
		const ids = loadTreeSearchRows(setup(), null).map((row) => row.id);
		expect(new Set(ids)).toStrictEqual(new Set(["a", "a1", "mirror", "other", "root"]));
	});
});

function insertNode(db: ReturnType<typeof setup>, id: string, parentId: string | null, name: string) {
	db.insert(nodeContent)
		.values({id, name, note: null, parentId, systemFrom: SEEDED_AT, systemTo: FAR_FUTURE_DATE})
		.run();
}

function idSet(rows: {id: string}[]): Set<string> {
	return new Set(rows.map((row) => row.id));
}

let systemMs = Date.parse("2026-05-01T00:00:00Z");

/** A system time later than every one written before it, as the cache's system clock issues them. */
function nextSystemTime(): string {
	systemMs += 1;
	return formatTemporalTimestamp(new Date(systemMs));
}

type Db = ReturnType<typeof setup>;

/** Version a node's content as the cache does: close the live row and open a changed copy. */
function rewriteContent(db: Db, id: string, changes: {name?: string; note?: string | null; parentId?: string | null}) {
	const at = nextSystemTime();
	const live = and(eq(nodeContent.id, id), eq(nodeContent.systemTo, FAR_FUTURE_DATE));
	const current = db.select().from(nodeContent).where(live).get();
	if (current === undefined) {
		throw new Error(`no live content for ${id}`);
	}
	db.update(nodeContent).set({systemTo: at}).where(live).run();
	db.insert(nodeContent)
		.values({...current, ...changes, systemFrom: at, systemTo: FAR_FUTURE_DATE})
		.run();
}

function rewriteMetadata(db: Db, id: string, changes: {priority?: number; completedAt?: Date | null}) {
	const at = nextSystemTime();
	const live = and(eq(nodeMetadata.nodeId, id), eq(nodeMetadata.systemTo, FAR_FUTURE_DATE));
	const current = db.select().from(nodeMetadata).where(live).get();
	if (current === undefined) {
		throw new Error(`no live metadata for ${id}`);
	}
	db.update(nodeMetadata).set({systemTo: at}).where(live).run();
	db.insert(nodeMetadata)
		.values({...current, ...changes, systemFrom: at, systemTo: FAR_FUTURE_DATE})
		.run();
}

function createNode(db: Db, id: string, parentId: string | null, name: string) {
	db.insert(nodeContent)
		.values({id, name, note: null, parentId, systemFrom: nextSystemTime(), systemTo: FAR_FUTURE_DATE})
		.run();
}

function endContent(db: Db, id: string) {
	db.update(nodeContent)
		.set({systemTo: nextSystemTime()})
		.where(and(eq(nodeContent.id, id), eq(nodeContent.systemTo, FAR_FUTURE_DATE)))
		.run();
}

describe("AI chat nodes", () => {
	/** An `ai.inChat` mailbox under root with a message under it, as upstream's AI chat creates. */
	function setupWithChat() {
		const db = setup();
		insertNode(db, "chat", "root", "AI Messages");
		insertNode(db, "message", "chat", "Hello");
		db.insert(aiMetadata)
			.values({nodeId: "chat", inChat: 1, systemFrom: SEEDED_AT, systemTo: FAR_FUTURE_DATE})
			.run();
		return db;
	}

	it("leaves ai.inChat nodes and everything below them out of the search rows, like upstream's inline_search ignore", () => {
		const db = setupWithChat();
		const expected = new Set(["a", "a1", "mirror", "other", "root"]);

		expect({
			sql: idSet(loadTreeSearchRows(db, null)),
			snapshot: idSet(loadTreeRows(db, null)),
			subtree: idSet(loadTreeRows(db, "root")),
		}).toStrictEqual({sql: expected, snapshot: expected, subtree: new Set(["a", "a1", "mirror", "root"])});
	});
});

describe("loadTreeRows", () => {
	it("answers the same rows as loadTreeSearchRows for the whole tree and for a subtree", () => {
		const db = setup();
		expect(loadTreeRows(db, null)).toStrictEqual(loadTreeSearchRows(db, null));
		expect(new Set(loadTreeRows(db, "root"))).toStrictEqual(new Set(loadTreeSearchRows(db, "root")));
		expect(idSet(loadTreeRows(db, "a"))).toStrictEqual(new Set(["a", "a1"]));
		expect(idSet(loadTreeRows(db, "refs"))).toStrictEqual(idSet(loadTreeSearchRows(db, "refs")));
		expect(loadTreeRows(db, "missing")).toStrictEqual([]);
	});

	it("warms the jump-menu text of every row when it warms the snapshot", () => {
		const db = setup();
		warmTreeSnapshot(db);
		const rows = peekTreeSnapshotRows(db) ?? [];
		expect(rows.filter((row) => peekSwitcherText(row)?.fields === undefined)).toStrictEqual([]);
	});

	it("reuses one snapshot while the database is unchanged", () => {
		const db = setup();
		const first = loadTreeRows(db, null);
		expect(loadTreeRows(db, null)).toBe(first);
		expect(loadTreeRows(db, "root")[0]).toBe(first.find((row) => row.id === "root"));
	});

	it("reloads after a write on the same connection", () => {
		const db = setup();
		const first = loadTreeRows(db, null);
		insertNode(db, "new", "root", "New");
		const second = loadTreeRows(db, null);
		expect(second).not.toBe(first);
		expect(idSet(second)).toStrictEqual(new Set(["a", "a1", "mirror", "new", "other", "root"]));
	});

	it("keeps unchanged row objects across a reload so their derived search text stays cached", () => {
		const db = setup();
		const first = loadTreeRows(db, null);
		rewriteContent(db, "a", {name: "Alpha renamed"});
		const second = loadTreeRows(db, null);
		const byId = (rows: typeof first, id: string) => rows.find((row) => row.id === id);
		expect(byId(second, "a1")).toBe(byId(first, "a1"));
		expect(byId(second, "a")).not.toBe(byId(first, "a"));
		expect(byId(second, "a")?.name).toBe("Alpha renamed");
	});

	it("serves the previous snapshot after another connection writes and rebuilds it 500ms later off the request path", () => {
		vi.useFakeTimers();
		const path = tempPath();
		const db = setup(path);
		const first = loadTreeRows(db, null);
		insertNode(connect(path), "new", "root", "New");
		expect(loadTreeRows(db, null)).toBe(first);
		vi.advanceTimersByTime(499);
		expect(loadTreeRows(db, null)).toBe(first);
		vi.advanceTimersByTime(1);
		expect(idSet(loadTreeRows(db, null))).toStrictEqual(new Set(["a", "a1", "mirror", "new", "other", "root"]));
	});

	it("debounces scheduled rebuilds to 500ms after the last write", () => {
		vi.useFakeTimers();
		const path = tempPath();
		const db = setup(path);
		const first = loadTreeRows(db, null);
		const other = connect(path);
		insertNode(other, "new", "root", "New");
		scheduleTreeSnapshotRebuild(db);
		vi.advanceTimersByTime(300);
		insertNode(other, "newer", "root", "Newer");
		scheduleTreeSnapshotRebuild(db);
		vi.advanceTimersByTime(300);
		expect(loadTreeRows(db, null)).toBe(first);
		vi.advanceTimersByTime(200);
		expect(idSet(loadTreeRows(db, null))).toStrictEqual(
			new Set(["a", "a1", "mirror", "new", "newer", "other", "root"]),
		);
	});

	it("warms the snapshot before the first request", () => {
		vi.useFakeTimers();
		const path = tempPath();
		const db = setup(path);
		warmTreeSnapshot(db);
		insertNode(connect(path), "new", "root", "New");
		expect(idSet(loadTreeRows(db, null))).toStrictEqual(new Set(["a", "a1", "mirror", "other", "root"]));
	});

	it("schedules a rebuild after an op that wrote, not after one that only read", async () => {
		vi.useFakeTimers();
		const path = tempPath();
		const db = setup(path);
		const other = connect(path);
		const store = inProcessStore(
			buildServerContext({
				db,
				config: {
					accountEmail: "",
					sqlQueryLogging: false,
					calendarEnsureEnabled: false,
					calendarLayoutEnabled: false,
					features: {embeddings: false, treeSnapshot: true},
				},
				ladderEvents: new LadderEventBus(),
			}),
			{
				read: defineOp({input: z.object({}), output: z.number(), run: () => ok(loadTreeRows(db, null).length)}),
				write: defineOp({
					input: z.object({}),
					output: z.null(),
					run: () => {
						insertNode(db, "mine", "root", "Mine");
						return ok(null);
					},
				}),
			},
			{keepSnapshotWarm: true},
		);
		const first = loadTreeRows(db, null);
		insertNode(other, "theirs", "root", "Theirs");
		await store.call("read" as never, {} as never);
		vi.advanceTimersByTime(400);
		await store.call("write" as never, {} as never);
		vi.advanceTimersByTime(400);
		expect(peekTreeSnapshotRows(db)).toBe(first);
		vi.advanceTimersByTime(100);
		expect(idSet(peekTreeSnapshotRows(db) ?? [])).toStrictEqual(
			new Set(["a", "a1", "mine", "mirror", "other", "root", "theirs"]),
		);
	});

	it("rebuilds a held switcher skeleton in the background after an op that wrote, never a skeleton not yet held", async () => {
		vi.useFakeTimers();
		const db = setup();
		const store = inProcessStore(
			buildServerContext({
				db,
				config: {
					accountEmail: "",
					sqlQueryLogging: false,
					calendarEnsureEnabled: false,
					calendarLayoutEnabled: false,
					features: {embeddings: false, treeSnapshot: false},
				},
				ladderEvents: new LadderEventBus(),
			}),
			{
				write: defineOp({
					input: z.object({id: z.string()}),
					output: z.null(),
					run: (_ctx, {id}) => {
						insertNode(db, id, "root", id);
						return ok(null);
					},
				}),
			},
			{keepSwitcherSkeletonWarm: true},
		);
		await store.call("write" as never, {id: "cold"} as never);
		vi.advanceTimersByTime(500);
		const unheld = peekSwitcherSkeleton(db);
		const first = loadSwitcherSkeleton(db);
		await store.call("write" as never, {id: "warm"} as never);
		vi.advanceTimersByTime(400);
		const pending = peekSwitcherSkeleton(db);
		vi.advanceTimersByTime(100);
		const rebuilt = peekSwitcherSkeleton(db);
		expect({
			unheld,
			pendingIsFirst: pending === first,
			rebuiltIds: rebuilt?.ids,
			servedFromCache: loadSwitcherSkeleton(db) === rebuilt,
		}).toStrictEqual({
			unheld: undefined,
			pendingIsFirst: true,
			rebuiltIds: ["root", "cold", "warm", "a", "a1", "mirror", "other"],
			servedFromCache: true,
		});
	});

	it("skips a scheduled rebuild once the database is closed", () => {
		vi.useFakeTimers();
		const db = setup();
		loadTreeRows(db, null);
		insertNode(db, "new", "root", "New");
		scheduleTreeSnapshotRebuild(db);
		db.$client.close();
		expect(() => vi.advanceTimersByTime(500)).not.toThrow();
	});
});

describe("incremental snapshot patches", () => {
	it("patches every kind of write into the same rows, in the same order, as a full rebuild", () => {
		const db = setup();
		loadTreeRows(db, null);
		expect(peekTreeSnapshotBuild(db)).toBe("full");
		const writes: [step: string, write: () => unknown][] = [
			[
				"rename",
				() => {
					rewriteContent(db, "a", {name: "Alpha #renamed"});
				},
			],
			[
				"edit note",
				() => {
					rewriteContent(db, "a1", {note: "a note"});
				},
			],
			[
				"complete",
				() => {
					rewriteMetadata(db, "a1", {completedAt: COMPLETED});
				},
			],
			[
				"reorder",
				() => {
					rewriteMetadata(db, "a", {priority: 9});
				},
			],
			[
				"create",
				() => {
					createNode(db, "b", "a1", "Beta");
				},
			],
			[
				"create under the new node",
				() => {
					createNode(db, "b1", "b", "Beta child");
				},
			],
			[
				"create top-level",
				() => {
					createNode(db, "top", null, "Top");
				},
			],
			[
				"move a subtree",
				() => {
					rewriteContent(db, "a", {parentId: "other"});
				},
			],
			[
				"move under a new node",
				() => {
					rewriteContent(db, "a1", {parentId: "top"});
				},
			],
			[
				"rename a mirror's original",
				() => {
					rewriteContent(db, "other", {name: "Other renamed"});
				},
			],
			[
				"unmirror",
				() => db.update(mirrors).set({systemTo: nextSystemTime()}).where(eq(mirrors.mirrorId, "mirror")).run(),
			],
			[
				"mirror again",
				() =>
					db
						.insert(mirrors)
						.values({
							mirrorId: "mirror",
							originalId: "top",
							systemFrom: nextSystemTime(),
							systemTo: FAR_FUTURE_DATE,
						})
						.run(),
			],
			[
				"make a references root",
				() =>
					db
						.insert(referencesRoots)
						.values({nodeId: "top", systemFrom: nextSystemTime(), systemTo: FAR_FUTURE_DATE})
						.run(),
			],
			[
				"end a references root",
				() =>
					db
						.update(referencesRoots)
						.set({systemTo: nextSystemTime()})
						.where(eq(referencesRoots.nodeId, "refs"))
						.run(),
			],
			[
				"delete a parent, cutting off its children",
				() => {
					endContent(db, "top");
				},
			],
			[
				"restore the parent",
				() => {
					createNode(db, "top", "root", "Top again");
				},
			],
			[
				"delete a leaf",
				() => {
					endContent(db, "b1");
				},
			],
			[
				"put a node in an AI chat, past the change lookback of its last content write",
				() => {
					systemMs += 60_000;
					db.insert(aiMetadata)
						.values({nodeId: "top", inChat: 1, systemFrom: nextSystemTime(), systemTo: FAR_FUTURE_DATE})
						.run();
				},
			],
			[
				"move a subtree under the AI chat node",
				() => {
					rewriteContent(db, "other", {parentId: "top"});
				},
			],
			[
				"create under the AI chat node",
				() => {
					createNode(db, "chat-child", "top", "Chat child");
				},
			],
			[
				"take the node out of the AI chat",
				() => {
					systemMs += 60_000;
					db.update(aiMetadata).set({systemTo: nextSystemTime()}).where(eq(aiMetadata.nodeId, "top")).run();
				},
			],
		];
		for (const [step, write] of writes) {
			write();
			expect({step, rows: loadTreeRows(db, null)}).toStrictEqual({step, rows: loadTreeSearchRows(db, null)});
			expect({step, build: peekTreeSnapshotBuild(db)}).toStrictEqual({step, build: "patch"});
			for (const rootId of ["root", "a", "top", "other"]) {
				expect({step, rootId, rows: idSet(loadTreeRows(db, rootId))}).toStrictEqual({
					step,
					rootId,
					rows: idSet(loadTreeSearchRows(db, rootId)),
				});
			}
		}
	});

	it("keeps the rows array when a write changes nothing the snapshot holds", () => {
		const db = setup();
		const first = loadTreeRows(db, null);
		rewriteMetadata(db, "a", {});
		expect(loadTreeRows(db, null)).toBe(first);
		expect(peekTreeSnapshotBuild(db)).toBe("patch");
	});

	it("falls back to a full rebuild when a write burst changes too many rows", () => {
		const db = setup();
		loadTreeRows(db, null);
		db.$client.transaction(() => {
			for (let index = 0; index < 1001; index++) {
				createNode(db, `bulk-${index}`, "root", `Bulk ${index}`);
			}
		})();
		expect(loadTreeRows(db, null)).toStrictEqual(loadTreeSearchRows(db, null));
		expect(peekTreeSnapshotBuild(db)).toBe("full");
	});
});

describe("backlink search", () => {
	/** root > refs (references root) > bl, a backlink item mirroring "a" ("Alpha"). */
	function setupWithBacklink() {
		const db = setup();
		db.insert(mirrors)
			.values({mirrorId: "bl", originalId: "a", systemFrom: SEEDED_AT, systemTo: FAR_FUTURE_DATE})
			.run();
		return db;
	}

	it("is:backlink matches the backlink item as a meta match and reveals the references root as an ancestor", () => {
		const db = setupWithBacklink();

		const result = computeTreeSearch(loadTreeRowsWithBacklinks(db, "root"), "root", "is:backlink", 0);

		expect({
			matchIds: result.matchIds,
			metaMatchIds: result.metaMatchIds,
			ancestorIds: result.ancestorIds,
		}).toStrictEqual({matchIds: ["bl"], metaMatchIds: ["bl"], ancestorIds: ["refs"]});
	});

	it('in:backlink:"Alp" matches the backlink item by its source text, not the source itself', () => {
		const db = setupWithBacklink();

		const result = computeTreeSearch(loadTreeRowsWithBacklinks(db, "root"), "root", 'in:backlink:"Alp"', 0);

		expect({matchIds: result.matchIds, nameMatchIds: result.nameMatchIds}).toStrictEqual({
			matchIds: ["bl"],
			nameMatchIds: ["bl"],
		});
	});

	it("a plain query never returns the backlink item", () => {
		const db = setupWithBacklink();

		const result = computeTreeSearch(loadTreeRows(db, "root"), "root", "Alpha", 0);

		expect(result.matchIds).toStrictEqual(["a", "a1"]);
	});

	it("only queries naming a backlink operator load backlink rows", () => {
		expect([
			queryNeedsBacklinks("Alpha"),
			queryNeedsBacklinks("x is:backlink"),
			queryNeedsBacklinks('in:backlink:"a"'),
		]).toStrictEqual([false, true, true]);
	});
});
