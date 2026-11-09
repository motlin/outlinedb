import {afterEach, describe, expect, it, vi} from "vite-plus/test";
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
const {WorkflowyApiClient} = await import("@outlinedb/shared/api");
interface Row {
	id: string;
	completedAt: number | null;
}

interface CompleteBody {
	node: Row & {parent_id: string | null; isMirror: boolean; originalNodeId: string | null};
	nodes: Row[];
}

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

/** Home holds P and Q. O (original) sits under Q; P holds mirror M of O. */
function setup() {
	const sqlite = new DatabaseConstructor(":memory:");
	const db = drizzle(sqlite, {schema});
	migrate(db, {migrationsFolder});
	const cacheService = new CacheService(db);
	cacheService.insertNode(apiNode("P", null, 0), null);
	cacheService.insertNode(apiNode("Q", null, 1), null);
	cacheService.insertNode(apiNode("O", "Q", 0), "Q");
	cacheService.insertNode(apiNode("M", "P", 0), "P");
	sqlite
		.prepare("INSERT INTO mirrors (mirror_id, original_id, system_from, system_to) VALUES (?, ?, ?, ?)")
		.run("M", "O", "2000-01-01T00:00:00.000Z", FAR_FUTURE_DATE);

	// The public API stores completion on exactly the id it is given.
	const completedAt = new Map<string, number>();
	const written: string[] = [];
	vi.spyOn(WorkflowyApiClient.prototype, "completeNode").mockImplementation(async (id) => {
		written.push(`complete:${id}`);
		completedAt.set(id, 5000);
		return Promise.resolve();
	});
	vi.spyOn(WorkflowyApiClient.prototype, "uncompleteNode").mockImplementation(async (id) => {
		written.push(`uncomplete:${id}`);
		completedAt.delete(id);
		return Promise.resolve();
	});
	vi.spyOn(WorkflowyApiClient.prototype, "getNode").mockImplementation(async (id) => {
		const at = completedAt.get(id);
		const parent = id === "O" ? "Q" : "P";
		return Promise.resolve(apiNode(id, parent, 0, at));
	});

	const ctx = {
		db,
		cacheService,
		apiKey: "test-key",
		config: {} as ServerContext["config"],
	} as unknown as ServerContext;
	const app = new Hono<AppEnv>();
	app.use("*", async (c, next) => {
		c.set("ctx", ctx);
		await next();
	});
	app.route("/", httpAppFor(ctx));
	const request = async (method: string, path: string) => {
		const res = await app.fetch(new Request(`http://x/api/v1/nodes${path}`, {method}));
		return {status: res.status, body: (await res.json()) as CompleteBody};
	};
	return {request, written};
}

describe("POST /api/v1/nodes/:id/complete and /uncomplete on a mirror", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("completes the original, answers the mirror row with the original's completion, and lists both as done", async () => {
		const {request, written} = setup();

		const completed = await request("POST", "/M/complete");
		const mirrorList = await request("GET", "?parent_id=P");
		const originalList = await request("GET", "?parent_id=Q");

		expect({
			written,
			node: {
				id: completed.body.node.id,
				parent_id: completed.body.node.parent_id,
				isMirror: completed.body.node.isMirror,
				originalNodeId: completed.body.node.originalNodeId,
				completed: typeof completed.body.node.completedAt === "number",
			},
			mirror: mirrorList.body.nodes.map((n) => [n.id, typeof n.completedAt]),
			original: originalList.body.nodes.map((n) => [n.id, typeof n.completedAt]),
		}).toStrictEqual({
			written: ["complete:O"],
			node: {id: "M", parent_id: "P", isMirror: true, originalNodeId: "O", completed: true},
			mirror: [["M", "number"]],
			original: [["O", "number"]],
		});
	});

	it("uncompletes the original and answers the mirror row as open", async () => {
		const {request, written} = setup();
		await request("POST", "/M/complete");

		const reopened = await request("POST", "/M/uncomplete");

		expect({
			written,
			node: [reopened.body.node.id, reopened.body.node.isMirror, reopened.body.node.completedAt],
		}).toStrictEqual({written: ["complete:O", "uncomplete:O"], node: ["M", true, null]});
	});
});
