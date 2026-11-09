import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {join} from "node:path";
import {afterEach, describe, expect, it} from "vite-plus/test";
import {CacheService, storeInternalMetadata} from "@outlinedb/shared/cache";
import * as schema from "@outlinedb/shared/db";
import type {WorkflowyInternalAdapter} from "@outlinedb/shared/internal";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import type {ServerContext} from "../src/server/context.js";
import {httpAppFor} from "./http-app-for.js";

interface MetadataChange {
	path: string[];
	value: unknown;
}

const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");

function time(year: number, month: number, day: number, end?: [number, number, number]): string {
	const endAttrs = end === undefined ? "" : ` endYear="${end[0]}" endMonth="${end[1]}" endDay="${end[2]}"`;
	return `<time startYear="${year}" startMonth="${month}" startDay="${day}"${endAttrs}>x</time>`;
}

/** [id, parent, name, note?]: September 2026 day nodes plus dated items elsewhere. */
const TREE: [string, string | null, string, string?][] = [
	["cal", null, "📆 Calendar"],
	["y2026", "cal", "2026"],
	["m09", "y2026", "09"],
	["d0910", "m09", time(2026, 9, 10)],
	["d0910-a", "d0910", "Journal entry"],
	["d0911", "m09", time(2026, 9, 11)],
	["d0911-empty", "d0911", ""],
	["d0912", "m09", time(2026, 9, 12)],
	["d0913", "m09", time(2026, 9, 13)],
	["d0914", "m09", time(2026, 9, 14)],
	["work", null, "Work"],
	["task", "work", `Ship it ${time(2026, 9, 11)}`],
	["trip", "work", "Trip", time(2026, 9, 12, [2026, 9, 13])],
	["other-month", "work", `Later ${time(2026, 10, 14)}`],
	["undated-day", "work", `No node that day ${time(2026, 9, 20)}`],
];

const ROOT_METADATA = {calendar: {root: true, levels: {day: true, month: true, year: true}, found_dates: true}};

const open: DatabaseConstructor.Database[] = [];
afterEach(() => {
	for (const sqlite of open.splice(0)) {
		sqlite.close();
	}
});

interface SetupOptions {
	rootMetadata?: Record<string, unknown> | null;
	adapter?: boolean;
}

function app({rootMetadata = ROOT_METADATA, adapter = true}: SetupOptions = {}) {
	const sqlite = new DatabaseConstructor(":memory:");
	open.push(sqlite);
	const db = drizzle(sqlite, {schema});
	migrate(db, {migrationsFolder});
	for (const [id, parentId, name, note] of TREE) {
		db.insert(schema.nodeContent)
			.values({id, name, note: note ?? null, parentId, systemFrom: "2026-01-01", systemTo: FAR_FUTURE_DATE})
			.run();
	}
	const tag = (id: string, level: string, value: string, dateId: number) => {
		storeInternalMetadata(db, new Map([[id, {calendar: {level, value, timestamp: 0, dateId}}]]));
	};
	tag("y2026", "year", "2026", 20_260_000);
	tag("m09", "month", "9", 20_260_900);
	for (const day of [10, 11, 12, 13, 14]) {
		tag(`d09${day}`, "day", String(day), 20_260_900 + day);
	}
	const writeRoot = (metadata: Record<string, unknown>) => {
		storeInternalMetadata(db, new Map([["cal", metadata]]));
	};
	if (rootMetadata !== null) {
		writeRoot(rootMetadata);
	}
	const writes: {id: string; changes: MetadataChange[]}[] = [];
	const fake = {
		getEntropyKey: async () => Promise.resolve("k"),
		setNodeMetaValues: async (id: string, changes: MetadataChange[]) => {
			writes.push({id, changes});
			const calendar = {...(rootMetadata?.calendar as Record<string, unknown>)};
			for (const {path, value} of changes) {
				calendar[path[1] ?? ""] = value;
			}
			rootMetadata = {...rootMetadata, calendar};
			writeRoot(rootMetadata);
			return Promise.resolve();
		},
	};
	const ctx = {
		db,
		cacheService: new CacheService(db),
		apiKey: "key",
		internalAdapter: () => (adapter ? (fake as unknown as WorkflowyInternalAdapter) : undefined),
	} as unknown as ServerContext;
	const hono = httpAppFor(ctx);
	const request = async (path: string, init?: RequestInit) => {
		const res = await hono.fetch(new Request(`http://x/api/v1/calendar/${path}`, init));
		return {status: res.status, body: (await res.json()) as unknown};
	};
	const put = async (body: unknown) =>
		request("settings", {method: "PUT", headers: {"content-type": "application/json"}, body: JSON.stringify(body)});
	return {request, put, writes};
}

describe("GET /api/v1/calendar/settings", () => {
	it("reads the root's found_dates and day_prefix, defaulting each to true", async () => {
		const unset = app();
		const off = app({rootMetadata: {calendar: {root: true, found_dates: false, day_prefix: false}}});
		const none = app({rootMetadata: null});

		await expect(
			Promise.all([unset.request("settings"), off.request("settings"), none.request("settings")]),
		).resolves.toStrictEqual([
			{status: 200, body: {foundDates: true, dayPrefix: true}},
			{status: 200, body: {foundDates: false, dayPrefix: false}},
			{status: 200, body: {foundDates: true, dayPrefix: true}},
		]);
	});
});

describe("PUT /api/v1/calendar/settings", () => {
	it("writes each given setting to the root's calendar metadata in one edit and returns the new settings", async () => {
		const {put, writes} = app();

		const result = await put({dayPrefix: false, foundDates: false});

		expect({result, writes}).toStrictEqual({
			result: {status: 200, body: {foundDates: false, dayPrefix: false}},
			writes: [
				{
					id: "cal",
					changes: [
						{path: ["calendar", "found_dates"], value: false},
						{path: ["calendar", "day_prefix"], value: false},
					],
				},
			],
		});
	});

	it("rejects a body without a boolean setting", async () => {
		const {put, writes} = app();

		const results = await Promise.all([put({}), put({dayPrefix: "no"}), put({foundDates: 1})]);

		expect({results, writes}).toStrictEqual({
			results: Array.from({length: 3}, () => ({
				status: 400,
				body: {error: "foundDates and dayPrefix must be booleans, and at least one is required"},
			})),
			writes: [],
		});
	});

	it("refuses to write when the root has no cached internal calendar metadata, which the patch would clobber", async () => {
		const {put, writes} = app({rootMetadata: null});

		const result = await put({dayPrefix: false});

		expect({result, writes}).toStrictEqual({
			result: {status: 409, body: {error: "The 📆 Calendar root's internal metadata is not cached"}},
			writes: [],
		});
	});

	it("needs the internal API", async () => {
		const {put} = app({adapter: false});

		await expect(put({dayPrefix: false})).resolves.toStrictEqual({
			status: 503,
			body: {error: expect.any(String) as unknown},
		});
	});
});

describe("GET /api/v1/calendar/days?found=1", () => {
	it("adds existing days covered by a dated item elsewhere, ranges included", async () => {
		const {request} = app();

		await expect(
			Promise.all([request("days?year=2026&month=9"), request("days?year=2026&month=9&found=1")]),
		).resolves.toStrictEqual([
			{status: 200, body: {days: [10]}},
			{status: 200, body: {days: [10, 11, 12, 13]}},
		]);
	});

	it("drops found-only days when the root turns Found Dates off", async () => {
		const {request} = app({rootMetadata: {calendar: {root: true, found_dates: false}}});

		await expect(request("days?year=2026&month=9&found=1")).resolves.toStrictEqual({
			status: 200,
			body: {days: [10]},
		});
	});
});
