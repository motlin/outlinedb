import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {join} from "node:path";
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import type {InternalSession, WorkflowyInternalClient} from "../src/api/workflowy-internal-client.js";
import type {WorkflowyWriteThroughClient} from "../src/cache/workflowy-write-through-client.js";
import {readInternalMetadata, storeInternalMetadata} from "../src/cache/internal-metadata.js";
import {storeTreeTxId} from "../src/cache/tree-transaction.js";
import {z} from "zod";
import * as schema from "../src/db/schema.js";
import {WorkflowyInternalAdapter} from "../src/internal/adapter.js";
import type {MoveToInput} from "../src/internal/adapter.js";
import {calendarDateId, calendarLevelMetadata, calendarLevelName, parseDateId} from "../src/internal/calendar-day.js";
import {CALENDAR_ID_NAMESPACE, calendarNodeId, uuidv5} from "../src/internal/calendar-ids.js";
import {PushAndPoll} from "../src/internal/push-and-poll.js";
import {FAR_FUTURE_DATE} from "../src/temporal/constants.js";

const migrationsFolder = join(import.meta.dirname, "../src/db/migrations");
const ENTROPY = "e".repeat(64);
const CAL = "cal-root";
const Y2026 = calendarNodeId(ENTROPY, "year", 20_260_000);
const M09 = calendarNodeId(ENTROPY, "month", 20_260_900);
const M10 = calendarNodeId(ENTROPY, "month", 20_261_000);
const D1017 = calendarNodeId(ENTROPY, "day", 20_261_017);

const SESSION: InternalSession = {
	clientId: "client",
	clientVersion: "21",
	userId: 123,
	ownerId: 123,
	dateJoinedSec: 1_500_000_000,
	txId: "1",
	rootMetadata: {dateFormat: "YYYY-MM-DD ddd"},
	settings: {},
	visibleFeatures: [],
	expandedKeys: [],
	entropyKey: ENTROPY,
};

/** A pushed `bulk_create` tree, without its clock fields. */
interface PushedTree {
	id: string;
	nm: string;
	metadata?: unknown;
	ch: PushedTree[];
}

function pushedTrees(json: string): PushedTree[] {
	const strip = ({id, nm, metadata, ch}: PushedTree): PushedTree => ({
		id,
		nm,
		...(metadata === undefined ? {} : {metadata}),
		ch: ch.map(strip),
	});
	return (JSON.parse(json) as PushedTree[]).map(strip);
}

/**
 * A fake adapter world: `children` is the live tree the public API would
 * return, `cached` (default `children`) the cache's copy, and
 * the typed metadata tables hold cached calendar metadata. Live reads, pushes
 * (applied to the live tree), cache refreshes and `moveTo` are recorded in
 * `calls`.
 */
function setup(options: {
	children: Record<string, string[]>;
	cached?: Record<string, string[]>;
	metadata: Record<string, unknown>;
	session?: InternalSession;
}) {
	const sqlite = new DatabaseConstructor(":memory:");
	const db = drizzle(sqlite, {schema});
	migrate(db, {migrationsFolder});
	// A whole-tree import seeded the transaction-log position at the fake init's id.
	storeTreeTxId(db, "4567");
	const children = new Map(Object.entries(options.children).map(([parent, ids]) => [parent, [...ids]]));
	const parentOf = (id: string) => [...children].find(([, ids]) => ids.includes(id))?.[0];
	for (const [parent, ids] of children) {
		for (const id of ids) {
			db.insert(schema.nodeContent)
				.values({
					id,
					name: id,
					parentId: parent === "home" ? null : parent,
					systemFrom: "2026-01-01",
					systemTo: FAR_FUTURE_DATE,
				})
				.run();
		}
	}
	storeInternalMetadata(
		db,
		new Map(
			Object.entries(options.metadata).map(([nodeId, metadata]) => [
				nodeId,
				z.record(z.string(), z.unknown()).parse(metadata),
			]),
		),
	);
	const cached = new Map(
		Object.entries(options.cached ?? options.children).map(([parent, ids]) => [parent, [...ids]]),
	);
	const session = options.session ?? SESSION;
	const client = {session, bootstrap: async () => Promise.resolve(session)} as unknown as WorkflowyInternalClient;
	const calls: unknown[] = [];
	const writeThrough = {
		liveChildren: async (parent: string | null) => {
			calls.push(["live", parent]);
			return Promise.resolve((children.get(parent ?? "home") ?? []).map((id) => ({id})));
		},
		cachedChildIds: (parent: string | null) => cached.get(parent ?? "home") ?? [],
		refreshChildren: async (parentIds: (string | null)[]) => {
			calls.push(["refreshChildren", parentIds]);
			for (const parent of parentIds) {
				cached.set(parent ?? "home", [...(children.get(parent ?? "home") ?? [])]);
			}
			return Promise.resolve();
		},
		refreshChain: async (parentIds: string[]) => {
			calls.push(["refresh", parentIds]);
			for (const parent of parentIds) {
				cached.set(parent, [...(children.get(parent) ?? [])]);
			}
			return Promise.resolve();
		},
	} as unknown as WorkflowyWriteThroughClient;
	let generated = 0;
	const adapter = new WorkflowyInternalAdapter({
		client,
		db,
		writeThrough,
		now: () => 1_800_000_000_000,
		generateId: () => `random-${++generated}`,
	});
	const insert = (parentId: string, index: number, trees: PushedTree[]) => {
		const list = children.get(parentId) ?? [];
		list.splice(index, 0, ...trees.map((tree) => tree.id));
		children.set(parentId, list);
		for (const tree of trees) {
			insert(tree.id, 0, tree.ch);
		}
	};
	vi.spyOn(PushAndPoll.prototype, "pushAndPoll").mockImplementation(async ({ops = []} = {}) => {
		for (const op of ops) {
			if (op.type === "edit") {
				const {projectid, metadataPatches} = op.data as {projectid: string; metadataPatches: unknown};
				calls.push(["edit", {id: projectid, metadataPatches}]);
				continue;
			}
			const data = op.data as {parentid: string; starting_priority: number; project_trees: string};
			const trees = pushedTrees(data.project_trees);
			calls.push([op.type, {parentId: data.parentid, index: data.starting_priority, trees}]);
			insert(data.parentid === "None" ? "home" : data.parentid, data.starting_priority, trees);
		}
		return Promise.resolve({txId: "2", serverRun: [], remote: [], needsRefresh: false});
	});
	vi.spyOn(adapter, "moveTo").mockImplementation(async (input: MoveToInput) => {
		calls.push(["moveTo", input]);
		for (const id of input.ids) {
			const from = parentOf(id);
			if (from !== undefined) {
				children.set(
					from,
					(children.get(from) ?? []).filter((child) => child !== id),
				);
			}
		}
		const list = children.get(input.parentId) ?? [];
		list.splice(input.index ?? list.length, 0, ...input.ids);
		children.set(input.parentId, list);
		for (const [parent, ids] of children) {
			cached.set(parent, [...ids]);
		}
		return Promise.resolve();
	});
	const cachedMetadata = (nodeId: string): unknown => readInternalMetadata(db, [nodeId]).get(nodeId);
	return {sqlite, adapter, calls, children, cachedMetadata};
}

const ROOT_META = {
	calendar: {root: true, levels: {day: true, year: true, month: true}, day_prefix: true, found_dates: true},
};
const yearMeta = {
	calendar: {level: "year", value: "2026", timestamp: new Date(2026, 0, 1).getTime(), dateId: 20_260_000},
};
const sepMeta = {calendar: {level: "month", value: "9", timestamp: new Date(2026, 8, 1).getTime(), dateId: 20_260_900}};
const novMeta = {
	calendar: {level: "month", value: "11", timestamp: new Date(2026, 10, 1).getTime(), dateId: 20_261_100},
};

describe("calendar day helpers", () => {
	it("parses a YYYYMMDD dateId and rejects impossible dates", () => {
		expect([
			parseDateId(20_261_017),
			parseDateId(20_260_230),
			parseDateId(2_026_101),
			parseDateId(20_261_300),
		]).toStrictEqual([{year: 2026, month: 10, day: 17}, undefined, undefined, undefined]);
	});

	it("names levels from the account date format like upstream", () => {
		const date = {year: 2026, month: 9, day: 8};
		expect([
			calendarLevelName("year", date, "YYYY-MM-DD ddd"),
			calendarLevelName("month", date, "YYYY-MM-DD ddd"),
			calendarLevelName("month", date, ""),
			calendarLevelName("month", date, "[MM] MMMM"),
			calendarLevelName("year", date, "MM/DD/YY"),
			calendarLevelName("day", date, "YYYY-MM-DD ddd"),
		]).toStrictEqual([
			"2026",
			"09",
			"9",
			"September",
			"26",
			'<time startYear="2026" startMonth="9" startDay="8">Tue, Sep 8, 2026</time>',
		]);
	});

	it("gives a week (upstream DC1) its first day as dateId and timestamp and its week number as value", () => {
		const thursday = {year: 2026, month: 10, day: 15};
		const newYear = {year: 2027, month: 1, day: 1};
		expect([
			calendarDateId("week", thursday),
			calendarDateId("week", thursday, 1),
			calendarDateId("week", newYear),
			calendarLevelMetadata("week", thursday),
			calendarLevelMetadata("week", thursday, 1),
			calendarLevelMetadata("week", newYear),
			calendarLevelMetadata("week", newYear, 1),
		]).toStrictEqual([
			20_261_011,
			20_261_012,
			20_261_227,
			{level: "week", value: "42", timestamp: new Date(2026, 9, 11).getTime(), dateId: 20_261_011},
			{level: "week", value: "42", timestamp: new Date(2026, 9, 12).getTime(), dateId: 20_261_012},
			{level: "week", value: "1", timestamp: new Date(2026, 11, 27).getTime(), dateId: 20_261_227},
			{level: "week", value: "53", timestamp: new Date(2026, 11, 28).getTime(), dateId: 20_261_228},
		]);
	});

	it("names a week from the date format's week token like upstream, else `Week N`", () => {
		const january = {year: 2026, month: 1, day: 7};
		expect([
			calendarLevelName("week", january, "YYYY-MM-DD ddd"),
			calendarLevelName("week", january, "[Week] ww"),
			calendarLevelName("week", january, "wo"),
			calendarLevelName("week", {year: 2026, month: 1, day: 1}, "wo"),
			calendarLevelName("week", {year: 2026, month: 3, day: 10}, "wo"),
			calendarLevelName("week", january, "W", 1),
		]).toStrictEqual(["Week 2", "02", "2nd", "1st", "11th", "2"]);
	});
});

describe("WorkflowyInternalAdapter.ensureCalendarDay", () => {
	let open: DatabaseConstructor.Database[] = [];
	afterEach(() => {
		vi.restoreAllMocks();
		for (const sqlite of open) {
			sqlite.close();
		}
		open = [];
	});
	function tracked(options: Parameters<typeof setup>[0]) {
		const result = setup(options);
		open.push(result.sqlite);
		return result;
	}

	const octMetadata = {
		restorableUniqueNode: true,
		calendar: {level: "month", value: "10", timestamp: new Date(2026, 9, 1).getTime(), dateId: 20_261_000},
	};
	const d1017Metadata = {
		restorableUniqueNode: true,
		calendar: {level: "day", value: "17", timestamp: new Date(2026, 9, 17).getTime(), dateId: 20_261_017},
	};
	const D1017_NAME = '<time startYear="2026" startMonth="10" startDay="17">Sat, Oct 17, 2026</time>';

	it("walks the cache, confirms the miss with one live read, then creates the month, day and empty child in one push", async () => {
		const {adapter, calls, children, cachedMetadata} = tracked({
			children: {home: [CAL], [CAL]: ["note", Y2026], [Y2026]: [M09, "loose", "nov"]},
			metadata: {[CAL]: ROOT_META, [Y2026]: yearMeta, [M09]: sepMeta, nov: novMeta},
		});

		const result = await adapter.ensureCalendarDay(20_261_017);

		expect({result, calls, months: children.get(Y2026), cachedDay: cachedMetadata(D1017)}).toStrictEqual({
			result: {dayId: D1017, firstChildId: "random-1", created: [M10, D1017, "random-1"]},
			calls: [
				["live", Y2026],
				[
					"bulk_create",
					{
						parentId: Y2026,
						index: 2,
						trees: [
							{
								id: M10,
								nm: "10",
								metadata: octMetadata,
								ch: [
									{
										id: D1017,
										nm: D1017_NAME,
										metadata: d1017Metadata,
										ch: [{id: "random-1", nm: "", ch: []}],
									},
								],
							},
						],
					},
				],
				["refresh", [Y2026, M10, D1017]],
			],
			months: [M09, "loose", M10, "nov"],
			cachedDay: {calendar: d1017Metadata.calendar, restorableUniqueNode: true},
		});
	});

	it("creates a v5 day beside a name-only day for the same date and leaves the name-only node alone, as upstream does", async () => {
		const octMeta = {calendar: {level: "month", value: "10", timestamp: 0, dateId: 20_261_000}};
		const {adapter, calls, children} = tracked({
			children: {home: [CAL], [CAL]: [Y2026], [Y2026]: ["oct"], oct: ["name-only"]},
			metadata: {[CAL]: ROOT_META, [Y2026]: yearMeta, oct: octMeta},
		});

		const result = await adapter.ensureCalendarDay(20_261_017, {createChild: false});

		expect({
			result,
			month: children.get("oct"),
			bulk: calls.filter((call) => Array.isArray(call) && call[0] === "bulk_create"),
		}).toStrictEqual({
			result: {dayId: D1017, firstChildId: null, created: [D1017]},
			month: ["name-only", D1017],
			bulk: [
				[
					"bulk_create",
					{
						parentId: "oct",
						index: 1,
						trees: [{id: D1017, nm: D1017_NAME, metadata: d1017Metadata, ch: []}],
					},
				],
			],
		});
	});

	it("reads nothing live and creates nothing when the cached day already has children", async () => {
		const dayMeta = {calendar: {level: "day", value: "17", timestamp: 0, dateId: 20_261_017}};
		const octMeta = {calendar: {level: "month", value: "10", timestamp: 0, dateId: 20_261_000}};
		const {adapter, calls} = tracked({
			children: {
				home: [CAL],
				[CAL]: [Y2026],
				[Y2026]: [M09, "oct"],
				oct: ["legacy-day"],
				"legacy-day": ["entry", "other"],
			},
			metadata: {[CAL]: ROOT_META, [Y2026]: yearMeta, [M09]: sepMeta, oct: octMeta, "legacy-day": dayMeta},
		});

		const result = await adapter.ensureCalendarDay(20_261_017);

		expect({result, calls}).toStrictEqual({
			result: {dayId: "legacy-day", firstChildId: "entry", created: []},
			calls: [],
		});
	});

	it("reuses a day the stale cache misses once the live read shows it", async () => {
		const {adapter, calls} = tracked({
			children: {home: [CAL], [CAL]: [Y2026], [Y2026]: [M10], [M10]: [D1017], [D1017]: ["entry"]},
			cached: {home: [CAL], [CAL]: [Y2026], [Y2026]: [M10]},
			metadata: {[CAL]: ROOT_META, [Y2026]: yearMeta},
		});

		const result = await adapter.ensureCalendarDay(20_261_017);

		expect({result, calls}).toStrictEqual({
			result: {dayId: D1017, firstChildId: "entry", created: []},
			calls: [
				["live", M10],
				["live", D1017],
				["refresh", [M10, D1017]],
			],
		});
	});

	it("moves a deterministic node that exists elsewhere back under its parent instead of creating it", async () => {
		const {adapter, calls} = tracked({
			children: {home: [CAL, M10], [CAL]: [Y2026], [Y2026]: [M09], [M10]: [D1017], [D1017]: ["entry"]},
			metadata: {[CAL]: ROOT_META, [Y2026]: yearMeta, [M09]: sepMeta},
		});

		const result = await adapter.ensureCalendarDay(20_261_017);

		expect({result, calls}).toStrictEqual({
			result: {dayId: D1017, firstChildId: "entry", created: []},
			calls: [
				["live", Y2026],
				["moveTo", {ids: [M10], parentId: Y2026, index: 1}],
				["live", M10],
				["live", D1017],
				["refresh", [Y2026, M10, D1017]],
			],
		});
	});

	it("stops at the month level when asked, creating the missing month without a day or a child", async () => {
		const {adapter, calls} = tracked({
			children: {home: [CAL], [CAL]: [Y2026], [Y2026]: [M09]},
			metadata: {[CAL]: ROOT_META, [Y2026]: yearMeta, [M09]: sepMeta},
		});

		const result = await adapter.ensureCalendarDay(20_261_001, {stopAt: "month", createChild: false});

		expect({result, calls}).toStrictEqual({
			result: {dayId: M10, firstChildId: null, created: [M10]},
			calls: [
				["live", Y2026],
				[
					"bulk_create",
					{parentId: Y2026, index: 1, trees: [{id: M10, nm: "10", metadata: octMetadata, ch: []}]},
				],
				["refresh", [Y2026]],
			],
		});
	});

	it("adds one empty child to an empty month when stopping there with createChild", async () => {
		const octMeta = {calendar: {level: "month", value: "10", timestamp: 0, dateId: 20_261_000}};
		const {adapter, calls} = tracked({
			children: {home: [CAL], [CAL]: [Y2026], [Y2026]: ["oct"]},
			metadata: {[CAL]: ROOT_META, [Y2026]: yearMeta, oct: octMeta},
		});

		const result = await adapter.ensureCalendarDay(20_261_001, {stopAt: "month"});

		expect({result, calls}).toStrictEqual({
			result: {dayId: "oct", firstChildId: "random-1", created: ["random-1"]},
			calls: [
				["live", "oct"],
				["bulk_create", {parentId: "oct", index: 0, trees: [{id: "random-1", nm: "", ch: []}]}],
				["refresh", ["oct"]],
			],
		});
	});

	it("walks a week level between year and day when the root shows weeks, starting weeks per weekStartDay", async () => {
		const weekRoot = {calendar: {root: true, levels: {year: true, week: true, day: true}}};
		const w1012 = calendarNodeId(ENTROPY, "week", 20_261_012, 2026);
		const d1015 = calendarNodeId(ENTROPY, "day", 20_261_015);
		const {adapter, calls} = tracked({
			children: {home: [CAL], [CAL]: [Y2026], [Y2026]: []},
			metadata: {[CAL]: weekRoot, [Y2026]: yearMeta},
			session: {...SESSION, rootMetadata: {dateFormat: "YYYY-MM-DD ddd", weekStartDay: 1}},
		});

		const week = await adapter.ensureCalendarDay(20_261_015, {stopAt: "week", createChild: false});
		const day = await adapter.ensureCalendarDay(20_261_015, {createChild: false});

		expect({week, day, calls}).toStrictEqual({
			week: {dayId: w1012, firstChildId: null, created: [w1012]},
			day: {dayId: d1015, firstChildId: null, created: [d1015]},
			calls: [
				["live", Y2026],
				[
					"bulk_create",
					{
						parentId: Y2026,
						index: 0,
						trees: [
							{
								id: w1012,
								nm: "Week 42",
								metadata: {
									restorableUniqueNode: true,
									calendar: {
										level: "week",
										value: "42",
										timestamp: new Date(2026, 9, 12).getTime(),
										dateId: 20_261_012,
									},
								},
								ch: [],
							},
						],
					},
				],
				["refresh", [Y2026]],
				["live", w1012],
				[
					"bulk_create",
					{
						parentId: w1012,
						index: 0,
						trees: [
							{
								id: d1015,
								nm: '<time startYear="2026" startMonth="10" startDay="15">Thu, Oct 15, 2026</time>',
								metadata: {
									restorableUniqueNode: true,
									calendar: {
										level: "day",
										value: "15",
										timestamp: new Date(2026, 9, 15).getTime(),
										dateId: 20_261_015,
									},
								},
								ch: [],
							},
						],
					},
				],
				["refresh", [w1012]],
			],
		});
	});

	const yearCreate = (parentId: string) => [
		"bulk_create",
		{
			parentId,
			index: 0,
			trees: [{id: Y2026, nm: "2026", metadata: {restorableUniqueNode: true, ...yearMeta}, ch: []}],
		},
	];

	it("walks from the root that root metadata calendar.rootId names, like upstream's Calendar.find", async () => {
		const {adapter, calls} = tracked({
			children: {home: [CAL, "alt"], [CAL]: [], alt: []},
			metadata: {[CAL]: ROOT_META},
			session: {...SESSION, rootMetadata: {...SESSION.rootMetadata, calendar: {rootId: "alt"}}},
		});

		const result = await adapter.ensureCalendarDay(20_261_017, {stopAt: "year", createChild: false});

		expect({result, calls}).toStrictEqual({
			result: {dayId: Y2026, firstChildId: null, created: [Y2026]},
			calls: [["live", "alt"], yearCreate("alt"), ["refresh", ["alt"]]],
		});
	});

	it("falls back to the calendar.root-tagged node when calendar.rootId names no cached node", async () => {
		const {adapter, calls} = tracked({
			children: {home: [CAL], [CAL]: []},
			metadata: {[CAL]: ROOT_META},
			session: {...SESSION, rootMetadata: {...SESSION.rootMetadata, calendar: {rootId: "gone"}}},
		});

		await adapter.ensureCalendarDay(20_261_017, {stopAt: "year", createChild: false});

		expect(calls).toStrictEqual([["live", CAL], yearCreate(CAL), ["refresh", [CAL]]]);
	});

	it("creates the 📆 Calendar root at the end of Home and points calendar.rootId at it when none exists, like upstream's Calendar.ensure", async () => {
		const {adapter, calls, children, cachedMetadata} = tracked({children: {home: ["a"]}, metadata: {}});
		const root = uuidv5(`${ENTROPY}-calendar-root`, CALENDAR_ID_NAMESPACE);

		const result = await adapter.ensureCalendarDay(20_261_017, {stopAt: "year", createChild: false});

		expect({
			result,
			calls,
			home: children.get("home"),
			rootMetadata: cachedMetadata(root),
			rootId: await adapter.getRootMeta(["calendar", "rootId"]),
		}).toStrictEqual({
			result: {dayId: Y2026, firstChildId: null, created: [Y2026]},
			calls: [
				["live", null],
				[
					"bulk_create",
					{
						parentId: "None",
						index: 1,
						trees: [
							{
								id: root,
								nm: "📆 Calendar",
								metadata: {restorableUniqueNode: true, calendar: {root: true}},
								ch: [],
							},
						],
					},
				],
				["refreshChildren", [null]],
				["edit", {id: "None", metadataPatches: [{op: "add", path: ["calendar"], value: {rootId: root}}]}],
				["live", root],
				yearCreate(root),
				["refresh", [root]],
			],
			home: ["a", root],
			rootMetadata: {calendar: {root: true}, restorableUniqueNode: true},
			rootId: root,
		});
	});
});
