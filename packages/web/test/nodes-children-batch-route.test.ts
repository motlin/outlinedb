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

function apiNode(id: string, parentId: string | null, priority: number, completedAt?: number): WorkflowyNode {
	return {
		id,
		name: id,
		note: null,
		parent_id: parentId,
		priority,
		createdAt: 100,
		modifiedAt: 200,
		completed: completedAt !== undefined,
		...(completedAt === undefined ? {} : {completedAt}),
	};
}

/** Home holds Alpha>{A1>{A1a}, A2 (completed)} and Beta>{B1}. */
function setup() {
	const sqlite = new DatabaseConstructor(":memory:");
	const db = drizzle(sqlite, {schema});
	migrate(db, {migrationsFolder});
	const cacheService = new CacheService(db);
	cacheService.insertNode(apiNode("Alpha", null, 0), null);
	cacheService.insertNode(apiNode("Beta", null, 1), null);
	cacheService.insertNode(apiNode("A1", "Alpha", 0), "Alpha");
	cacheService.insertNode(apiNode("A2", "Alpha", 1, 300), "Alpha");
	cacheService.insertNode(apiNode("A1a", "A1", 0), "A1");
	cacheService.insertNode(apiNode("B1", "Beta", 0), "Beta");
	const ctx = {db, cacheService} as unknown as ServerContext;
	const app = new Hono<AppEnv>();
	app.use("*", async (c, next) => {
		c.set("ctx", ctx);
		await next();
	});
	app.route("/", httpAppFor(ctx));
	const post = async (body: unknown) => {
		const res = await app.fetch(
			new Request("http://x/api/v1/nodes/children", {
				method: "POST",
				headers: {"Content-Type": "application/json"},
				body: JSON.stringify(body),
			}),
		);
		return {status: res.status, body: await res.json()};
	};
	/** Make `mirrorId` (a new child of `parentId`) a mirror of `originalId`. */
	const mirror = (mirrorId: string, parentId: string, originalId: string) => {
		cacheService.insertNode(apiNode(mirrorId, parentId, 9), parentId);
		sqlite
			.prepare("INSERT INTO mirrors (mirror_id, original_id, system_from, system_to) VALUES (?, ?, ?, ?)")
			.run(mirrorId, originalId, "2000-01-01T00:00:00.000Z", FAR_FUTURE_DATE);
	};
	return {post, mirror};
}

/** The ids of each listed parent's children, in order. */
function childIds(children: Record<string, {id: string}[]>): Record<string, string[]> {
	return Object.fromEntries(Object.entries(children).map(([id, nodes]) => [id, nodes.map((node) => node.id)]));
}

describe("POST /api/v1/nodes/children", () => {
	it("returns the children of every requested parent in one response, like one GET per parent", async () => {
		const {post} = setup();

		const {status, body} = await post({parentIds: ["Alpha", "A1", "B1", "missing"]});

		expect({status, children: childIds(body.children)}).toStrictEqual({
			status: 200,
			children: {Alpha: ["A1", "A2"], A1: ["A1a"], B1: [], missing: []},
		});
	});

	it("lists a mirror's original's children under the mirror's id", async () => {
		const {post, mirror} = setup();
		mirror("M", "Beta", "Alpha");

		const {body} = await post({parentIds: ["M"]});

		expect(childIds(body.children)).toStrictEqual({M: ["A1", "A2"]});
	});

	it("rejects a body without a parentIds string array", async () => {
		const {post} = setup();

		await expect(post({parentIds: "Alpha"})).resolves.toStrictEqual({
			status: 400,
			body: {error: "parentIds must be an array of strings"},
		});
	});
});
