import {describe, expect, it} from "vite-plus/test";
import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {Hono} from "hono";
import {join} from "node:path";
import * as schema from "@workflowy/shared/db";
import type {AppEnv, ServerContext} from "../src/server/context.js";
import {httpAppFor} from "./http-app-for.js";

const {CacheService} = await import("@workflowy/shared/cache");

const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");
const A = "aaaa1111-0000-4000-8000-a0a0a0a0a0a0";
const B = "bbbb2222-0000-4000-8000-b0b0b0b0b0b0";
const LEAF = "cccc3333-0000-4000-8000-c0c0c0c0c0c0";

/** A stale cache that holds A under B and B under A, with LEAF under A. */
function cyclicApp(): Hono<AppEnv> {
	const sqlite = new DatabaseConstructor(":memory:");
	const db = drizzle(sqlite, {schema});
	migrate(db, {migrationsFolder});
	const cacheService = new CacheService(db);
	const node = (id: string, parentId: string) => ({
		id,
		name: id.slice(0, 4),
		note: null,
		parent_id: parentId,
		priority: 0,
		createdAt: 1,
		modifiedAt: 2,
	});
	cacheService.insertNode(node(A, B), B);
	cacheService.insertNode(node(B, A), A);
	cacheService.insertNode(node(LEAF, A), A);
	const ctx = {db, cacheService} as unknown as ServerContext;
	const app = new Hono<AppEnv>();
	app.use("*", async (c, next) => {
		c.set("ctx", ctx);
		await next();
	});
	app.route("/", httpAppFor(ctx));
	return app;
}

describe("ancestor walks over a stale cache whose parent chain loops", () => {
	it("GET /api/v1/nodes/:id/ancestors stops where the chain loops back", async () => {
		const res = await cyclicApp().fetch(new Request(`http://x/api/v1/nodes/${LEAF}/ancestors`));
		const body = (await res.json()) as {ancestors: {id: string}[]};

		expect({status: res.status, ids: body.ancestors.map((ancestor) => ancestor.id)}).toStrictEqual({
			status: 200,
			ids: [B, A, LEAF],
		});
	});

	it("GET /api/v1/nodes/:id/mirrors stops each location's path where the chain loops back", async () => {
		const res = await cyclicApp().fetch(new Request(`http://x/api/v1/nodes/${LEAF}/mirrors`));

		expect({status: res.status, body: await res.json()}).toStrictEqual({
			status: 200,
			body: {
				mirrors: [
					{
						id: LEAF,
						path: [
							{id: B, name: "bbbb"},
							{id: A, name: "aaaa"},
							{id: LEAF, name: "cccc"},
						],
						isOriginal: true,
					},
				],
				originalId: LEAF,
				nodeName: "cccc",
			},
		});
	});
});
