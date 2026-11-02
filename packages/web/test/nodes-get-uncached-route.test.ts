import {beforeEach, describe, expect, it, vi} from "vite-plus/test";
import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {Hono} from "hono";
import {join} from "node:path";
import * as schema from "@outlinedb/shared/db";
import type * as SharedCache from "@outlinedb/shared/cache";
import type {WorkflowyNode} from "@outlinedb/shared/types";
import type {AppEnv, ServerContext} from "../src/server/context.js";
import {httpAppFor} from "./http-app-for.js";

const FULL = "11111111-2222-3333-4444-555555555555";
const GONE = "99999999-2222-3333-4444-555555555555";
const live = vi.hoisted(() => (
{
	nodes: new Map<string, unknown>(),
	calls: [] as unknown[][],
	store: (_node: unknown) =>
	{
	},
}));

vi.mock("@outlinedb/shared/cache", async (importOriginal) =>
{
	const actual = await importOriginal<typeof SharedCache>();
	return {
		...actual,
		WorkflowyWriteThroughClient: class
		{
			async cacheLiveNode(id: string)
			{
				live.calls.push(["cacheLiveNode", id]);
				const node = live.nodes.get(id);
				if (node === undefined)
				{
					return Promise.reject(new Error("Failed to get node: 404 Not Found"));
				}
				live.store(node);
				return Promise.resolve();
			}
		},
	};
});

const {CacheService} = await import("@outlinedb/shared/cache");
const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");

function apiNode(id: string, parentId: string | null): WorkflowyNode
{
	return {
		id,
		name: id,
		note: null,
		parent_id: parentId,
		priority: 0,
		createdAt: 100,
		modifiedAt: 200,
		completed: false,
	};
}

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
	cacheService.insertNode(apiNode("Alpha", null), null);
	live.store = (node) =>
	{
		const n = node as WorkflowyNode;
		if (cacheService.getNode(n.id) === undefined)
		{
			cacheService.insertNode(n, n.parent_id ?? null);
		}
	};
	const ctx =
	{
		db,
		cacheService,
		apiKey: "k",
		config: {} as ServerContext["config"],
	} as unknown as ServerContext;
	const app = new Hono<AppEnv>();
	app.use("*", async (c, next) =>
	{
		c.set("ctx", ctx);
		await next();
	});
	app.route("/", httpAppFor(ctx));
	return {
		cacheService,
		get: async (id: string) => app.fetch(new Request(`http://x/api/v1/nodes/${id}`)),
	};
}

describe("GET /api/v1/nodes/:id for uncached nodes", () =>
{
	beforeEach(() =>
	{
		live.nodes.clear();
		live.calls.length = 0;
	});

	it("reads a full uuid live, caches it, and answers 200", async () =>
	{
		const {cacheService, get} = setup();
		live.nodes.set(FULL, apiNode(FULL, "Alpha"));
		const res = await get(FULL);
		expect(
			{
				status: res.status,
				cached: cacheService.getNode(FULL) !== undefined,
				calls: live.calls,
			},
		).toStrictEqual(
			{
				status: 200,
				cached: true,
				calls: [["cacheLiveNode", FULL]],
			},
		);
	});

	it("keeps a real API 404 a 404 and stores nothing", async () =>
	{
		const {cacheService, get} = setup();
		const res = await get(GONE);
		expect(
			{
				status: res.status,
				cached: cacheService.getNode(GONE) !== undefined,
			},
		).toStrictEqual(
			{
				status: 404,
				cached: false,
			},
		);
	});

	it("answers 404 for an uncached short id without calling the API", async () =>
	{
		const {get} = setup();
		const res = await get("abcdef123456");
		expect(
			{
				status: res.status,
				calls: live.calls,
			},
		).toStrictEqual(
			{
				status: 404,
				calls: [],
			},
		);
	});
});
