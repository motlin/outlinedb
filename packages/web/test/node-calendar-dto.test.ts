import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {Hono} from "hono";
import {join} from "node:path";
import {afterEach, describe, expect, it} from "vite-plus/test";
import {CacheService, storeInternalMetadata} from "@outlinedb/shared/cache";
import * as schema from "@outlinedb/shared/db";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import type {AppEnv, ServerContext} from "../src/server/context.js";
import {httpAppFor} from "./http-app-for.js";

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
const BACKUP: {nodeId: string; level: string; dateId: number}[] = [{nodeId: "d0930", level: "day", dateId: 20_260_930}];

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
