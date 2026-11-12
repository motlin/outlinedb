import {describe, expect, it, vi} from "vite-plus/test";
import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {Hono} from "hono";
import {join} from "node:path";
import * as schema from "@outlinedb/shared/db";
import type {WorkflowyInternalAdapter} from "@outlinedb/shared/internal";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import type {WorkflowyNode} from "@outlinedb/shared/types";
import type {AppEnv, ServerContext} from "../src/server/context.js";
import {httpAppFor} from "./http-app-for.js";

const {CacheService} = await import("@outlinedb/shared/cache");

const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");

function apiNode(id: string, parentId: string | null, priority: number): WorkflowyNode
{
	return {
		id,
		name: id.toUpperCase(),
		note: null,
		parent_id: parentId,
		priority,
		createdAt: 100,
		modifiedAt: 200,
	};
}

/** Home holds O, P, L; P holds Q; Q holds R; M under P mirrors O. */
function setup(configured = true, expanded: string[] = [])
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
	for (const [index, id] of ["O", "P", "L"].entries())
	{
		cacheService.insertNode(apiNode(id, null, index), null);
	}
	cacheService.insertNode(apiNode("Q", "P", 0), "P");
	cacheService.insertNode(apiNode("R", "Q", 0), "Q");
	cacheService.insertNode(apiNode("M", "P", 1), "P");
	sqlite
		.prepare("INSERT INTO mirrors (mirror_id, original_id, system_from, system_to) VALUES (?, ?, ?, ?)")
		.run("M", "O", "2000-01-01T00:00:00.000Z", FAR_FUTURE_DATE);
	let counter = 0;
	const createMirrorsAt = vi.fn<WorkflowyInternalAdapter["createMirrorsAt"]>(async (input) =>
	{
		const mirrors = input.originalIds.map((originId) =>
		{
			counter += 1;
			const mirrorId = `new${counter}`;
			cacheService.insertNode(apiNode(mirrorId, input.parentId === "home" ? null : input.parentId, 9), null);
			return {
				mirrorId,
				originId,
			};
		});
		return Promise.resolve(
			{
				mirrors,
			},
		);
	});
	const moveTo = vi.fn<WorkflowyInternalAdapter["moveTo"]>(async () => Promise.resolve());
	const setExpanded = vi.fn<WorkflowyInternalAdapter["setExpanded"]>(async () => Promise.resolve());
	const expansionTest = vi.fn<WorkflowyInternalAdapter["expansionTest"]>(() => (id: string) => expanded.includes(id));
	const ctx =
	{
		db,
		cacheService,
		apiKey: "test-key",
		internalAuth: configured ? {} : undefined,
		internalAdapter: () =>
			configured
				? (
					{
						createMirrorsAt,
						setExpanded,
						expansionTest,
						moveTo,
					} as unknown as WorkflowyInternalAdapter)
				: undefined,
	} as unknown as ServerContext;
	const app = new Hono<AppEnv>();
	app.use("*", async (c, next) =>
	{
		c.set("ctx", ctx);
		await next();
	});
	app.route("/", httpAppFor(ctx));
	const post = async (path: string, body: unknown) =>
		app.fetch(
			new Request(
				`http://x/api/v1/nodes${path}`,
				{
					method: "POST",
					headers:
					{
						"content-type": "application/json",
					},
					body: JSON.stringify(body),
				},
			),
		);
	const get = async (path: string) => app.fetch(new Request(`http://x/api/v1/nodes${path}`));
	return {
		createMirrorsAt,
		setExpanded,
		moveTo,
		cacheService,
		sqlite,
		post,
		get,
	};
}

describe("hasMirrors in the node DTO", () =>
{
	it("flags originals with a live mirror, and nothing else", async () =>
	{
		const {get} = setup();

		const res = await get("?parent_id=P");
		const rows = (
			(await res.json()) as
			{
				nodes:
				{
					id: string;
					hasMirrors: boolean;
					isMirror: boolean;
				}[];
			}
		).nodes;
		const home = (
			(await (await get("")).json()) as
			{
				nodes:
				{
					id: string;
					hasMirrors: boolean;
				}[];
			}
		).nodes;

		expect(
			{
				children: rows.map(({id, hasMirrors, isMirror}) => (
				{
					id,
					hasMirrors,
					isMirror,
				})),
				home: home.map(({id, hasMirrors}) => (
				{
					id,
					hasMirrors,
				})),
			},
		).toStrictEqual(
			{
				children: [
					{
						id: "Q",
						hasMirrors: false,
						isMirror: false,
					},
					{
						id: "M",
						hasMirrors: false,
						isMirror: true,
					},
				],
				home: [
					{
						id: "O",
						hasMirrors: true,
					},
					{
						id: "P",
						hasMirrors: false,
					},
					{
						id: "L",
						hasMirrors: false,
					},
				],
			},
		);
	});
});

describe("POST /api/v1/nodes/mirror", () =>
{
	it("mirrors each item in order at consecutive indexes", async () =>
	{
		const {createMirrorsAt, post} = setup();

		const res = await post(
			"/mirror",
			{
				item_ids: ["O", "L"],
				parent_id: "P",
				index: 1,
			},
		);

		expect(
			{
				status: res.status,
				calls: createMirrorsAt.mock.calls,
			},
		).toStrictEqual(
			{
				status: 201,
				calls: [
					[
						{
							originalIds: ["O", "L"],
							parentId: "P",
							index: 1,
						},
					],
				],
			},
		);
		const body = (await res.json()) as
		{
			nodes:
			{
				id: string;
			}[];
		};
		expect(body.nodes.map((node) => node.id)).toStrictEqual(["new1", "new2"]);
	});

	it("resolves a mirror source to its original", async () =>
	{
		const {createMirrorsAt, post} = setup();

		await post(
			"/mirror",
			{
				item_ids: ["M"],
				parent_id: "L",
				index: 0,
			},
		);

		expect(createMirrorsAt.mock.calls).toStrictEqual([
			[
				{
					originalIds: ["O"],
					parentId: "L",
					index: 0,
				},
			],
		]);
	});

	it("writes into the original's child list when the parent is a mirror", async () =>
	{
		const {createMirrorsAt, post} = setup();

		await post(
			"/mirror",
			{
				item_ids: ["L"],
				parent_id: "M",
				index: 0,
			},
		);

		expect(createMirrorsAt.mock.calls).toStrictEqual([
			[
				{
					originalIds: ["L"],
					parentId: "O",
					index: 0,
				},
			],
		]);
	});

	it("rejects Home as the source", async () =>
	{
		const {createMirrorsAt, post} = setup();

		const res = await post(
			"/mirror",
			{
				item_ids: ["None"],
				parent_id: "P",
				index: 0,
			},
		);

		expect(
			{
				status: res.status,
				body: await res.json(),
				calls: createMirrorsAt.mock.calls.length,
			},
		).toStrictEqual(
			{
				status: 400,
				body:
				{
					error: "Cannot mirror Home",
				},
				calls: 0,
			},
		);
	});

	it("rejects a source that is the parent or an ancestor of the destination", async () =>
	{
		const {createMirrorsAt, post} = setup();

		const ancestor = await post(
			"/mirror",
			{
				item_ids: ["P"],
				parent_id: "R",
				index: 0,
			},
		);
		const parent = await post(
			"/mirror",
			{
				item_ids: ["Q"],
				parent_id: "Q",
				index: 0,
			},
		);

		expect(
			{
				ancestor: [ancestor.status, await ancestor.json()],
				parent: [parent.status, await parent.json()],
				calls: createMirrorsAt.mock.calls.length,
			},
		).toStrictEqual(
			{
				ancestor: [
					400,
					{
						error: "Cannot mirror an item into itself",
					},
				],
				parent: [
					400,
					{
						error: "Cannot mirror an item into itself",
					},
				],
				calls: 0,
			},
		);
	});

	it("gives each new mirror its source row's expansion, a mirror source included", async () =>
	{
		const {setExpanded, post} = setup(true, ["O", "M"]);

		await post(
			"/mirror",
			{
				item_ids: ["O", "L", "M"],
				parent_id: "P",
				index: 0,
			},
		);

		expect(setExpanded.mock.calls).toStrictEqual([
			[
				{
					new1: true,
					new3: true,
				},
			],
		]);
	});

	it("leaves expansion alone when no source is expanded", async () =>
	{
		const {setExpanded, post} = setup();

		await post(
			"/mirror",
			{
				item_ids: ["O"],
				parent_id: "P",
				index: 0,
			},
		);

		expect(setExpanded.mock.calls).toStrictEqual([]);
	});

	it("needs the internal adapter", async () =>
	{
		const {post} = setup(false);

		const res = await post(
			"/mirror",
			{
				item_ids: ["O"],
				parent_id: "P",
				index: 0,
			},
		);

		expect(res.status).toBe(503);
	});
});

describe("POST /api/v1/nodes/:id/swap-mirror-origin", () =>
{
	it("moves the mirror next to its original, then the original into the mirror's old slot", async () =>
	{
		const {moveTo, post} = setup();

		const res = await post("/M/swap-mirror-origin", {});

		expect(
			{
				status: res.status,
				moves: moveTo.mock.calls,
			},
		).toStrictEqual(
			{
				status: 200,
				moves: [
					[
						{
							ids: ["M"],
							parentId: "home",
							index: 0,
						},
					],
					[
						{
							ids: ["O"],
							parentId: "P",
							index: 1,
						},
					],
				],
			},
		);
	});

	it("warns, and moves nothing, when the item is already the origin", async () =>
	{
		const {moveTo, post} = setup();

		const res = await post("/O/swap-mirror-origin", {});

		expect(
			{
				status: res.status,
				body: await res.json(),
				moves: moveTo.mock.calls.length,
			},
		).toStrictEqual(
			{
				status: 200,
				body:
				{
					warning: "This item is already the origin.",
				},
				moves: 0,
			},
		);
	});

	it("refuses a plain item, and a mirror that sits inside its own original", async () =>
	{
		const {moveTo, cacheService, sqlite, post} = setup();
		cacheService.insertNode(apiNode("IN", "O", 0), "O");
		cacheService.insertNode(apiNode("CY", "IN", 0), "IN");
		sqlite
			.prepare("INSERT INTO mirrors (mirror_id, original_id, system_from, system_to) VALUES (?, ?, ?, ?)")
			.run("CY", "O", "2000-01-01T00:00:00.000Z", FAR_FUTURE_DATE);

		const plain = await post("/L/swap-mirror-origin", {});
		const cyclical = await post("/CY/swap-mirror-origin", {});

		expect(
			{
				plain: plain.status,
				cyclical: cyclical.status,
				moves: moveTo.mock.calls.length,
			},
		).toStrictEqual(
			{
				plain: 400,
				cyclical: 400,
				moves: 0,
			},
		);
	});
});
