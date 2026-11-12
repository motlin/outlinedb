import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {Hono} from "hono";
import {join} from "node:path";
import {afterEach, describe, expect, it} from "vite-plus/test";
import {CacheService, storeInternalMetadata} from "@outlinedb/shared/cache";
import * as schema from "@outlinedb/shared/db";
import type {AppEnv, ServerContext} from "../src/server/context.js";
import type {FoundDatesResponse} from "../src/node-types.js";
import {httpAppFor} from "./http-app-for.js";

const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");

function time(year: number, month: number, day: number): string
{
	return `<time startYear="${year}" startMonth="${month}" startDay="${day}">${month}/${day}/${year}</time>`;
}

const RANGE =
	'<time startYear="2026" endYear="2026" startMonth="9" endMonth="10" startDay="29" endDay="1">Sep 29 - Oct 1</time>';

/** A range that neither starts nor ends in 2026 but covers all of it. */
const SPANNING =
	'<time startYear="2025" endYear="2027" startMonth="12" endMonth="1" startDay="20" endDay="5">Dec 20 - Jan 5</time>';

/**
 * [id, parent, name, note?, priority]: the Sep 30 day page and nodes elsewhere that name a date.
 */
const TREE: [string, string | null, string, string | null, number][] = [
	["cal", null, "📆 Calendar", null, 0],
	["y2026", "cal", "2026", null, 0],
	["m09", "y2026", "09", null, 0],
	["d0929", "m09", time(2026, 9, 29), null, 0],
	["d0930", "m09", time(2026, 9, 30), null, 1],
	["inside", "d0930", `Lunch ${time(2026, 9, 30)}`, null, 0],
	["beside", "m09", `Standup ${time(2026, 9, 30)}`, null, 2],
	["projects", null, "Projects", null, 1],
	["alpha", "projects", "Alpha", null, 0],
	["due", "alpha", `Ship ${time(2026, 9, 30)}`, null, 1],
	["noted", "alpha", "Review", `Before ${time(2026, 9, 30)}`, 0],
	["trip", "projects", `Trip ${RANGE}`, null, 1],
	["later", "projects", `Later ${time(2026, 10, 5)}`, null, 2],
	["lastyear", "projects", `Old ${time(2025, 9, 30)}`, null, 3],
	["mirror", "projects", "", null, 4],
	["sabbatical", "projects", `Sabbatical ${SPANNING}`, null, 5],
	["top", null, `Top ${time(2026, 9, 30)}`, null, 2],
];

const open: DatabaseConstructor.Database[] = [];
afterEach(() =>
{
	for (const sqlite of open.splice(0))
	{
		sqlite.close();
	}
});

function setup(rootMetadata?: Record<string, unknown>)
{
	const sqlite = new DatabaseConstructor(":memory:");
	open.push(sqlite);
	const db = drizzle(
		sqlite,
		{
			schema,
		},
	);
	migrate(
		db,
		{
			migrationsFolder,
		},
	);
	const cacheService = new CacheService(db);
	for (const [id, parentId, name, note, priority] of TREE)
	{
		cacheService.insertNode(
			{
				id,
				name,
				note,
				parent_id: parentId,
				priority,
				createdAt: 1,
				modifiedAt: 1,
			},
			parentId,
		);
	}
	cacheService.insertMirror("due", "mirror");
	if (rootMetadata !== undefined)
	{
		storeInternalMetadata(
			db,
			new Map([
				[
					"cal",
					{
						calendar: rootMetadata,
					},
				],
			]),
		);
	}
	const ctx =
	{
		db,
		cacheService,
	} as unknown as ServerContext;
	const app = new Hono<AppEnv>();
	app.use("*", async (c, next) =>
	{
		c.set("ctx", ctx);
		await next();
	});
	app.route("/", httpAppFor(ctx));
	const get = async (id: string) =>
	{
		const res = await app.fetch(new Request(`http://x/api/v1/nodes/${id}/found-dates`));
		const body = (await res.json()) as Partial<FoundDatesResponse>;
		return {
			status: res.status,
			items: (body.items ?? []).map(({node, crumbs}) => (
			{
				id: node.id,
				isMirror: node.isMirror,
				originalNodeId: node.originalNodeId,
				crumbs: crumbs.map((crumb) => crumb.id),
			})),
		};
	};
	return Object.assign(
		get,
		{
			/** The raw Found Dates GET body and the outline view POST body for `rootId`. */
			raw: async (rootId: string) =>
			{
				const foundDates: unknown = await (
					await app.fetch(new Request(`http://x/api/v1/nodes/${rootId}/found-dates`))
				).json();
				const view = (await (
					await app.fetch(
						new Request(
							"http://x/api/v1/nodes/view",
							{
								method: "POST",
								headers:
								{
									"Content-Type": "application/json",
								},
								body: JSON.stringify(
									{
										rootId,
										expandedIds: [],
										limit: 50,
										showCompleted: false,
									},
								),
							},
						),
					)
				).json()) as Record<string, unknown>;
				return {
					foundDates,
					view,
				};
			},
		},
	);
}

const found = (id: string, crumbs: string[]) => (
{
	id,
	isMirror: true,
	originalNodeId: id,
	crumbs,
});

describe("GET /api/v1/nodes/:id/found-dates", () =>
{
	it("lists nodes outside the day whose name or note has a <time> covering it, in tree order, as mirrors with crumbs", async () =>
	{
		const get = setup();

		await expect(get("d0930")).resolves.toStrictEqual(
			{
				status: 200,
				items: [
					found("beside", ["cal", "y2026", "m09"]),
					found("noted", ["projects", "alpha"]),
					found("due", ["projects", "alpha"]),
					found("trip", ["projects"]),
					found("sabbatical", ["projects"]),
					found("top", []),
				],
			},
		);
	});

	it("counts a range for every day it covers", async () =>
	{
		const get = setup();

		const {items} = await get("d0929");

		expect(items.map(({id}) => id)).toStrictEqual(["trip", "sabbatical"]);
	});

	it("lists nothing for a node that is not a day", async () =>
	{
		const get = setup();

		await expect(get("alpha")).resolves.toStrictEqual(
			{
				status: 200,
				items: [],
			},
		);
	});

	it("lists nothing when the calendar root turns Found Dates off", async () =>
	{
		const get = setup(
			{
				root: true,
				found_dates: false,
			},
		);

		await expect(get("d0930")).resolves.toStrictEqual(
			{
				status: 200,
				items: [],
			},
		);
	});

	it("answers 404 for an unknown node", async () =>
	{
		const get = setup();

		await expect(get("nope")).resolves.toMatchObject(
			{
				status: 404,
			},
		);
	});
});

describe("POST /api/v1/nodes/view Found Dates", () =>
{
	it("carries a day page's Found Dates, so they swap in with the view", async () =>
	{
		const {foundDates, view} = await setup().raw("d0930");

		expect(view.foundDates).toStrictEqual(foundDates);
	});

	it("carries no Found Dates for a node that is not a day", async () =>
	{
		const {view} = await setup().raw("alpha");

		expect(Object.keys(view)).toStrictEqual(["lists"]);
	});
});
