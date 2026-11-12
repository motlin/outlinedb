import {describe, expect, it} from "vite-plus/test";
import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {Hono} from "hono";
import {join} from "node:path";
import * as schema from "@outlinedb/shared/db";
import type {WorkflowyNode} from "@outlinedb/shared/types";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import type {AppEnv, ServerContext} from "../src/server/context.js";
import {httpAppFor} from "./http-app-for.js";

const {CacheService} = await import("@outlinedb/shared/cache");

const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");

function apiNode(id: string, parentId: string | null, priority: number, completedAt?: number): WorkflowyNode
{
	return {
		id,
		name: id,
		note: null,
		parent_id: parentId,
		priority,
		createdAt: 100,
		modifiedAt: 200,
		completed: completedAt !== undefined,
		...(completedAt === undefined
			? {}
			:
				{
					completedAt,
				}),
	};
}

/** Home holds Alpha>{A1>{A1a}, A2 (completed)} and Beta>{B1}. */
function setup()
{
	const sqlite = new DatabaseConstructor(":memory:");
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
	cacheService.insertNode(apiNode("Alpha", null, 0), null);
	cacheService.insertNode(apiNode("Beta", null, 1), null);
	cacheService.insertNode(apiNode("A1", "Alpha", 0), "Alpha");
	cacheService.insertNode(apiNode("A2", "Alpha", 1, 300), "Alpha");
	cacheService.insertNode(apiNode("A1a", "A1", 0), "A1");
	cacheService.insertNode(apiNode("B1", "Beta", 0), "Beta");
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
	const request = async (path: string) =>
	{
		const res = await app.fetch(new Request(`http://x/api/v1/nodes${path}`));
		return {
			status: res.status,
			body: await res.json(),
		};
	};
	/** Make `mirrorId` (a new child of `parentId`) a mirror of `originalId`. */
	const mirror = (mirrorId: string, parentId: string, originalId: string, ownCompletedAt?: number) =>
	{
		cacheService.insertNode(apiNode(mirrorId, parentId, 9, ownCompletedAt), parentId);
		sqlite
			.prepare("INSERT INTO mirrors (mirror_id, original_id, system_from, system_to) VALUES (?, ?, ?, ?)")
			.run(mirrorId, originalId, "2000-01-01T00:00:00.000Z", FAR_FUTURE_DATE);
	};
	return {
		request,
		mirror,
	};
}

describe("GET /api/v1/nodes/:id/subtree-ids", () =>
{
	it("lists every descendant of the node with its parent, completion and child flag", async () =>
	{
		const {request} = setup();

		await expect(request("/Alpha/subtree-ids")).resolves.toStrictEqual(
			{
				status: 200,
				body:
				{
					items: [
						{
							id: "A1",
							parentId: "Alpha",
							completed: false,
							hasChildren: true,
						},
						{
							id: "A1a",
							parentId: "A1",
							completed: false,
							hasChildren: false,
						},
						{
							id: "A2",
							parentId: "Alpha",
							completed: true,
							hasChildren: false,
						},
					],
				},
			},
		);
	});

	it("walks the whole Home tree for home, with null parents at the top", async () =>
	{
		const {request} = setup();

		await expect(request("/home/subtree-ids")).resolves.toStrictEqual(
			{
				status: 200,
				body:
				{
					items: [
						{
							id: "Alpha",
							parentId: null,
							completed: false,
							hasChildren: true,
						},
						{
							id: "A1",
							parentId: "Alpha",
							completed: false,
							hasChildren: true,
						},
						{
							id: "A1a",
							parentId: "A1",
							completed: false,
							hasChildren: false,
						},
						{
							id: "A2",
							parentId: "Alpha",
							completed: true,
							hasChildren: false,
						},
						{
							id: "Beta",
							parentId: null,
							completed: false,
							hasChildren: true,
						},
						{
							id: "B1",
							parentId: "Beta",
							completed: false,
							hasChildren: false,
						},
					],
				},
			},
		);
	});

	it("lists a mirror's original children under the mirror", async () =>
	{
		const {request, mirror} = setup();
		mirror("MA1", "Beta", "A1");

		await expect(request("/Beta/subtree-ids")).resolves.toStrictEqual(
			{
				status: 200,
				body:
				{
					items: [
						{
							id: "B1",
							parentId: "Beta",
							completed: false,
							hasChildren: false,
						},
						{
							id: "MA1",
							parentId: "Beta",
							completed: false,
							hasChildren: true,
						},
						{
							id: "A1a",
							parentId: "MA1",
							completed: false,
							hasChildren: false,
						},
					],
				},
			},
		);
	});

	it("reports a mirror as completed exactly when its original is", async () =>
	{
		const {request, mirror} = setup();
		mirror("MA2", "Beta", "A2");
		mirror("MA1", "Beta", "A1", 400);

		const {body} = await request("/Beta/subtree-ids");

		const completion = new Map(
			(
				body as
				{
					items:
					{
						id: string;
						completed: boolean;
					}[];
				}
			).items.map((item) => [item.id, item.completed]),
		);

		expect(
			{
				MA1: completion.get("MA1"),
				MA2: completion.get("MA2"),
			},
		).toStrictEqual(
			{
				MA1: false,
				MA2: true,
			},
		);
	});

	it("does not descend into a mirror of its own ancestor", async () =>
	{
		const {request, mirror} = setup();
		mirror("MAlpha", "A1", "Alpha");

		await expect(request("/Alpha/subtree-ids")).resolves.toStrictEqual(
			{
				status: 200,
				body:
				{
					items: [
						{
							id: "A1",
							parentId: "Alpha",
							completed: false,
							hasChildren: true,
						},
						{
							id: "A1a",
							parentId: "A1",
							completed: false,
							hasChildren: false,
						},
						{
							id: "MAlpha",
							parentId: "A1",
							completed: false,
							hasChildren: true,
						},
						{
							id: "A2",
							parentId: "Alpha",
							completed: true,
							hasChildren: false,
						},
					],
				},
			},
		);
	});

	it("answers 404 for an unknown node", async () =>
	{
		const {request} = setup();

		await expect(request("/nope/subtree-ids")).resolves.toStrictEqual(
			{
				status: 404,
				body:
				{
					error: "Node not found",
				},
			},
		);
	});
});
