import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {join} from "node:path";
import {afterEach, describe, expect, it} from "vite-plus/test";
import {WorkflowyInternalClient} from "../src/api/workflowy-internal-client.js";
import type {InternalTreeItem} from "../src/api/workflowy-internal-client.js";
import {importInternalMetadata, keptInternalMetadata, readInternalMetadata} from "../src/cache/internal-metadata.js";
import {readTreeTxId} from "../src/cache/tree-transaction.js";
import {readImportTime} from "../src/cache/account-store.js";
import {readExpansion} from "../src/cache/expansion-store.js";
import * as schema from "../src/db/schema.js";
import {FAR_FUTURE_DATE} from "../src/temporal/index.js";
import {createFakeInternalApi, json} from "./helpers/fake-internal-api.js";

const migrationsFolder = join(import.meta.dirname, "../src/db/migrations");
const FETCHED_AT = 1_800_000_000_000;

/** A whole-tree snapshot holding `items`, as `getTreeSnapshot` returns it. */
function snapshot(items: InternalTreeItem[], txId = "9999", expandedKeys: string[] = []) {
	return {items, txId, expandedKeys};
}

const CALENDAR = {root: true, levels: {day: true, week: false, month: true, year: true}};

function setup(cachedIds: string[]) {
	const sqlite = new DatabaseConstructor(":memory:");
	const db = drizzle(sqlite, {schema});
	migrate(db, {migrationsFolder});
	for (const id of cachedIds) {
		db.insert(schema.nodeContent)
			.values({
				id,
				name: id,
				note: null,
				parentId: null,
				systemFrom: "2026-01-01 00:00:00",
				systemTo: FAR_FUTURE_DATE,
			})
			.run();
		db.insert(schema.nodeMetadata)
			.values({nodeId: id, systemFrom: "2026-01-01 00:00:00", systemTo: FAR_FUTURE_DATE})
			.run();
	}
	const rows = () =>
		[...readInternalMetadata(db, [...cachedIds, "missing"])]
			.map(([nodeId, metadata]) => ({nodeId, metadata}))
			.toSorted((a, b) => a.nodeId.localeCompare(b.nodeId));
	const content = () => db.select().from(schema.nodeContent).all();
	const metadataRows = () =>
		db
			.select()
			.from(schema.nodeMetadata)
			.all()
			.map(({nodeId, layoutMode, systemFrom, systemTo}) => ({nodeId, layoutMode, systemFrom, systemTo}));
	return {sqlite, db, rows, content, metadataRows};
}

describe("importInternalMetadata", () => {
	let open: DatabaseConstructor.Database[] = [];
	afterEach(() => {
		for (const sqlite of open) {
			sqlite.close();
		}
		open = [];
	});

	function tracked(cachedIds: string[]) {
		const context = setup(cachedIds);
		open.push(context.sqlite);
		return context;
	}

	it("writes the kept metadata keys for cached nodes, skips uncached ones, and leaves node rows untouched", () => {
		const {db, rows, content} = tracked(["a", "b", "c"]);
		const contentBefore = content();

		const result = importInternalMetadata(
			db,
			snapshot([
				{id: "a", metadata: {numbered_start: 5, layoutMode: "numbered", mirror: {originalId: "z"}}},
				{id: "b", metadata: {calendar: CALENDAR, priority: {defaultToBottom: true, other: 1}}},
				{id: "c", metadata: {}},
				{id: "c2"},
				{id: "missing", metadata: {numbered_start: 2}},
			]),
			FETCHED_AT,
		);

		expect({result, rows: rows(), content: content()}).toStrictEqual({
			result: {written: 2, skipped: 1},
			rows: [
				{nodeId: "a", metadata: {numbered_start: 5, layoutMode: "numbered"}},
				{nodeId: "b", metadata: {calendar: CALENDAR, priority: {defaultToBottom: true}}},
			],
			content: contentBefore,
		});
	});

	it("replaces earlier rows, dropping metadata the server no longer reports", () => {
		const {db, rows} = tracked(["a", "b"]);
		importInternalMetadata(
			db,
			snapshot([
				{id: "a", metadata: {numbered_start: 5}},
				{id: "b", metadata: {numbered_start: 1}},
			]),
			1,
		);

		const result = importInternalMetadata(db, snapshot([{id: "a", metadata: {numbered_start: 7}}]), FETCHED_AT);

		expect({result, rows: rows()}).toStrictEqual({
			result: {written: 1, skipped: 0},
			rows: [{nodeId: "a", metadata: {numbered_start: 7}}],
		});
	});

	it("versions calendar_metadata and calendar_levels from a snapshot item's calendar, closing the earlier version on a change", () => {
		const {db} = tracked(["root", "day"]);
		const day = {level: "day", value: "5", timestamp: 1, dateId: 20_261_005};
		importInternalMetadata(
			db,
			snapshot([
				{id: "root", metadata: {calendar: {...CALENDAR, found_dates: true}}},
				{id: "day", metadata: {calendar: day, restorableUniqueNode: true}},
			]),
			1,
		);
		importInternalMetadata(
			db,
			snapshot([
				{id: "root", metadata: {calendar: {...CALENDAR, found_dates: true}}},
				{id: "day", metadata: {calendar: {...day, value: "6", dateId: 20_261_006}, restorableUniqueNode: true}},
			]),
			FETCHED_AT,
		);

		const calendarRows = db
			.select()
			.from(schema.calendarMetadata)
			.all()
			.map(({nodeId, root, level, value, dateId, foundDates, systemTo}) => ({
				nodeId,
				root,
				level,
				value,
				dateId,
				foundDates,
				live: systemTo === FAR_FUTURE_DATE,
			}));
		const levelRows = db
			.select()
			.from(schema.calendarLevels)
			.all()
			.map(({nodeId, day: dayFlag, week, month, year, systemTo}) => ({
				nodeId,
				day: dayFlag,
				week,
				month,
				year,
				live: systemTo === FAR_FUTURE_DATE,
			}));
		expect({calendarRows, levelRows}).toStrictEqual({
			calendarRows: [
				{nodeId: "root", root: 1, level: null, value: null, dateId: null, foundDates: 1, live: true},
				{
					nodeId: "day",
					root: null,
					level: "day",
					value: "5",
					dateId: 20_261_005,
					foundDates: null,
					live: false,
				},
				{nodeId: "day", root: null, level: "day", value: "6", dateId: 20_261_006, foundDates: null, live: true},
			],
			levelRows: [{nodeId: "root", day: 1, week: 0, month: 1, year: 1, live: true}],
		});
	});

	it("round-trips restorableUniqueNode, table settings and column sizes through the typed tables", () => {
		const {db, rows} = tracked(["day", "grid"]);
		const table = {headers: true, skipHeaders: false, bg: "blue", sizes: {c1: 200, c2: 80.5}};

		importInternalMetadata(
			db,
			snapshot([
				{id: "day", metadata: {restorableUniqueNode: true, calendar: {level: "day", dateId: 20_261_005}}},
				{id: "grid", metadata: {layoutMode: "table", table}},
			]),
			FETCHED_AT,
		);

		expect(rows()).toStrictEqual([
			{nodeId: "day", metadata: {restorableUniqueNode: true, calendar: {level: "day", dateId: 20_261_005}}},
			{nodeId: "grid", metadata: {layoutMode: "table", table}},
		]);
	});

	it("drops only a malformed calendar field, keeping the rest of the calendar", () => {
		const {db, rows} = tracked(["day"]);

		importInternalMetadata(
			db,
			snapshot([{id: "day", metadata: {calendar: {level: 5, value: 6, dateId: 20_261_005, found_dates: "yes"}}}]),
			FETCHED_AT,
		);

		expect(rows()).toStrictEqual([{nodeId: "day", metadata: {calendar: {value: "6", dateId: 20_261_005}}}]);
	});

	it("stores layoutMode bullets as NULL without a new node_metadata version, and re-versions a changed layoutMode", () => {
		const {db, metadataRows} = tracked(["a", "b"]);

		importInternalMetadata(
			db,
			snapshot([
				{id: "a", metadata: {layoutMode: "bullets"}},
				{id: "b", metadata: {layoutMode: "todo"}},
			]),
			FETCHED_AT,
		);

		const rowsAfter = metadataRows().map(({nodeId, layoutMode, systemTo}) => ({
			nodeId,
			layoutMode,
			live: systemTo === FAR_FUTURE_DATE,
		}));
		expect(rowsAfter).toStrictEqual([
			{nodeId: "a", layoutMode: null, live: true},
			{nodeId: "b", layoutMode: null, live: false},
			{nodeId: "b", layoutMode: "todo", live: true},
		]);
	});

	it("keeps the earlier numbered_start as a closed version, so a temporal read as of then still sees it", () => {
		const {db} = tracked(["a"]);
		importInternalMetadata(db, snapshot([{id: "a", metadata: {numbered_start: 5}}]), 1);
		importInternalMetadata(db, snapshot([{id: "a", metadata: {numbered_start: 7}}]), FETCHED_AT);

		const versions = db
			.select()
			.from(schema.nodeDisplayMetadata)
			.all()
			.toSorted((a, b) => a.systemFrom.localeCompare(b.systemFrom));
		const [first, second] = versions;
		expect({
			numbers: versions.map((row) => row.numberedStart),
			contiguous: first?.systemTo === second?.systemFrom,
			live: second?.systemTo === FAR_FUTURE_DATE,
		}).toStrictEqual({numbers: [5, 7], contiguous: true, live: true});
	});

	it("stores the snapshot's transaction id and expanded keys, replacing a newer stored id", () => {
		const {db} = tracked([]);
		importInternalMetadata(db, snapshot([], "5000"), 1);

		importInternalMetadata(db, snapshot([], "4000", ["2b2b2b2b", "1a1a1a1a"]), FETCHED_AT);

		expect({
			txId: readTreeTxId(db),
			expansion: readExpansion(db),
			seededAt: readImportTime(db, "expanded_nodes"),
		}).toStrictEqual({
			txId: "4000",
			expansion: new Set(["1a1a1a1a", "2b2b2b2b"]),
			seededAt: Math.floor(FETCHED_AT / 1000) * 1000,
		});
	});
});

describe("WorkflowyInternalClient.getTreeSnapshot", () => {
	it("returns each item's id and metadata, the transaction id and the expanded keys from one /get_tree_data/", async () => {
		const api = createFakeInternalApi();
		api.respond("/get_tree_data/", () =>
			json({
				items: [
					{id: "a", prnt: null, pr: 0, nm: "a", ct: 1, lm: 2, metadata: {numbered_start: 5}},
					{id: "b", prnt: "a", pr: 1, nm: "b", ct: 1, lm: 2},
				],
				most_recent_operation_transaction_id: 9999,
				server_expanded_projects_list: ["1a2b3c4d"],
			}),
		);
		const client = new WorkflowyInternalClient({
			credentials: {username: "alice@example.com", password: "hunter2"},
			fetch: api.fetch,
			baseUrl: "https://workflowy.test",
			transientId: "6f1c1d1e-0000-4000-8000-000000000001",
		});
		await client.login();

		const result = await client.getTreeSnapshot();

		expect({result, reads: api.requests.filter((r) => r.path === "/get_tree_data/").length}).toStrictEqual({
			result: {
				items: [{id: "a", metadata: {numbered_start: 5}}, {id: "b"}],
				txId: "9999",
				expandedKeys: ["1a2b3c4d"],
			},
			reads: 1,
		});
	});
});

describe("keptInternalMetadata table", () => {
	it("keeps the table key and drops unknown keys", () => {
		expect(
			keptInternalMetadata({layoutMode: "table", table: {headers: true, sizes: {c1: 200}}, foo: 1}),
		).toStrictEqual({layoutMode: "table", table: {headers: true, sizes: {c1: 200}}});
	});
});

describe("keptInternalMetadata restorableUniqueNode", () => {
	it("keeps the restorable flag beside calendar and drops unknown keys", () => {
		const calendar = {level: "day", value: "5", timestamp: 1, dateId: 20_261_005};

		expect(keptInternalMetadata({restorableUniqueNode: true, calendar, foo: 1})).toStrictEqual({
			calendar,
			restorableUniqueNode: true,
		});
	});
});
