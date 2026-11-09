import {describe, expect, it} from "vite-plus/test";
import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {Hono} from "hono";
import {join} from "node:path";
import * as schema from "@outlinedb/shared/db";
import type {AppEnv, ServerContext} from "../src/server/context.js";
import {httpAppFor} from "./http-app-for.js";

const {CacheService} = await import("@outlinedb/shared/cache");

const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");
const CHILD = "7b1c2d3e-aaaa-4bbb-8ccc-c910f3eac9b3";
const MIRROR = "0e9f8d7c-1111-4222-8333-d4f14a54f384";

describe("GET /api/v1/nodes/:id with a virtual location id", () => {
	it("resolves v_<child12>_<mirror12> to the original child it shows", async () => {
		const sqlite = new DatabaseConstructor(":memory:");
		const db = drizzle(sqlite, {schema});
		migrate(db, {migrationsFolder});
		const cacheService = new CacheService(db);
		cacheService.insertNode(
			{id: CHILD, name: "child", note: null, parent_id: null, priority: 0, createdAt: 1, modifiedAt: 2},
			null,
		);
		const ctx = {db, cacheService} as unknown as ServerContext;
		const app = new Hono<AppEnv>();
		app.use("*", async (c, next) => {
			c.set("ctx", ctx);
			await next();
		});
		app.route("/", httpAppFor(ctx));

		const res = await app.fetch(new Request(`http://x/api/v1/nodes/v_c910f3eac9b3_${MIRROR.slice(-12)}_0e9f`));

		expect({status: res.status, id: ((await res.json()) as {node: {id: string}}).node.id}).toStrictEqual({
			status: 200,
			id: CHILD,
		});
	});
});

describe("GET /api/v1/nodes/:id/ancestors with a virtual location id", () => {
	it("lists the mirror's ancestors and the mirror, then the rows below its original down to the row", async () => {
		const sqlite = new DatabaseConstructor(":memory:");
		const db = drizzle(sqlite, {schema});
		migrate(db, {migrationsFolder});
		const cacheService = new CacheService(db);
		const ORIGINAL = "aaaa1111-0000-4000-8000-a0a0a0a0a0a0";
		const MIDDLE = "5d5d5d5d-aaaa-4bbb-8ccc-0123456789ab";
		const PARENT = "99990000-1111-4222-8333-444455556666";
		const node = (id: string, parentId: string | null) => ({
			id,
			name: id,
			note: null,
			parent_id: parentId,
			priority: 0,
			createdAt: 1,
			modifiedAt: 2,
		});
		cacheService.insertNode(node(PARENT, null), null);
		cacheService.insertNode(node(ORIGINAL, null), null);
		cacheService.insertNode(node(MIDDLE, ORIGINAL), ORIGINAL);
		cacheService.insertNode(node(CHILD, MIDDLE), MIDDLE);
		cacheService.insertNode(node(MIRROR, PARENT), PARENT);
		cacheService.insertMirror(ORIGINAL, MIRROR);
		const ctx = {db, cacheService} as unknown as ServerContext;
		const app = new Hono<AppEnv>();
		app.use("*", async (c, next) => {
			c.set("ctx", ctx);
			await next();
		});
		app.route("/", httpAppFor(ctx));
		const ids = async (id: string) => {
			const res = await app.fetch(new Request(`http://x/api/v1/nodes/${id}/ancestors`));
			return ((await res.json()) as {ancestors: {id: string}[]}).ancestors.map((ancestor) => ancestor.id);
		};

		expect({
			instance: await ids(`v_c910f3eac9b3_${MIRROR.slice(-12)}_0e9f5d5d`),
			plain: await ids(CHILD),
		}).toStrictEqual({
			instance: [PARENT, MIRROR, MIDDLE, CHILD],
			plain: [ORIGINAL, MIDDLE, CHILD],
		});
	});
});
