import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {join} from "node:path";
import {afterEach, describe, expect, it} from "vite-plus/test";
import {CacheService} from "@outlinedb/shared/cache";
import * as schema from "@outlinedb/shared/db";
import {calendarNodeId} from "@outlinedb/shared/internal";
import type {WorkflowyInternalAdapter} from "@outlinedb/shared/internal";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import type {ServerContext} from "../src/server/context.js";
import {httpAppFor} from "./http-app-for.js";

const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");
const KEY = "k";
const D0928 = calendarNodeId(KEY, "day", 20_260_928);

function time(year: number, month: number, day: number): string {
	return `<time startYear="${year}" startMonth="${month}" startDay="${day}">${month}/${day}/${year}</time>`;
}

/** [id, parent, name, note?]: September 2026 days with and without journal content. */
const TREE: [string, string | null, string, string?][] = [
	["cal", null, "📆 Calendar"],
	["y2026", "cal", "2026"],
	["m09", "y2026", "09"],
	["d0927", "m09", time(2026, 9, 27)],
	["d0927-empty", "d0927", ""],
	[D0928, "m09", "Mon, Sep 28"],
	["d0928-a", D0928, ""],
	["d0928-b", D0928, ""],
	["d0929", "m09", time(2026, 9, 29)],
	["d0929-a", "d0929", "Lunch with @Alice"],
	["d0930", "m09", time(2026, 9, 30)],
	["d0930-a", "d0930", "", "Notes only"],
	["d0926", "m09", time(2026, 9, 26)],
	["m10", "y2026", "10"],
	["d1001", "m10", time(2026, 10, 1)],
	["d1001-a", "d1001", "October entry"],
];

const open: DatabaseConstructor.Database[] = [];
afterEach(() => {
	for (const sqlite of open.splice(0)) {
		sqlite.close();
	}
});

function app(onStatement: (sql: string) => void = () => {}) {
	const sqlite = new DatabaseConstructor(":memory:", {
		verbose: (sql) => {
			onStatement(String(sql));
		},
	});
	open.push(sqlite);
	const db = drizzle(sqlite, {schema});
	migrate(db, {migrationsFolder});
	for (const [id, parentId, name, note] of TREE) {
		db.insert(schema.nodeContent)
			.values({id, name, note: note ?? null, parentId, systemFrom: "2026-01-01", systemTo: FAR_FUTURE_DATE})
			.run();
	}
	const adapter = {getEntropyKey: async () => Promise.resolve(KEY)};
	const ctx = {
		db,
		cacheService: new CacheService(db),
		internalAdapter: () => adapter as unknown as WorkflowyInternalAdapter,
	} as unknown as ServerContext;
	const hono = httpAppFor(ctx);
	return async (query: string, path = "days") => {
		const res = await hono.fetch(new Request(`http://x/api/v1/calendar/${path}?${query}`));
		return {status: res.status, body: (await res.json()) as unknown};
	};
}

describe("GET /api/v1/calendar/days", () => {
	it("lists the month's days with two or more children or a first child with a name or note", async () => {
		const get = app();

		await expect(
			Promise.all([get("year=2026&month=9"), get("year=2026&month=10"), get("year=2026&month=11")]),
		).resolves.toStrictEqual([
			{status: 200, body: {days: [28, 29, 30]}},
			{status: 200, body: {days: [1]}},
			{status: 200, body: {days: []}},
		]);
	});

	it("scans the metadata table a fixed number of times per month, not once or twice per day", async () => {
		const scans: string[] = [];
		const get = app((sql) => {
			scans.push(sql);
		});
		scans.length = 0;

		await expect(get("year=2026&month=10&found=1")).resolves.toStrictEqual({status: 200, body: {days: [1]}});
		// Only root lookups (the settings, the days, the Found Dates' calendar info; a node role with stored metadata needs none); the strict walk reads children by id, not by scanning.
		expect(scans.filter(isCalendarScan)).toHaveLength(5);
	});

	it("rejects a missing or out-of-range year or month", async () => {
		const get = app();

		await expect(
			Promise.all([get("year=2026"), get("year=2026&month=13"), get("year=abc&month=9")]),
		).resolves.toStrictEqual(
			Array.from({length: 3}, () => ({
				status: 400,
				body: {error: "year and month must be a calendar year and a 1-12 month"},
			})),
		);
	});
});

describe("GET /api/v1/calendar/dots", () => {
	it("lists the dateIds in [from, to] whose day has journal content, across months", async () => {
		const get = app();

		await expect(
			Promise.all([get("from=20260926&to=20261002", "dots"), get("from=20261002&to=20261002", "dots")]),
		).resolves.toStrictEqual([
			{status: 200, body: {dateIds: [20_260_928, 20_260_929, 20_260_930, 20_261_001]}},
			{status: 200, body: {dateIds: []}},
		]);
	});

	it("scans the metadata table a fixed number of times per month in the range, not per day", async () => {
		const scans: string[] = [];
		const get = app((sql) => {
			scans.push(sql);
		});
		scans.length = 0;

		await expect(get("from=20260901&to=20261031", "dots")).resolves.toStrictEqual({
			status: 200,
			body: {dateIds: [20_260_928, 20_260_929, 20_260_930, 20_261_001]},
		});
		expect(scans.filter(isCalendarScan)).toHaveLength(3);
	});

	it("rejects a missing, invalid, reversed or over-long range", async () => {
		const get = app();

		await expect(
			Promise.all([
				get("from=20260926", "dots"),
				get("from=20260230&to=20260301", "dots"),
				get("from=20261002&to=20260926", "dots"),
				get("from=20260101&to=20270101", "dots"),
			]),
		).resolves.toStrictEqual(
			Array.from({length: 4}, () => ({
				status: 400,
				body: {error: "from and to must be YYYYMMDD days at most 100 days apart, from first"},
			})),
		);
	});
});

/** A query that reads calendar_metadata without naming node ids: a scan by root, level or dateId, not a lookup by id. */
function isCalendarScan(sql: string): boolean {
	return (
		sql.includes('from "calendar_metadata"') &&
		!sql.includes('"calendar_metadata"."node_id" IN (SELECT value FROM json_each(')
	);
}
