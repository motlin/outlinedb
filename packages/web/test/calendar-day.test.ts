import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {join} from "node:path";
import {afterEach, describe, expect, it} from "vite-plus/test";
import {CacheService, storeInternalMetadata} from "@outlinedb/shared/cache";
import * as schema from "@outlinedb/shared/db";
import {calendarNodeId} from "@outlinedb/shared/internal";
import type {WorkflowyInternalAdapter} from "@outlinedb/shared/internal";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import {findCalendarDay, findCalendarDays, findTaggedCalendarRoot} from "../src/server/calendar-day.js";
import type {ServerContext} from "../src/server/context.js";
import {httpAppFor} from "./http-app-for.js";

const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");
const KEY = "k";
const D1017 = calendarNodeId(KEY, "day", 20_261_017);
const D1005_ELSEWHERE = calendarNodeId(KEY, "day", 20_261_005);
const W0906 = calendarNodeId(KEY, "week", 20_260_906, 2026);

function time(year: number, month: number, day: number): string {
	return `<time startYear="${year}" startMonth="${month}" startDay="${day}">${month}/${day}/${year}</time>`;
}

/** [id, parent, name, metadata?]: a 📆 Calendar root with legacy, metadata-tagged and deterministic days, and month-level entries that mention a date. */
const TREE: [string, string | null, string, Record<string, unknown>?][] = [
	["cal", null, "📆 Calendar", {calendar: {root: true, levels: {year: true, month: true, day: true}}}],
	["other", null, "Other"],
	[D1005_ELSEWHERE, "other", time(2026, 10, 5)],
	["y2026", "cal", "2026", {calendar: {level: "year", value: "2026", timestamp: 0, dateId: 20_260_000}}],
	["m09", "y2026", "9", {calendar: {level: "month", value: "9", timestamp: 0, dateId: 20_260_900}}],
	["d0902", "m09", time(2026, 9, 2)],
	["d0930", "m09", "Sept 30", {calendar: {level: "day", value: "30", timestamp: 0, dateId: 20_260_930}}],
	[W0906, "m09", "Week 37"],
	["m10", "y2026", "10", {calendar: {level: "month", value: "10", timestamp: 0, dateId: 20_261_000}}],
	[
		"a-entry-1001",
		"m10",
		'<time startYear="2026" startMonth="10" startDay="1" startHour="9">Oct 1 at 9am</time> Standup',
	],
	["b-kickoff-1001", "m10", `Kickoff ${time(2026, 10, 1)}`],
	["d1001", "m10", time(2026, 10, 1)],
	[D1017, "m10", "Today", {calendar: {level: "day", value: "17", timestamp: 0, dateId: 20_261_017}}],
	["w1011", "m10", "Week 42", {calendar: {level: "week", value: "42", timestamp: 0, dateId: 20_261_011}}],
	["z01", "y2026", "1", {calendar: {level: "month", value: "1", timestamp: 0, dateId: 20_260_100}}],
	["u0115", "z01", time(2026, 1, 15)],
	["nested", "u0115", "link", {calendar: {level: "day", value: "15", timestamp: 0, dateId: 20_260_115}}],
];

/** [id, priority, kind]: today's children, inserted out of priority order; the references root and the deleted child sort first. */
const D1017_CHILDREN: [string, number, "live" | "referencesRoot" | "deleted"][] = [
	["second", 3, "live"],
	["refs", 0, "referencesRoot"],
	["deleted", 1, "deleted"],
	["first", 2, "live"],
];

const open: DatabaseConstructor.Database[] = [];
afterEach(() => {
	for (const sqlite of open.splice(0)) {
		sqlite.close();
	}
});

function setup(onStatement: (sql: string) => void = () => {}, {taggedRoot = true}: {taggedRoot?: boolean} = {}) {
	const sqlite = new DatabaseConstructor(":memory:", {
		verbose: (sql) => {
			onStatement(String(sql));
		},
	});
	open.push(sqlite);
	const db = drizzle(sqlite, {schema});
	migrate(db, {migrationsFolder});
	for (const [id, parentId, name, metadata] of TREE) {
		db.insert(schema.nodeContent)
			.values({id, name, parentId, systemFrom: "2026-01-01", systemTo: FAR_FUTURE_DATE})
			.run();
		if (metadata !== undefined && (taggedRoot || id !== "cal")) {
			storeInternalMetadata(db, new Map([[id, metadata]]));
		}
	}
	for (const [id, priority, kind] of D1017_CHILDREN) {
		const systemTo = kind === "deleted" ? "2026-02-01" : FAR_FUTURE_DATE;
		db.insert(schema.nodeContent).values({id, name: id, parentId: D1017, systemFrom: "2026-01-01", systemTo}).run();
		db.insert(schema.nodeMetadata).values({nodeId: id, priority, systemFrom: "2026-01-01", systemTo}).run();
		if (kind === "referencesRoot") {
			db.insert(schema.referencesRoots).values({nodeId: id, systemFrom: "2026-01-01", systemTo}).run();
		}
	}
	return {db, cache: new CacheService(db)};
}

describe("findCalendarDay", () => {
	it("walks the root's direct children by calendar metadata, as upstream does", () => {
		const deps = {...setup(), entropyKey: KEY};

		expect(
			[20_261_017, 20_260_930, 20_261_001, 20_260_902, 20_261_005, 20_260_115].map((dateId) =>
				findCalendarDay(deps, dateId),
			),
		).toStrictEqual([D1017, "d0930", null, null, null, null]);
	});

	it("keeps the lenient deterministic-id, metadata and name lookup when the root is untagged", () => {
		const deps = {...setup(undefined, {taggedRoot: false}), entropyKey: KEY};

		expect(
			[20_261_017, 20_260_930, 20_261_001, 20_260_902, 20_261_005].map((dateId) => findCalendarDay(deps, dateId)),
		).toStrictEqual([D1017, "d0930", "d1001", "d0902", null]);
	});

	it("finds the month or year node holding a day by its calendar metadata", () => {
		const deps = {...setup(), entropyKey: KEY};

		expect([
			findCalendarDay(deps, 20_261_017, "month"),
			findCalendarDay(deps, 20_260_902, "month"),
			findCalendarDay(deps, 20_261_017, "year"),
			findCalendarDay(deps, 20_271_017, "year"),
		]).toStrictEqual(["m10", "m09", "y2026", null]);
	});

	it("finds the week holding a day by calendar metadata, its start per weekStartDay", () => {
		const deps = {...setup(), entropyKey: KEY};

		expect([
			findCalendarDay(deps, 20_260_909, "week"),
			findCalendarDay(deps, 20_261_015, "week"),
			findCalendarDay({...deps, weekStartDay: 1}, 20_261_015, "week"),
			findCalendarDay(deps, 20_261_020, "week"),
		]).toStrictEqual([null, "w1011", null, null]);
	});

	it("skips the deterministic id without an entropy key and still walks names when the root is untagged", () => {
		const deps = setup(undefined, {taggedRoot: false});

		expect([20_261_017, 20_261_001].map((dateId) => findCalendarDay(deps, dateId))).toStrictEqual([D1017, "d1001"]);
	});

	/** A second, untagged calendar root `alt` holding a tagged 2026 > 10 > 17, and root metadata `calendar.rootId` naming `pointer`. */
	function withPointer(pointer: string) {
		const deps = setup();
		const alt: [string, string | null, string, Record<string, unknown>?][] = [
			["alt", null, "Alt Calendar"],
			["alt-y", "alt", "2026", {calendar: {level: "year", value: "2026", timestamp: 0, dateId: 20_260_000}}],
			["alt-m", "alt-y", "10", {calendar: {level: "month", value: "10", timestamp: 0, dateId: 20_261_000}}],
			["alt-d", "alt-m", "17", {calendar: {level: "day", value: "17", timestamp: 0, dateId: 20_261_017}}],
		];
		for (const [id, parentId, name, metadata] of alt) {
			deps.db
				.insert(schema.nodeContent)
				.values({id, name, parentId, systemFrom: "2026-01-01", systemTo: FAR_FUTURE_DATE})
				.run();
			if (metadata !== undefined) {
				storeInternalMetadata(deps.db, new Map([[id, metadata]]));
			}
		}
		deps.db
			.insert(schema.rootPreferences)
			.values({userId: "1", calendarRootId: pointer, systemFrom: "2026-01-01", systemTo: FAR_FUTURE_DATE})
			.run();
		return {...deps, entropyKey: KEY};
	}

	it("finds the root through root metadata calendar.rootId when it names a live node, like upstream's Calendar.find", () => {
		const deps = withPointer("alt");

		expect({
			root: findTaggedCalendarRoot(deps),
			day: findCalendarDay(deps, 20_261_017),
			days: findCalendarDays(deps, [20_261_017]),
		}).toStrictEqual({root: "alt", day: "alt-d", days: new Map([[20_261_017, "alt-d"]])});
	});

	it("falls back to the calendar.root-tagged node when calendar.rootId names no live node", () => {
		const deps = withPointer("gone");

		expect({root: findTaggedCalendarRoot(deps), day: findCalendarDay(deps, 20_261_017)}).toStrictEqual({
			root: "cal",
			day: D1017,
		});
	});
});

describe("findCalendarDays", () => {
	const SEPT_OCT = Array.from({length: 61}, (_, index) =>
		index < 30 ? 20_260_901 + index : 20_261_001 + index - 30,
	);

	it("finds each day as findCalendarDay does, only the upstream-visible ones", () => {
		const deps = {...setup(), entropyKey: KEY};
		const expected = new Map(
			SEPT_OCT.flatMap((dateId) => {
				const id = findCalendarDay(deps, dateId);
				return id === null ? [] : [[dateId, id] as const];
			}),
		);

		expect(findCalendarDays(deps, SEPT_OCT)).toStrictEqual(expected);
		expect(expected).toStrictEqual(
			new Map([
				[20_260_930, "d0930"],
				[20_261_017, D1017],
			]),
		);
	});

	it("also dots name-only days when the root is untagged", () => {
		const deps = {...setup(undefined, {taggedRoot: false}), entropyKey: KEY};

		expect(findCalendarDays(deps, SEPT_OCT)).toStrictEqual(
			new Map([
				[20_260_902, "d0902"],
				[20_260_930, "d0930"],
				[20_261_001, "d1001"],
				[20_261_017, D1017],
			]),
		);
	});

	it("scans the calendar metadata table unkeyed once for the root, not per day", () => {
		const scans: string[] = [];
		const deps = {
			...setup((sql) => {
				scans.push(sql);
			}),
			entropyKey: KEY,
		};
		scans.length = 0;

		findCalendarDays(deps, SEPT_OCT);

		expect(scans.filter(isCalendarScan)).toHaveLength(1);
	});
});

describe("GET /api/v1/calendar/day/:dateId", () => {
	function app(entropyKey: string | undefined, taggedRoot = true) {
		const {db, cache} = setup(undefined, {taggedRoot});
		const adapter = {
			getEntropyKey: async () => Promise.resolve(entropyKey),
			getRootMeta: async () => Promise.resolve(undefined),
		};
		const ctx = {
			db,
			cacheService: cache,
			internalAdapter: () =>
				entropyKey === undefined ? undefined : (adapter as unknown as WorkflowyInternalAdapter),
		} as unknown as ServerContext;
		const hono = httpAppFor(ctx);
		return async (dateId: string, query = "") => {
			const res = await hono.fetch(new Request(`http://x/api/v1/calendar/day/${dateId}${query}`));
			return {status: res.status, body: (await res.json()) as unknown};
		};
	}

	it("answers the day's id and first live, non-references-root child, using the account entropy key when the internal API is configured", async () => {
		const get = app(KEY);

		await expect(Promise.all([get("20261017"), get("20261005"), get("20260230")])).resolves.toStrictEqual([
			{status: 200, body: {id: D1017, firstChildId: "first"}},
			{status: 404, body: {error: "Calendar day not found"}},
			{status: 400, body: {error: "dateId must be a YYYYMMDD calendar day"}},
		]);
	});

	it("falls back to metadata and names without the internal API", async () => {
		const get = app(undefined, false);

		await expect(Promise.all([get("20261001"), get("20260930")])).resolves.toStrictEqual([
			{status: 200, body: {id: "d1001", firstChildId: null}},
			{status: 200, body: {id: "d0930", firstChildId: null}},
		]);
	});

	it("answers 404 for a name-only day once the root is tagged", async () => {
		const get = app(KEY);

		await expect(get("20261001")).resolves.toStrictEqual({
			status: 404,
			body: {error: "Calendar day not found"},
		});
	});

	it("answers the week, month or year node holding the day for ?level=, and rejects other levels", async () => {
		const get = app(KEY);

		await expect(
			Promise.all([
				get("20260902", "?level=month"),
				get("20260902", "?level=year"),
				get("20261015", "?level=week"),
				get("20260902", "?level=hour"),
			]),
		).resolves.toStrictEqual([
			{status: 200, body: {id: "m09", firstChildId: "d0902"}},
			{status: 200, body: {id: "y2026", firstChildId: "m09"}},
			{status: 200, body: {id: "w1011", firstChildId: null}},
			{status: 400, body: {error: "level must be day, week, month or year"}},
		]);
	});
});

/** A query that reads calendar_metadata without naming node ids: a scan by root, level or dateId, not a lookup by id. */
function isCalendarScan(sql: string): boolean {
	return (
		sql.includes('from "calendar_metadata"') &&
		!sql.includes('"calendar_metadata"."node_id" IN (SELECT value FROM json_each(')
	);
}
