import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {join} from "node:path";
import {afterEach, assert, describe, expect, it, vi} from "vite-plus/test";
import {applyApiBatch, beginApiImport, finishApiImport, importFromApi} from "../src/cache/api-import.js";
import {BULK_IMPORT_LEASE_NAME} from "../src/cache/bulk-import.js";
import {CacheService} from "../src/cache/cache-service.js";
import {BULK_IMPORT_TIMEOUT_MS, TRANSACTION_TIMEOUT_MS, TransactionTimeoutError} from "../src/cache/system-time.js";
import * as schema from "../src/db/schema.js";
import {FAR_FUTURE_DATE} from "../src/temporal/index.js";
import type {WorkflowyNode} from "../src/types/index.js";

const migrationsFolder = join(import.meta.dirname, "../src/db/migrations");
const T0 = new Date("2026-03-01T00:00:00.000Z");
const T1 = new Date("2026-03-02T00:00:00.000Z");

function apiNode(id: string, overrides: Partial<WorkflowyNode> = {}): WorkflowyNode {
	return {
		id,
		name: `Name ${id}`,
		note: null,
		parent_id: null,
		priority: 0,
		completed: false,
		createdAt: 1_700_000_000,
		modifiedAt: 1_700_000_100,
		completedAt: null,
		data: {layoutMode: "bullets"},
		...overrides,
	};
}

const FIXTURE: WorkflowyNode[] = [
	apiNode("a", {priority: 0}),
	apiNode("b", {parent_id: "a", priority: 1, note: "a note"}),
	apiNode("c", {parent_id: "a", priority: 2}),
	apiNode("d", {parent_id: "b", priority: 3}),
	apiNode("e", {priority: 4, completedAt: 1_700_000_200}),
	apiNode("f", {parent_id: "e", priority: 5}),
	apiNode("g", {priority: 6}),
];

describe("shared API import", () => {
	const open: DatabaseConstructor.Database[] = [];

	function createDb() {
		const sqlite = new DatabaseConstructor(":memory:");
		open.push(sqlite);
		const db = drizzle(sqlite, {schema});
		migrate(db, {migrationsFolder});
		return db;
	}

	function snapshot(db: ReturnType<typeof createDb>) {
		return {
			content: db
				.select()
				.from(schema.nodeContent)
				.all()
				.toSorted((x, y) => x.id.localeCompare(y.id)),
			metadata: db
				.select()
				.from(schema.nodeMetadata)
				.all()
				.toSorted((x, y) => x.nodeId.localeCompare(y.nodeId)),
		};
	}

	afterEach(() => {
		vi.useRealTimers();
		for (const sqlite of open.splice(0)) {
			sqlite.close();
		}
	});

	describe("one-shot import as a bulk unit of work", () => {
		/** A database whose clock moves `tick` ms on every node_content insert, so a merge's length grows with its size. */
		function slowDb(tick: number) {
			const db = createDb();
			const sqlite = open.at(-1);
			assert(sqlite !== undefined);
			sqlite.function("advance_clock", () => {
				vi.setSystemTime(Date.now() + tick);
				return 0;
			});
			sqlite.exec(
				"CREATE TEMP TRIGGER advance_clock_on_insert AFTER INSERT ON node_content BEGIN SELECT advance_clock(); END",
			);
			return {
				db,
				stampsAndLeases: () => ({
					stamps: sqlite
						.prepare(
							"SELECT system_from AS systemFrom, count(*) AS rows FROM node_content WHERE system_to = ? GROUP BY system_from",
						)
						.all(FAR_FUTURE_DATE),
					openLeases: sqlite
						.prepare("SELECT count(*) AS open FROM api_import_timestamp WHERE name = ? AND system_to = ?")
						.get(BULK_IMPORT_LEASE_NAME, FAR_FUTURE_DATE),
				}),
			};
		}

		it("commits an import that outlasts the transaction timeout under one system time", () => {
			vi.useFakeTimers({toFake: ["Date"], now: T0});
			const {db, stampsAndLeases} = slowDb(TRANSACTION_TIMEOUT_MS / 2);

			const result = importFromApi(db, FIXTURE);

			expect({importTimestamp: result.importTimestamp, ...stampsAndLeases()}).toStrictEqual({
				importTimestamp: T0,
				stamps: [{systemFrom: "2026-03-01 00:00:00.000", rows: FIXTURE.length}],
				openLeases: {open: 0},
			});
		});

		it("commits nothing when the import outlasts the bulk import timeout", () => {
			vi.useFakeTimers({toFake: ["Date"], now: T0});
			const {db, stampsAndLeases} = slowDb(BULK_IMPORT_TIMEOUT_MS / 2);

			expect(() => importFromApi(db, FIXTURE)).toThrow(
				new TransactionTimeoutError(
					"2026-03-01 00:00:00.000",
					FIXTURE.length * (BULK_IMPORT_TIMEOUT_MS / 2),
					BULK_IMPORT_TIMEOUT_MS,
				),
			);

			expect(stampsAndLeases()).toStrictEqual({stamps: [], openLeases: {open: 0}});
		});
	});

	it("importing a 3-batch split gives the same rows as the one-shot import", () => {
		const oneShot = createDb();
		importFromApi(oneShot, FIXTURE, {timestamp: T0});

		const batched = createDb();
		const state = beginApiImport(batched, {timestamp: T0});
		applyApiBatch(state, FIXTURE.slice(0, 3));
		applyApiBatch(state, FIXTURE.slice(3, 5));
		applyApiBatch(state, FIXTURE.slice(5));
		const result = finishApiImport(state);

		expect(snapshot(batched)).toStrictEqual(snapshot(oneShot));
		expect({
			totalNodes: result.totalNodes,
			nodesAdded: result.nodesAdded,
			nodesUpdated: result.nodesUpdated,
			nodesUnchanged: result.nodesUnchanged,
			nodesDeleted: result.nodesDeleted,
		}).toStrictEqual({totalNodes: 7, nodesAdded: 7, nodesUpdated: 0, nodesUnchanged: 0, nodesDeleted: 0});
	});

	it("phases out nodes absent from every batch", () => {
		const db = createDb();
		importFromApi(db, FIXTURE, {timestamp: T0});

		const state = beginApiImport(db, {timestamp: T1});
		applyApiBatch(state, FIXTURE.slice(0, 4));
		applyApiBatch(state, FIXTURE.slice(4, 6));
		const result = finishApiImport(state);

		const current = db
			.select()
			.from(schema.nodeContent)
			.all()
			.filter((row) => row.systemTo === FAR_FUTURE_DATE)
			.map((row) => row.id)
			.toSorted();
		expect({current, nodesDeleted: result.nodesDeleted, nodesPhasedOut: result.nodesPhasedOut}).toStrictEqual({
			current: ["a", "b", "c", "d", "e", "f"],
			nodesDeleted: 1,
			nodesPhasedOut: 1,
		});
	});

	it("keeps a node that fails schema validation live instead of treating it as deleted", () => {
		const db = createDb();
		importFromApi(db, FIXTURE, {timestamp: T0});

		const withUnknownField = {...apiNode("g", {priority: 6}), color: "red"} as WorkflowyNode;
		const result = importFromApi(db, [...FIXTURE.slice(0, 6), withUnknownField], {timestamp: T1});

		const current = db
			.select()
			.from(schema.nodeContent)
			.all()
			.filter((row) => row.systemTo === FAR_FUTURE_DATE)
			.map((row) => row.id)
			.toSorted();
		expect({current, nodesDeleted: result.nodesDeleted, nodesPhasedOut: result.nodesPhasedOut}).toStrictEqual({
			current: ["a", "b", "c", "d", "e", "f", "g"],
			nodesDeleted: 0,
			nodesPhasedOut: 0,
		});
	});

	describe("rows written after the snapshot was taken", () => {
		const SNAPSHOT_TAKEN = new Date("2026-03-01T12:00:00.000Z");
		const WRITTEN_AFTER = new Date("2026-03-01T13:00:00.000Z");

		function liveContent(db: ReturnType<typeof createDb>) {
			return db
				.select()
				.from(schema.nodeContent)
				.all()
				.filter((row) => row.systemTo === FAR_FUTURE_DATE)
				.map((row) => ({id: row.id, name: row.name}))
				.toSorted((x, y) => x.id.localeCompare(y.id));
		}

		function invertedIntervals(db: ReturnType<typeof createDb>) {
			return [
				...db.select().from(schema.nodeContent).all(),
				...db.select().from(schema.nodeMetadata).all(),
			].filter((row) => row.systemTo < row.systemFrom);
		}

		function writeAfterSnapshot(db: ReturnType<typeof createDb>) {
			vi.useFakeTimers({toFake: ["Date"], now: T0});
			importFromApi(db, FIXTURE, {timestamp: T0});
			vi.setSystemTime(WRITTEN_AFTER);
			const cache = new CacheService(db);
			cache.insertNode(apiNode("h", {parent_id: "a", priority: 7}), "a");
			cache.insertNode(apiNode("b", {parent_id: "a", priority: 1, note: "a note", name: "Edited"}), "a");
			cache.deleteNode("g");
			vi.setSystemTime(T1);
		}

		it("keeps nodes created, edited or deleted after the snapshot as the later write left them", () => {
			const db = createDb();
			writeAfterSnapshot(db);

			const state = beginApiImport(db, {timestamp: T1, snapshotTakenAt: SNAPSHOT_TAKEN});
			applyApiBatch(state, FIXTURE.slice(0, 4));
			applyApiBatch(state, FIXTURE.slice(4));
			const result = finishApiImport(state);

			expect({
				live: liveContent(db),
				inverted: invertedIntervals(db),
				nodesDeleted: result.nodesDeleted,
				nodesAdded: result.nodesAdded,
				nodesUpdated: result.nodesUpdated,
			}).toStrictEqual({
				live: [
					{id: "a", name: "Name a"},
					{id: "b", name: "Edited"},
					{id: "c", name: "Name c"},
					{id: "d", name: "Name d"},
					{id: "e", name: "Name e"},
					{id: "f", name: "Name f"},
					{id: "h", name: "Name h"},
				],
				inverted: [],
				nodesDeleted: 0,
				nodesAdded: 0,
				nodesUpdated: 0,
			});
		});

		it("guards the one-shot import too", () => {
			const db = createDb();
			writeAfterSnapshot(db);

			importFromApi(db, FIXTURE, {timestamp: T1, snapshotTakenAt: SNAPSHOT_TAKEN});

			expect(liveContent(db).map((row) => row.id)).toStrictEqual(["a", "b", "c", "d", "e", "f", "h"]);
		});

		it("still applies the snapshot over rows written before it was taken", () => {
			const db = createDb();
			writeAfterSnapshot(db);

			importFromApi(db, FIXTURE, {timestamp: T1, snapshotTakenAt: T1});

			expect(liveContent(db).map((row) => `${row.id}:${row.name}`)).toStrictEqual([
				"a:Name a",
				"b:Name b",
				"c:Name c",
				"d:Name d",
				"e:Name e",
				"f:Name f",
				"g:Name g",
			]);
		});
	});

	it("does not phase out a node in an earlier batch when a later batch is applied", () => {
		const db = createDb();
		const state = beginApiImport(db, {timestamp: T0});
		applyApiBatch(state, FIXTURE.slice(0, 2));
		applyApiBatch(state, FIXTURE.slice(2, 4));
		const ids = db
			.select()
			.from(schema.nodeContent)
			.all()
			.map((row) => row.id)
			.toSorted();
		expect(ids).toStrictEqual(["a", "b", "c", "d"]);
	});

	it("reports no changes when re-run with no changes", () => {
		const db = createDb();
		importFromApi(db, FIXTURE, {timestamp: T0});

		const state = beginApiImport(db, {timestamp: T1});
		applyApiBatch(state, FIXTURE.slice(0, 3));
		applyApiBatch(state, FIXTURE.slice(3));
		const result = finishApiImport(state);

		expect({
			nodesAdded: result.nodesAdded,
			nodesUpdated: result.nodesUpdated,
			nodesDeleted: result.nodesDeleted,
			nodesUnchanged: result.nodesUnchanged,
		}).toStrictEqual({nodesAdded: 0, nodesUpdated: 0, nodesDeleted: 0, nodesUnchanged: 7});
		expect(snapshot(db).content).toHaveLength(7);
	});

	describe("sibling priority numbering schemes", () => {
		// Backup imports number siblings 0,100,200 while REST numbers them 0,1,2 for the
		// same order; re-importing one scheme over the other must not open versions.
		const parent = apiNode("p", {priority: 0});
		const backupScheme = [
			parent,
			apiNode("x", {parent_id: "p", priority: 0}),
			apiNode("y", {parent_id: "p", priority: 100}),
			apiNode("z", {parent_id: "p", priority: 200}),
		];
		const restScheme = [
			parent,
			apiNode("x", {parent_id: "p", priority: 0}),
			apiNode("y", {parent_id: "p", priority: 1}),
			apiNode("z", {parent_id: "p", priority: 2}),
		];

		function priorities(db: ReturnType<typeof createDb>) {
			return db
				.select()
				.from(schema.nodeMetadata)
				.all()
				.filter((row) => row.systemTo === FAR_FUTURE_DATE && row.nodeId !== "p")
				.toSorted((x, y) => x.nodeId.localeCompare(y.nodeId))
				.map((row) => [row.nodeId, row.priority]);
		}

		function versionCount(db: ReturnType<typeof createDb>) {
			return db.select().from(schema.nodeMetadata).all().length;
		}

		it("opens no version when the same sibling order arrives in another numbering", () => {
			const db = createDb();
			importFromApi(db, backupScheme, {timestamp: T0});
			const result = importFromApi(db, restScheme, {timestamp: T1});

			expect({
				versions: versionCount(db),
				priorities: priorities(db),
				metadataUpdated: result.metadataUpdated,
			}).toStrictEqual({
				versions: 4,
				priorities: [
					["x", 0],
					["y", 100],
					["z", 200],
				],
				metadataUpdated: 0,
			});
		});

		it("opens no version going the other way either", () => {
			const db = createDb();
			importFromApi(db, restScheme, {timestamp: T0});
			importFromApi(db, backupScheme, {timestamp: T1});

			expect(versionCount(db)).toBe(4);
		});

		it("takes the incoming numbers when the sibling order really changed", () => {
			const db = createDb();
			importFromApi(db, backupScheme, {timestamp: T0});
			importFromApi(
				db,
				[
					parent,
					apiNode("x", {parent_id: "p", priority: 2}),
					apiNode("y", {parent_id: "p", priority: 0}),
					apiNode("z", {parent_id: "p", priority: 1}),
				],
				{timestamp: T1},
			);

			expect(priorities(db)).toStrictEqual([
				["x", 2],
				["y", 0],
				["z", 1],
			]);
		});

		it("takes the incoming numbers when a sibling is new", () => {
			const db = createDb();
			importFromApi(db, backupScheme, {timestamp: T0});
			importFromApi(db, [...restScheme, apiNode("n", {parent_id: "p", priority: 3})], {timestamp: T1});

			expect(priorities(db)).toStrictEqual([
				["n", 3],
				["x", 0],
				["y", 1],
				["z", 2],
			]);
		});
	});

	describe("one-second timestamp skew between REST and the internal API", () => {
		// Modeled on a real node: the internal/backup integer second is the floor of
		// Workflowy's fractional time, REST is its ceiling, so the two sources disagree
		// by exactly one second on about a quarter of timestamps.
		const SKEW_NODE = "00000000-0000-0000-0000-00000000s1ew";
		const floorSide = {createdAt: 1_740_838_291, modifiedAt: 1_758_565_383, completedAt: 1_758_565_380};
		const ceilSide = {createdAt: 1_740_838_292, modifiedAt: 1_758_565_384, completedAt: 1_758_565_381};

		function metadataVersions(db: ReturnType<typeof createDb>) {
			return db
				.select()
				.from(schema.nodeMetadata)
				.all()
				.filter((row) => row.nodeId === SKEW_NODE)
				.toSorted((x, y) => x.systemFrom.localeCompare(y.systemFrom))
				.map((row) => ({
					priority: row.priority,
					createdAt: row.createdAt?.getTime() ?? null,
					modifiedAt: row.modifiedAt?.getTime() ?? null,
					completedAt: row.completedAt?.getTime() ?? null,
					open: row.systemTo === FAR_FUTURE_DATE,
				}));
		}

		it("opens no new version when only the timestamps differ by one second", () => {
			const db = createDb();
			importFromApi(db, [apiNode(SKEW_NODE, {name: "Placeholder", ...ceilSide})], {timestamp: T0});
			importFromApi(db, [apiNode(SKEW_NODE, {name: "Placeholder", ...floorSide})], {timestamp: T1});

			expect(metadataVersions(db)).toStrictEqual([
				{
					priority: 0,
					createdAt: ceilSide.createdAt * 1000,
					modifiedAt: ceilSide.modifiedAt * 1000,
					completedAt: ceilSide.completedAt * 1000,
					open: true,
				},
			]);
		});

		it("keeps the existing timestamps when a real change opens a new version", () => {
			const db = createDb();
			importFromApi(db, [apiNode(SKEW_NODE, {name: "Placeholder", ...ceilSide})], {timestamp: T0});
			importFromApi(db, [apiNode(SKEW_NODE, {name: "Placeholder", data: {layoutMode: "todo"}, ...floorSide})], {
				timestamp: T1,
			});

			const kept = {
				createdAt: ceilSide.createdAt * 1000,
				modifiedAt: ceilSide.modifiedAt * 1000,
				completedAt: ceilSide.completedAt * 1000,
			};
			expect(metadataVersions(db)).toStrictEqual([
				{priority: 0, ...kept, open: false},
				{priority: 0, ...kept, open: true},
			]);
		});

		it("takes the incoming timestamp when it moved by more than one second", () => {
			const db = createDb();
			importFromApi(db, [apiNode(SKEW_NODE, {name: "Placeholder", ...ceilSide})], {timestamp: T0});
			importFromApi(
				db,
				[
					apiNode(SKEW_NODE, {
						name: "Placeholder",
						data: {layoutMode: "todo"},
						...floorSide,
						modifiedAt: 1_758_565_500,
					}),
				],
				{timestamp: T1},
			);

			expect(metadataVersions(db).at(-1)).toStrictEqual({
				priority: 0,
				createdAt: ceilSide.createdAt * 1000,
				modifiedAt: 1_758_565_500_000,
				completedAt: ceilSide.completedAt * 1000,
				open: true,
			});
		});

		it("keeps the existing timestamps when the write-through cache stores a changed child list", () => {
			vi.useFakeTimers({toFake: ["Date"], now: T0});
			const db = createDb();
			const cache = new CacheService(db);
			cache.storeApiResponse([apiNode(SKEW_NODE, {name: "Placeholder", priority: 0, ...ceilSide})], null);
			vi.setSystemTime(T1);
			cache.storeApiResponse([apiNode(SKEW_NODE, {name: "Placeholder", priority: 100, ...floorSide})], null);

			const kept = {
				createdAt: ceilSide.createdAt * 1000,
				modifiedAt: ceilSide.modifiedAt * 1000,
				completedAt: ceilSide.completedAt * 1000,
			};
			expect(metadataVersions(db)).toStrictEqual([
				{priority: 0, ...kept, open: false},
				{priority: 100, ...kept, open: true},
			]);
		});
	});
});
