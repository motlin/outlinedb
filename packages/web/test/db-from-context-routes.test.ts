import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {join} from "node:path";
import {afterEach, describe, expect, it} from "vite-plus/test";
import {Hono} from "hono";
import * as schema from "@workflowy/shared/db";
import {nodeContent} from "@workflowy/shared/db";
import {FAR_FUTURE_DATE} from "@workflowy/shared/temporal";
import {nodeTreeHost} from "../src/server/node-host.js";
import {bindTreeHost} from "../src/server/tree-snapshot.js";
import type {AppEnv, ServerContext} from "../src/server/context.js";
import {MemoryEmbeddingIndex} from "../src/server/embedding-index.js";
import {httpAppFor} from "./http-app-for.js";

const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");
const SEEDED_AT = "2026-01-01 00:00:00.000";

const open: DatabaseConstructor.Database[] = [];
afterEach(() => {
	for (const sqlite of open.splice(0)) {
		sqlite.close();
	}
});

function memoryDb() {
	const sqlite = new DatabaseConstructor(":memory:");
	open.push(sqlite);
	const db = drizzle(sqlite, {schema});
	bindTreeHost(db, nodeTreeHost(sqlite));
	migrate(db, {migrationsFolder});
	db.insert(nodeContent)
		.values({
			id: "root",
			name: "Needle #found",
			note: null,
			parentId: null,
			systemFrom: SEEDED_AT,
			systemTo: FAR_FUTURE_DATE,
		})
		.run();
	return db;
}

function appWith(ctx: Partial<ServerContext>) {
	const app = new Hono<AppEnv>();
	app.use("*", async (c, next) => {
		c.set("ctx", ctx as ServerContext);
		await next();
	});
	app.route("/", httpAppFor(ctx as ServerContext));
	return app;
}

const config = (embeddings: boolean) =>
	({features: {embeddings, treeSnapshot: true}}) as unknown as ServerContext["config"];

async function call(app: Hono<AppEnv>, method: string, path: string, body?: unknown) {
	const res = await app.fetch(
		new Request(`http://x${path}`, {
			method,
			headers: {"content-type": "application/json"},
			...(body === undefined ? {} : {body: JSON.stringify(body)}),
		}),
	);
	return {status: res.status, body: (await res.json()) as unknown};
}

describe("routers read the database from the request context", () => {
	it("search helpers lists tags from the context database", async () => {
		const app = appWith({db: memoryDb(), config: config(true)});
		await expect(call(app, "GET", "/api/search/helpers?rootId=")).resolves.toStrictEqual({
			status: 200,
			body: {hashTags: ["#found"], atTags: []},
		});
	});

	it("text search finds a node in the context database", async () => {
		const app = appWith({db: memoryDb(), config: config(true)});
		const res = await call(app, "POST", "/api/search", {query: "Needle"});
		expect(res.body).toMatchObject({totalCount: 1});
	});

	it("changes reads the context database", async () => {
		const app = httpAppFor({db: memoryDb(), config: config(true)} as unknown as ServerContext);
		const res = await app.fetch(new Request("http://x/api/changes?since=1d"));
		expect(res.status).toBe(200);
	});

	it("related returns an empty list and touches no database when embeddings are off", async () => {
		const db = new Proxy(
			{},
			{
				get() {
					throw new Error("database must not be used when embeddings are off");
				},
			},
		) as unknown as ServerContext["db"];
		const app = appWith({db, config: config(false)});
		await expect(call(app, "POST", "/api/related", {nodeId: "root", type: "similar"})).resolves.toStrictEqual({
			status: 200,
			body: {results: []},
		});
	});

	it("related still validates its body when embeddings are off", async () => {
		const app = appWith({db: memoryDb(), config: config(false)});
		await expect(call(app, "POST", "/api/related", {type: "similar"})).resolves.toStrictEqual({
			status: 400,
			body: {error: "nodeId is required"},
		});
	});

	it("related reports a missing embedding from the context's index when embeddings are on", async () => {
		const index = new MemoryEmbeddingIndex();
		const app = appWith({db: memoryDb(), config: config(true), embeddingIndex: () => index});
		await expect(call(app, "POST", "/api/related", {nodeId: "root", type: "similar"})).resolves.toStrictEqual({
			status: 404,
			body: {error: "Node embedding not found. Ensure embeddings have been generated."},
		});
	});
});
