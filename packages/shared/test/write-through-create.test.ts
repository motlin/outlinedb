import {vi, afterEach, describe, expect, it} from "vite-plus/test";
import DatabaseConstructor from "better-sqlite3";
import {and, eq} from "drizzle-orm";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {join} from "node:path";
import {WorkflowyApiClient} from "../src/api/workflowy-client.js";
import {CacheService} from "../src/cache/cache-service.js";
import {createNodeTree} from "../src/cache/create-node-tree.js";
import {WorkflowyWriteThroughClient} from "../src/cache/workflowy-write-through-client.js";
import * as schema from "../src/db/schema.js";
import {nodeContent, nodeMetadata} from "../src/db/schema.js";
import {FAR_FUTURE_DATE} from "../src/temporal/constants.js";
import {resolveOrCreateNodePath} from "../src/utils/node-resolver.js";
import {requestJson} from "./helpers/request-body.js";
import {z} from "zod";

const createBodySchema = z.looseObject({parent_id: z.string(), name: z.string(), position: z.string().optional()});
const moveBodySchema = z.looseObject({parent_id: z.string(), position: z.string().optional()});

const migrationsFolder = join(import.meta.dirname, "../src/db/migrations");
const SEEDED_AT = "2026-01-01 00:00:00.000";

type Seed = [id: string, parentId: string | null, priority: number][];

/**
 * A cache holding `seed` (by default `home`, a root, with one child,
 * `existing`, at priority 100), and a fake Workflowy that numbers new or moved
 * children the way the public API does: half the first on a top write, 100
 * above the last otherwise. When the top gap has run out (the first is at 1 or
 * less), it first renumbers every sibling to 100-steps in their current order.
 */
function setup(
	seed: Seed = [
		["home", null, 0],
		["existing", "home", 100],
	],
) {
	const sqlite = new DatabaseConstructor(":memory:");
	const database = drizzle(sqlite, {schema});
	migrate(database, {migrationsFolder});
	database
		.insert(nodeContent)
		.values(
			seed.map(([id, parentId]) => ({
				id,
				name: id,
				note: null,
				parentId,
				systemFrom: SEEDED_AT,
				systemTo: FAR_FUTURE_DATE,
			})),
		)
		.run();
	database
		.insert(nodeMetadata)
		.values(
			seed.map(([id, , priority]) => ({
				nodeId: id,
				priority,
				systemFrom: SEEDED_AT,
				systemTo: FAR_FUTURE_DATE,
			})),
		)
		.run();

	const server = new Map(seed.map(([id, parentId, priority]) => [id, {name: id, parentId, priority}]));
	const calls: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			const method = init?.method ?? "GET";
			const path = url.replace("https://workflowy.test/api/v1", "");
			calls.push(`${method} ${path}`);
			/** The priority a node written under `parentId` at `position` gets, renumbering its siblings first if needed. */
			const place = (parentId: string, position: string | undefined, exceptId: string): number => {
				const siblings = [...server]
					.filter(([id, node]) => id !== exceptId && node.parentId === parentId)
					.toSorted(([, a], [, b]) => a.priority - b.priority)
					.map(([, node]) => node);
				if (siblings.length === 0) {
					return 100;
				}
				if (position !== "top") {
					return siblings.at(-1)!.priority + 100;
				}
				if (siblings[0]!.priority <= 1) {
					for (const [index, sibling] of siblings.entries()) {
						sibling.priority = (index + 1) * 100;
					}
				}
				return Math.floor(siblings[0]!.priority / 2);
			};
			if (method === "POST" && path === "/nodes/") {
				const body = createBodySchema.parse(requestJson(init));
				const id = `${body.name}-id`;
				const priority = place(body.parent_id, body.position, id);
				server.set(id, {name: body.name, parentId: body.parent_id, priority});
				return Promise.resolve(Response.json({item_id: id}, {status: 200}));
			}
			if (method === "POST" && path.endsWith("/move")) {
				const body = moveBodySchema.parse(requestJson(init));
				const id = path.split("/")[2]!;
				const priority = place(body.parent_id, body.position, id);
				server.set(id, {...server.get(id)!, parentId: body.parent_id, priority});
				return Promise.resolve(Response.json({status: "ok"}, {status: 200}));
			}
			const toApi = (id: string) => {
				const node = server.get(id)!;
				return {
					id,
					name: node.name,
					note: null,
					parent_id: node.parentId,
					priority: node.priority,
					completed: false,
					createdAt: 0,
					modifiedAt: 0,
					completedAt: null,
				};
			};
			if (path.startsWith("/nodes?") || path === "/nodes") {
				const parentId = new URLSearchParams(path.split("?")[1] ?? "").get("parent_id");
				const nodes = [...server].filter(([, node]) => node.parentId === parentId).map(([id]) => toApi(id));
				return Promise.resolve(Response.json({nodes}, {status: 200}));
			}
			const id = path.split("/")[2];
			if (id === undefined) {
				throw new Error(`Unexpected request path: ${path}`);
			}
			return Promise.resolve(Response.json({node: toApi(id)}, {status: 200}));
		}),
	);
	const apiClient = new WorkflowyApiClient("test-key", undefined, "https://workflowy.test", {
		maxRetries: 0,
		baseDelayMs: 0,
		maxDelayMs: 0,
	});
	const cacheService = new CacheService(database);
	const client = new WorkflowyWriteThroughClient(apiClient, cacheService);

	/** Every current cached node with its parent and priority, ordered by id. */
	const cached = () =>
		database
			.select({id: nodeContent.id, parentId: nodeContent.parentId, priority: nodeMetadata.priority})
			.from(nodeContent)
			.innerJoin(
				nodeMetadata,
				and(eq(nodeMetadata.nodeId, nodeContent.id), eq(nodeMetadata.systemTo, FAR_FUTURE_DATE)),
			)
			.where(eq(nodeContent.systemTo, FAR_FUTURE_DATE))
			.orderBy(nodeContent.id)
			.all();

	return {client, apiClient, cacheService, calls, cached};
}

describe("WorkflowyWriteThroughClient.createNode priorities", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("caches each created node at Workflowy's priority, not a placeholder, so cached sibling order matches", async () => {
		const {client, calls, cached} = setup();

		await client.createNode({parent_id: "home", name: "a1", position: "top"});
		await client.createNode({parent_id: "home", name: "a2", position: "bottom"});
		await client.createNode({parent_id: "home", name: "a3", position: "bottom"});

		expect({calls, cached: cached()}).toStrictEqual({
			calls: [
				"POST /nodes/",
				"GET /nodes/a1-id",
				"GET /nodes?parent_id=home",
				"POST /nodes/",
				"GET /nodes/a2-id",
				"GET /nodes?parent_id=home",
				"POST /nodes/",
				"GET /nodes/a3-id",
				"GET /nodes?parent_id=home",
			],
			cached: [
				{id: "a1-id", parentId: "home", priority: 50},
				{id: "a2-id", parentId: "home", priority: 200},
				{id: "a3-id", parentId: "home", priority: 300},
				{id: "existing", parentId: "home", priority: 100},
				{id: "home", parentId: null, priority: 0},
			],
		});
	});

	it("caches every node of a created tree at its real priority", async () => {
		const {client, cached} = setup();

		await createNodeTree({name: "tree", children: [{name: "leaf1"}, {name: "leaf2"}]}, "home", client, "top");

		expect(cached()).toStrictEqual([
			{id: "existing", parentId: "home", priority: 100},
			{id: "home", parentId: null, priority: 0},
			{id: "leaf1-id", parentId: "tree-id", priority: 100},
			{id: "leaf2-id", parentId: "tree-id", priority: 200},
			{id: "tree-id", parentId: "home", priority: 50},
		]);
	});

	it("caches path segments created by resolveOrCreateNodePath at their real priority", async () => {
		const {apiClient, cacheService, cached} = setup();

		const id = await resolveOrCreateNodePath("home,made", cacheService, apiClient);

		expect({id, cached: cached()}).toStrictEqual({
			id: "made-id",
			cached: [
				{id: "existing", parentId: "home", priority: 100},
				{id: "home", parentId: null, priority: 0},
				{id: "made-id", parentId: "home", priority: 200},
			],
		});
	});
});

describe("WorkflowyWriteThroughClient positional writes after a server renumbering", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	const crowded: Seed = [
		["home", null, 0],
		["existing1", "home", 1],
		["existing2", "home", 100],
	];

	it("caches a created node and a moved node once each, from the sibling re-read, so a request inside one millisecond never overwrites its own version", async () => {
		vi.useFakeTimers({toFake: ["Date"], now: new Date("2026-02-01T00:00:00.000Z")});
		const {client, cached} = setup(crowded);

		await client.createNode({parent_id: "home", name: "n", position: "top"});
		vi.setSystemTime(new Date("2026-02-01T00:00:00.001Z"));
		await client.moveNode("existing2", "home", -1);

		expect(cached()).toStrictEqual([
			{id: "existing1", parentId: "home", priority: 100},
			{id: "existing2", parentId: "home", priority: 25},
			{id: "home", parentId: null, priority: 0},
			{id: "n-id", parentId: "home", priority: 50},
		]);
	});

	it("re-reads every sibling after a top create, so the renumbered siblings stay in server order", async () => {
		const {client, cached} = setup(crowded);

		await client.createNode({parent_id: "home", name: "n", position: "top"});

		expect(cached()).toStrictEqual([
			{id: "existing1", parentId: "home", priority: 100},
			{id: "existing2", parentId: "home", priority: 200},
			{id: "home", parentId: null, priority: 0},
			{id: "n-id", parentId: "home", priority: 50},
		]);
	});

	it("re-reads every sibling after a top move, so the renumbered siblings stay in server order", async () => {
		const {client, cached} = setup(crowded);

		await client.moveNode("existing2", "home", -1);

		expect(cached()).toStrictEqual([
			{id: "existing1", parentId: "home", priority: 100},
			{id: "existing2", parentId: "home", priority: 50},
			{id: "home", parentId: null, priority: 0},
		]);
	});
});
