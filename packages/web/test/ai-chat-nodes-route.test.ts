import {describe, expect, it} from "vite-plus/test";
import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {Hono} from "hono";
import {join} from "node:path";
import {CacheService} from "@outlinedb/shared/cache";
import * as schema from "@outlinedb/shared/db";
import {aiMetadata, nodeContent, nodeMetadata} from "@outlinedb/shared/db";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import type {AppEnv, ServerContext} from "../src/server/context.js";
import {httpAppFor} from "./http-app-for.js";

const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");
const SEEDED_AT = "2026-01-01 00:00:00.000";

/*
 * home
 *   AI Messages      (ai.inChat, upstream's chat mailbox)
 *     message
 *   Work
 *     AI Messages    (ai.inChat, its only child)
 *   Not chat         (ai metadata present but inChat false)
 */
const TREE: [id: string, parentId: string | null, name: string][] = [
	["mailbox", null, "AI Messages"],
	["message", "mailbox", "Hello"],
	["work", null, "Work"],
	["work-mailbox", "work", "AI Messages"],
	["not-chat", null, "Not chat"],
];

function setup() {
	const sqlite = new DatabaseConstructor(":memory:");
	const db = drizzle(sqlite, {schema});
	migrate(db, {migrationsFolder});
	const priorities = new Map<string | null, number>();
	for (const [id, parentId, name] of TREE) {
		const priority = priorities.get(parentId) ?? 0;
		priorities.set(parentId, priority + 1);
		db.insert(nodeContent)
			.values({id, name, note: null, parentId, systemFrom: SEEDED_AT, systemTo: FAR_FUTURE_DATE})
			.run();
		db.insert(nodeMetadata).values({nodeId: id, priority, systemFrom: SEEDED_AT, systemTo: FAR_FUTURE_DATE}).run();
	}
	for (const [nodeId, inChat] of [
		["mailbox", 1],
		["work-mailbox", 1],
		["not-chat", 0],
	] as const) {
		db.insert(aiMetadata).values({nodeId, inChat, systemFrom: SEEDED_AT, systemTo: FAR_FUTURE_DATE}).run();
	}

	const ctx = {db, cacheService: new CacheService(db)} as unknown as ServerContext;
	const app = new Hono<AppEnv>();
	app.use("*", async (c, next) => {
		c.set("ctx", ctx);
		await next();
	});
	app.route("/", httpAppFor(ctx));
	return app;
}

async function getJson(app: Hono<AppEnv>, path: string): Promise<unknown> {
	const response = await app.fetch(new Request(`http://x${path}`));
	expect(response.status).toBe(200);
	return response.json();
}

describe("AI chat nodes in the nodes routes", () => {
	it("never lists an ai.inChat node as a child, like upstream's ai_chat_message displayable rule", async () => {
		const app = setup();

		const body = (await getJson(app, "/api/v1/nodes")) as {nodes: {id: string; hasChildren: boolean}[]};

		expect(body.nodes.map(({id, hasChildren}) => ({id, hasChildren}))).toStrictEqual([
			{id: "work", hasChildren: false},
			{id: "not-chat", hasChildren: false},
		]);
	});

	it("does not count an ai.inChat child toward hasChildren on a single node", async () => {
		const app = setup();

		const single = (await getJson(app, "/api/v1/nodes/work")) as {node: {hasChildren: boolean}};

		expect(single.node.hasChildren).toBe(false);
	});
});
