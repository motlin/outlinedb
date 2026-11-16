import {describe, expect, it} from "vite-plus/test";
import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {Hono} from "hono";
import {join} from "node:path";
import {CacheService, readPendingOutbox} from "@outlinedb/shared/cache";
import * as schema from "@outlinedb/shared/db";
import type {WorkflowyInternalAdapter} from "@outlinedb/shared/internal";
import type {WorkflowyNode} from "@outlinedb/shared/types";
import type {AppEnv, ServerContext} from "../src/server/context.js";
import {httpAppFor} from "./http-app-for.js";

const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");
const WRITE_CLIENT_REQUIRED = "WORKFLOWY_API_KEY environment variable is required";
const NEW_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

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

/** An internal adapter whose every member fails the test: a mirror-mode tree write never calls upstream. */
const untouchableAdapter = new Proxy(
	{},
	{
		get: (_target, member) =>
		{
			throw new Error(`a mirror-mode tree write called the adapter's ${String(member)}`);
		},
	},
) as WorkflowyInternalAdapter;

/** A mirror Node host whose Home holds `a`, `b`, `c` (priorities 0..2); `configured` gives it the internal API. */
function setup(configured: boolean)
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
	for (const [index, id] of ["a", "b", "c"].entries())
	{
		cacheService.insertNode(apiNode(id, null, index), null);
	}
	const ctx =
	{
		db,
		cacheService,
		mode: "mirror",
		apiKey: "test-key",
		config: {} as ServerContext["config"],
		internalAuth: configured ? {} : undefined,
		internalAdapter: () => (configured ? untouchableAdapter : undefined),
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
	/** A parent's children in order (Home's for `null`). */
	const order = (parentId: string | null) => cacheService.getChildren(parentId).map(({id}) => id);
	/** Every pending outbox row as `id:aspect`, sorted. */
	const pending = () =>
		readPendingOutbox(db, 1000)
			.map(({nodeId, aspect}) => `${nodeId}:${aspect}`)
			// oxlint-disable-next-line unicorn/no-array-sort -- the test tsconfig lib has no toSorted
			.sort();
	return {
		cacheService,
		post,
		order,
		pending,
	};
}

describe("POST /api/v1/nodes in mirror mode", () =>
{
	it("creates locally at the exact index under a client-generated id and records the create for the drain", async () =>
	{
		const {order, pending, post} = setup(true);

		const res = await post(
			"",
			{
				parent_id: "home",
				name: "",
				index: 1,
				id: NEW_ID,
			},
		);
		const body = (await res.json()) as
		{
			node:
			{
				id: string;
				priority: number;
			};
		};

		expect(
			{
				status: res.status,
				node: [body.node.id, body.node.priority],
				order: order(null),
				pending: pending(),
			},
		).toStrictEqual(
			{
				status: 201,
				node: [NEW_ID, 1],
				order: ["a", NEW_ID, "b", "c"],
				pending: [`${NEW_ID}:create`, `${NEW_ID}:placement`],
			},
		);
	});

	it("creates at the bottom when the index is omitted", async () =>
	{
		const {order, post} = setup(true);

		await post(
			"",
			{
				parent_id: "home",
				name: "x",
				id: NEW_ID,
			},
		);

		expect(order(null)).toStrictEqual(["a", "b", "c", NEW_ID]);
	});

	it("keeps note and layoutMode and treats a null parent as Home", async () =>
	{
		const {order, post} = setup(true);

		const res = await post(
			"",
			{
				parent_id: null,
				name: "x",
				note: "n",
				layoutMode: "board",
				index: 0,
				id: NEW_ID,
			},
		);
		const {node} = (await res.json()) as
		{
			node:
			{
				name: string;
				note: string | null;
				data:
				{
					layoutMode: string | null;
				};
			};
		};

		expect(
			{
				node: [node.name, node.note, node.data.layoutMode],
				order: order(null),
			},
		).toStrictEqual(
			{
				node: ["x", "n", "board"],
				order: [NEW_ID, "a", "b", "c"],
			},
		);
	});

	it("rejects a malformed or already used client id", async () =>
	{
		const {post} = setup(true);

		const malformed = await post(
			"",
			{
				parent_id: "home",
				name: "",
				id: "not-a-uuid",
			},
		);
		await post(
			"",
			{
				parent_id: "home",
				name: "",
				id: NEW_ID,
			},
		);
		const taken = await post(
			"",
			{
				parent_id: "home",
				name: "",
				id: NEW_ID,
			},
		);

		expect(
			{
				malformed: [malformed.status, await malformed.json()],
				taken: [taken.status, await taken.json()],
			},
		).toStrictEqual(
			{
				malformed: [
					400,
					{
						error: "Invalid request body",
					},
				],
				taken: [
					409,
					{
						error: `Node already exists: ${NEW_ID}`,
					},
				],
			},
		);
	});

	it("maps a legacy negative position to the top", async () =>
	{
		const {order, post} = setup(true);
		await post(
			"",
			{
				parent_id: "a",
				name: "first",
			},
		);

		await post(
			"",
			{
				parent_id: "a",
				name: "x",
				position: -1,
				id: NEW_ID,
			},
		);

		expect(order("a")[0]).toBe(NEW_ID);
	});

	it("answers 500 without the internal API to drain through", async () =>
	{
		const {order, post} = setup(false);

		const res = await post(
			"",
			{
				parent_id: "home",
				name: "x",
			},
		);

		expect(
			{
				status: res.status,
				body: await res.json(),
				order: order(null),
			},
		).toStrictEqual(
			{
				status: 500,
				body:
				{
					error: WRITE_CLIENT_REQUIRED,
				},
				order: ["a", "b", "c"],
			},
		);
	});
});

describe("POST /api/v1/nodes/:id/move and /move in mirror mode", () =>
{
	it("moves one node to the exact index, records its placement and returns the affected sibling list", async () =>
	{
		const {order, pending, post} = setup(true);

		const res = await post(
			"/c/move",
			{
				parent_id: "home",
				index: 0,
			},
		);
		const {nodes} = (await res.json()) as
		{
			nodes:
			{
				id: string;
			}[];
		};

		expect(
			{
				status: res.status,
				nodes: nodes.map(({id}) => id),
				order: order(null),
				pending: pending(),
			},
		).toStrictEqual(
			{
				status: 200,
				nodes: ["c", "a", "b"],
				order: ["c", "a", "b"],
				pending: ["c:placement"],
			},
		);
	});

	it("moves to the bottom when the index is omitted", async () =>
	{
		const {order, post} = setup(true);

		await post(
			"/c/move",
			{
				parent_id: "a",
			},
		);

		expect([order(null), order("a")]).toStrictEqual([["a", "b"], ["c"]]);
	});

	it("moves a block, then several blocks in turn", async () =>
	{
		const {order, pending, post} = setup(true);

		await post(
			"/move",
			{
				ids: ["b", "c"],
				parent_id: "a",
				index: 0,
			},
		);
		const blockOrder = [order(null), order("a")];
		await post(
			"/move",
			{
				moves: [
					{
						ids: ["c"],
						parent_id: "b",
						index: 0,
					},
					{
						ids: ["b"],
						parent_id: null,
					},
				],
			},
		);

		expect(
			{
				blockOrder,
				order: [order(null), order("a"), order("b")],
				pending: pending(),
			},
		).toStrictEqual(
			{
				blockOrder: [["a"], ["b", "c"]],
				order: [["a", "b"], [], ["c"]],
				pending: ["b:placement", "c:placement"],
			},
		);
	});

	it("rejects a move onto the node itself or into its own subtree with 400 and writes nothing", async () =>
	{
		const {order, pending, post} = setup(true);
		await post(
			"/c/move",
			{
				parent_id: "a",
			},
		);
		const before = pending();

		const onto = await post(
			"/a/move",
			{
				parent_id: "a",
			},
		);
		const under = await post(
			"/move",
			{
				ids: ["b", "a"],
				parent_id: "c",
			},
		);

		expect(
			{
				onto:
				{
					status: onto.status,
					body: await onto.json(),
				},
				under:
				{
					status: under.status,
					body: await under.json(),
				},
				order: [order(null), order("a"), order("c")],
				pending: pending(),
			},
		).toStrictEqual(
			{
				onto:
				{
					status: 400,
					body:
					{
						error: "Cannot move a under its own subtree",
					},
				},
				under:
				{
					status: 400,
					body:
					{
						error: "Cannot move a under its own subtree",
					},
				},
				order: [["a", "b"], ["c"], []],
				pending: before,
			},
		);
	});

	it("rejects a body without ids", async () =>
	{
		const {pending, post} = setup(true);

		const res = await post(
			"/move",
			{
				parent_id: "a",
				index: 0,
			},
		);

		expect(
			{
				status: res.status,
				body: await res.json(),
				pending: pending(),
			},
		).toStrictEqual(
			{
				status: 400,
				body:
				{
					error: "Invalid request body",
				},
				pending: [],
			},
		);
	});
});

describe("POST /api/v1/nodes/:id/restore in mirror mode", () =>
{
	it("restores a deleted node from its local history into the given slot and records the create", async () =>
	{
		const {cacheService, order, pending, post} = setup(true);
		// Deleted upstream and already caught up: no pending delete.
		cacheService.deleteNode("c");

		const res = await post(
			"/c/restore",
			{
				parent_id: "home",
				index: 0,
			},
		);
		const {node} = (await res.json()) as
		{
			node:
			{
				id: string;
			};
		};

		expect(
			{
				status: res.status,
				node: node.id,
				order: order(null),
				pending: pending(),
			},
		).toStrictEqual(
			{
				status: 200,
				node: "c",
				order: ["c", "a", "b"],
				pending: ["c:create", "c:placement"],
			},
		);
	});

	it("restores to the original location without a slot", async () =>
	{
		const {cacheService, order, post} = setup(true);
		cacheService.deleteNode("b");

		await post("/b/restore", {});

		expect(order(null)).toStrictEqual(["a", "b", "c"]);
	});

	it("answers 409 when the node is not deleted", async () =>
	{
		const {pending, post} = setup(true);

		const res = await post("/a/restore", {});

		expect(
			{
				status: res.status,
				body: await res.json(),
				pending: pending(),
			},
		).toStrictEqual(
			{
				status: 409,
				body:
				{
					error: "Node is not deleted",
				},
				pending: [],
			},
		);
	});
});

describe("POST /api/v1/nodes/trees in mirror mode", () =>
{
	it("creates the trees locally at the slot and records a create for every node, and a placement for each root", async () =>
	{
		const {order, pending, post} = setup(true);

		const res = await post(
			"/trees",
			{
				parent_id: null,
				index: 1,
				after_id: "a",
				trees: [
					{
						name: "x",
						children: [
							{
								name: "y",
							},
						],
					},
					{
						name: "z",
					},
				],
			},
		);
		const {ids} = (await res.json()) as
		{
			ids: string[];
		};
		const [x = "", z = ""] = ids;
		const [y = ""] = order(x);

		expect(
			{
				status: res.status,
				order: order(null),
				pending: pending(),
			},
		).toStrictEqual(
			{
				status: 201,
				order: ["a", x, z, "b", "c"],
				pending: [
					`${x}:create`,
					`${x}:placement`,
					`${y}:create`,
					`${z}:create`,
					`${z}:placement`,
					// oxlint-disable-next-line unicorn/no-array-sort -- the test tsconfig lib has no toSorted
				].sort(),
			},
		);
	});

	it("rejects more than 10000 nodes in total", async () =>
	{
		const {pending, post} = setup(true);
		const trees = [
			{
				name: "p",
				children: Array.from(
					{
						length: 10_000,
					},
					() => (
					{
						name: "c",
					}),
				),
			},
		];

		const res = await post(
			"/trees",
			{
				parent_id: "home",
				index: 0,
				trees,
			},
		);

		expect(
			{
				status: res.status,
				body: await res.json(),
				pending: pending(),
			},
		).toStrictEqual(
			{
				status: 400,
				body:
				{
					error: "Too many nodes: 10001 (max 10000)",
				},
				pending: [],
			},
		);
	});

	it("answers 500 without the internal API to drain through", async () =>
	{
		const {post} = setup(false);

		const res = await post(
			"/trees",
			{
				parent_id: "home",
				index: 0,
				trees: [
					{
						name: "a",
					},
				],
			},
		);

		expect(res.status).toBe(500);
	});
});
