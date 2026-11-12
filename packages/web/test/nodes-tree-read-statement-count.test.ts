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

function apiNode(id: string, parentId: string | null, priority: number): WorkflowyNode
{
	return {
		id,
		name: id,
		note: null,
		parent_id: parentId,
		priority,
		createdAt: 100,
		modifiedAt: 200,
		completed: false,
	};
}

/** Home holds `parents` expanded parents P0.., each with three children, one of them a mirror of Original. */
function setup(parents: number)
{
	const sqlite = new DatabaseConstructor(":memory:");
	let statements = 0;
	const db = drizzle(
		sqlite,
		{
			schema,
			logger:
			{
				logQuery()
				{
					statements += 1;
				},
			},
		},
	);
	migrate(
		db,
		{
			migrationsFolder,
		},
	);
	const cacheService = new CacheService(db);
	cacheService.insertNode(apiNode("Original", null, 0), null);
	for (let p = 0; p < parents; p++)
	{
		cacheService.insertNode(apiNode(`P${p}`, null, p + 1), null);
		for (let k = 0; k < 2; k++)
		{
			cacheService.insertNode(apiNode(`P${p}c${k}`, `P${p}`, k), `P${p}`);
		}
		cacheService.insertNode(apiNode(`P${p}m`, `P${p}`, 9), `P${p}`);
		sqlite
			.prepare("INSERT INTO mirrors (mirror_id, original_id, system_from, system_to) VALUES (?, ?, ?, ?)")
			.run(`P${p}m`, "Original", "2000-01-01T00:00:00.000Z", FAR_FUTURE_DATE);
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
	const post = async (path: string, body: unknown) =>
	{
		const before = statements;
		const res = await app.fetch(
			new Request(
				`http://x/api/v1/nodes${path}`,
				{
					method: "POST",
					headers:
					{
						"Content-Type": "application/json",
					},
					body: JSON.stringify(body),
				},
			),
		);
		await res.json();
		if (process.env.PRINT_COUNTS)
		{
			console.log(`COUNT ${path} ${parents} parents: ${statements - before}`);
		}
		return {
			status: res.status,
			statements: statements - before,
		};
	};
	return {
		post,
	};
}

const parentIds = (n: number) =>
	Array.from(
		{
			length: n,
		},
		(_, p) => `P${p}`,
	);

describe("tree reads keep their SQL statement count independent of the parent count", () =>
{
	it("POST /children", async () =>
	{
		const few = await setup(2).post(
			"/children",
			{
				parentIds: parentIds(2),
			},
		);
		const many = await setup(12).post(
			"/children",
			{
				parentIds: parentIds(12),
			},
		);

		expect(
			{
				few: few.status,
				many: many.status,
				same: many.statements === few.statements,
			},
		).toStrictEqual(
			{
				few: 200,
				many: 200,
				same: true,
			},
		);
		expect(many.statements).toBeLessThanOrEqual(20);
	});

	it("POST /view over expanded rows", async () =>
	{
		const view = (n: number) => (
		{
			rootId: null,
			expandedIds: parentIds(n),
			limit: 1000,
			showCompleted: true,
		});
		const few = await setup(2).post("/view", view(2));
		const many = await setup(12).post("/view", view(12));

		expect(
			{
				few: few.status,
				many: many.status,
				same: many.statements === few.statements,
			},
		).toStrictEqual(
			{
				few: 200,
				many: 200,
				same: true,
			},
		);
		expect(many.statements).toBeLessThanOrEqual(40);
	});
});
