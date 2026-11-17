import {vi, afterEach, describe, expect, it} from "vite-plus/test";
import {generateNKeysBetween} from "fractional-indexing";
import {and, eq} from "drizzle-orm";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {WorkflowyApiClient} from "../src/api/workflowy-client.js";
import {CacheService} from "../src/cache/cache-service.js";
import {WorkflowyWriteThroughClient} from "../src/cache/workflowy-write-through-client.js";
import * as schema from "../src/db/schema.js";
import {nodeContent, nodeMetadata, mirrors, nodeEmbeddings, referencesRoots} from "../src/db/schema.js";
import {compareBinary} from "../src/cache/order-key.js";
import {FAR_FUTURE_DATE, systemTimeAt} from "../src/temporal/constants.js";
import {requestJson, requestBody} from "./helpers/request-body.js";
import {z} from "zod";
import type {WorkflowyNode} from "../src/types/workflowy.js";
import {buildTestDb} from "./helpers/round-trip-helpers.js";
import type {DeletePlan} from "../src/cache/delete-plan.js";
import type {UpdateNodeRequest} from "../src/api/workflowy-client.js";
import {migratedMemoryDatabase} from "./helpers/migrated-memory-database.js";

/** The fractional-indexing integer key of `n`, so seeded keys sort like the seeded priorities. */
const integerOrderKey = (n: number): string => generateNKeysBetween(null, null, n + 1).at(-1) ?? "a0";

describe("write through create", () =>
{
	const createBodySchema = z.looseObject(
		{
			parent_id: z.string(),
			name: z.string(),
			position: z.string().optional(),
		},
	);
	const moveBodySchema = z.looseObject(
		{
			parent_id: z.string(),
			position: z.string().optional(),
		},
	);

	const SEEDED_AT = systemTimeAt("2026-01-01 00:00:00.000");

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
	)
	{
		const sqlite = migratedMemoryDatabase();
		const database = drizzle(
			sqlite,
			{
				schema,
			},
		);
		database
			.insert(nodeContent)
			.values(
				seed.map(([id, parentId]) => (
				{
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
				seed.map(([id, , priority]) => (
				{
					nodeId: id,
					orderKey: integerOrderKey(priority),
					systemFrom: SEEDED_AT,
					systemTo: FAR_FUTURE_DATE,
				})),
			)
			.run();

		const server = new Map(
			seed.map(([id, parentId, priority]) => [
				id,
				{
					name: id,
					parentId,
					priority,
				},
			]),
		);
		const calls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) =>
			{
				const method = init?.method ?? "GET";
				const path = url.replace("https://workflowy.test/api/v1", "");
				calls.push(`${method} ${path}`);
				/** The priority a node written under `parentId` at `position` gets, renumbering its siblings first if needed. */
				const place = (parentId: string, position: string | undefined, exceptId: string): number =>
				{
					const siblings = [...server]
						.filter(([id, node]) => id !== exceptId && node.parentId === parentId)
						.toSorted(([, a], [, b]) => a.priority - b.priority)
						.map(([, node]) => node);
					if (siblings.length === 0)
					{
						return 100;
					}
					if (position !== "top")
					{
						return siblings.at(-1)!.priority + 100;
					}
					if (siblings[0]!.priority <= 1)
					{
						for (const [index, sibling] of siblings.entries())
						{
							sibling.priority = (index + 1) * 100;
						}
					}
					return Math.floor(siblings[0]!.priority / 2);
				};
				if (method === "POST" && path === "/nodes/")
				{
					const body = createBodySchema.parse(requestJson(init));
					const id = `${body.name}-id`;
					const priority = place(body.parent_id, body.position, id);
					server.set(
						id,
						{
							name: body.name,
							parentId: body.parent_id,
							priority,
						},
					);
					return Promise.resolve(
						Response.json(
							{
								item_id: id,
							},
							{
								status: 200,
							},
						),
					);
				}
				if (method === "POST" && path.endsWith("/move"))
				{
					const body = moveBodySchema.parse(requestJson(init));
					const id = path.split("/")[2]!;
					const priority = place(body.parent_id, body.position, id);
					server.set(
						id,
						{
							...server.get(id)!,
							parentId: body.parent_id,
							priority,
						},
					);
					return Promise.resolve(
						Response.json(
							{
								status: "ok",
							},
							{
								status: 200,
							},
						),
					);
				}
				const toApi = (id: string) =>
				{
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
				if (path.startsWith("/nodes?") || path === "/nodes")
				{
					const parentId = new URLSearchParams(path.split("?")[1] ?? "").get("parent_id");
					const nodes = [...server].filter(([, node]) => node.parentId === parentId).map(([id]) => toApi(id));
					return Promise.resolve(
						Response.json(
							{
								nodes,
							},
							{
								status: 200,
							},
						),
					);
				}
				const id = path.split("/")[2];
				if (id === undefined)
				{
					throw new Error(`Unexpected request path: ${path}`);
				}
				return Promise.resolve(
					Response.json(
						{
							node: toApi(id),
						},
						{
							status: 200,
						},
					),
				);
			}),
		);
		const apiClient = new WorkflowyApiClient("test-key", undefined, "https://workflowy.test");
		const cacheService = new CacheService(database);
		const client = new WorkflowyWriteThroughClient(apiClient, cacheService);

		/** Each cached parent's current children in sibling order (order key, then id), Home's under `root`. */
		const cached = () =>
		{
			const outline: Record<string, string[]> = {};
			for (const row of database
				.select(
					{
						id: nodeContent.id,
						parentId: nodeContent.parentId,
						orderKey: nodeMetadata.orderKey,
					},
				)
				.from(nodeContent)
				.innerJoin(
					nodeMetadata,
					and(eq(nodeMetadata.nodeId, nodeContent.id), eq(nodeMetadata.systemTo, FAR_FUTURE_DATE)),
				)
				.where(eq(nodeContent.systemTo, FAR_FUTURE_DATE))
				.all()
				.toSorted((a, b) => compareBinary(a.orderKey ?? "", b.orderKey ?? "") || compareBinary(a.id, b.id)))
			{
				(outline[row.parentId ?? "root"] ??= []).push(row.id);
			}
			return outline;
		};

		return {
			client,
			apiClient,
			cacheService,
			calls,
			cached,
		};
	}

	describe("WorkflowyWriteThroughClient.createNode priorities", () =>
	{
		afterEach(() =>
		{
			vi.unstubAllGlobals();
		});

		it("caches each created node at Workflowy's priority, not a placeholder, so cached sibling order matches", async () =>
		{
			const {client, calls, cached} = setup();

			await client.createNode(
				{
					parent_id: "home",
					name: "a1",
					position: "top",
				},
			);
			await client.createNode(
				{
					parent_id: "home",
					name: "a2",
					position: "bottom",
				},
			);
			await client.createNode(
				{
					parent_id: "home",
					name: "a3",
					position: "bottom",
				},
			);

			expect(
				{
					calls,
					cached: cached(),
				},
			).toStrictEqual(
				{
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
					cached:
					{
						home: ["a1-id", "existing", "a2-id", "a3-id"],
						root: ["home"],
					},
				},
			);
		});
	});

	describe("WorkflowyWriteThroughClient positional writes after a server renumbering", () =>
	{
		afterEach(() =>
		{
			vi.useRealTimers();
			vi.unstubAllGlobals();
		});

		const crowded: Seed = [
			["home", null, 0],
			["existing1", "home", 1],
			["existing2", "home", 100],
		];

		it("caches a created node and a moved node once each, from the sibling re-read, so a request inside one millisecond never overwrites its own version", async () =>
		{
			vi.useFakeTimers(
				{
					toFake: ["Date"],
					now: new Date("2026-02-01T00:00:00.000Z"),
				},
			);
			const {client, cached} = setup(crowded);

			await client.createNode(
				{
					parent_id: "home",
					name: "n",
					position: "top",
				},
			);
			vi.setSystemTime(new Date("2026-02-01T00:00:00.001Z"));
			await client.moveNode("existing2", "home", -1);

			expect(cached()).toStrictEqual(
				{
					home: ["existing2", "n-id", "existing1"],
					root: ["home"],
				},
			);
		});

		it("re-reads every sibling after a top create, so the renumbered siblings stay in server order", async () =>
		{
			const {client, cached} = setup(crowded);

			await client.createNode(
				{
					parent_id: "home",
					name: "n",
					position: "top",
				},
			);

			expect(cached()).toStrictEqual(
				{
					home: ["n-id", "existing1", "existing2"],
					root: ["home"],
				},
			);
		});

		it("re-reads every sibling after a top move, so the renumbered siblings stay in server order", async () =>
		{
			const {client, cached} = setup(crowded);

			await client.moveNode("existing2", "home", -1);

			expect(cached()).toStrictEqual(
				{
					home: ["existing2", "existing1"],
					root: ["home"],
				},
			);
		});
	});
});

describe("write through mirror complete", () =>
{
	const ORIGINAL_ID = "original-node";
	const MIRROR_ID = "mirror-node";
	const PLAIN_ID = "plain-node";

	/** An API that records which node id each completion targets, over an empty cache that knows one mirror. */
	function fakes()
	{
		const calls: [string, string][] = [];
		const apiClient = new WorkflowyApiClient("test-key");
		vi.spyOn(apiClient, "completeNode").mockImplementation(async (id) =>
		{
			calls.push(["complete", id]);
			return Promise.resolve();
		});
		vi.spyOn(apiClient, "getNode").mockImplementation(async (id) =>
			Promise.resolve(
				{
					id,
					name: "fresh",
					priority: 0,
					createdAt: 0,
					modifiedAt: null,
				},
			),
		);
		const cacheService = new CacheService(buildTestDb().database);
		vi.spyOn(cacheService, "getMirrorOriginal").mockImplementation((id) => (id === MIRROR_ID ? ORIGINAL_ID : null));
		return {
			client: new WorkflowyWriteThroughClient(apiClient, cacheService),
			calls,
		};
	}

	describe("WorkflowyWriteThroughClient completion on mirrors", () =>
	{
		it("completes the original when a mirror is completed", async () =>
		{
			const {client, calls} = fakes();

			const node = await client.completeNode(MIRROR_ID);

			expect(
				{
					calls,
					id: node.id,
				},
			).toStrictEqual(
				{
					calls: [["complete", ORIGINAL_ID]],
					id: ORIGINAL_ID,
				},
			);
		});

		it("completes a plain node in place", async () =>
		{
			const {client, calls} = fakes();

			await client.completeNode(PLAIN_ID);

			expect(calls).toStrictEqual([["complete", PLAIN_ID]]);
		});
	});
});

describe("write through mirror delete", () =>
{
	const moveBodySchema = z.looseObject(
		{
			parent_id: z.string(),
			position: z.enum(["top", "bottom"]),
		},
	);

	const SEEDED_AT = systemTimeAt("2026-01-01 00:00:00.000");

	/*
	 * Siblings are listed in priority order, and mirrors in the order they were created.
	 *
	 * projects
	 *   task-y          (original of mirror-y, whose only mirror sits inside task-a)
	 *   mirror-in       (mirror of other-original, which lives outside)
	 *   task-a          (original of mirror-nested, mirror-b and mirror-out)
	 *     task-a1       (original of mirror-a1)
	 *     mirror-y      (mirror of task-y)
	 *   task-b
	 *     mirror-nested (mirror of task-a, inside projects too)
	 *     mirror-b      (mirror of task-a, its lowest mirror id)
	 * agendas
	 *   agenda-1
	 *   mirror-out      (mirror of task-a)
	 *   agenda-2
	 *   agenda-3
	 * other
	 *   other-original
	 *   mirror-a1       (mirror of task-a1)
	 */
	const TREE: [id: string, parentId: string | null][] = [
		["projects", null],
		["task-y", "projects"],
		["mirror-in", "projects"],
		["task-a", "projects"],
		["task-a1", "task-a"],
		["mirror-y", "task-a"],
		["task-b", "projects"],
		["mirror-nested", "task-b"],
		["mirror-b", "task-b"],
		["agendas", null],
		["agenda-1", "agendas"],
		["mirror-out", "agendas"],
		["agenda-2", "agendas"],
		["agenda-3", "agendas"],
		["other", null],
		["other-original", "other"],
		["mirror-a1", "other"],
	];
	const MIRRORS: [originalId: string, mirrorId: string][] = [
		["other-original", "mirror-in"],
		["task-a", "mirror-nested"],
		["task-a", "mirror-b"],
		["task-a", "mirror-out"],
		["task-a1", "mirror-a1"],
		["task-y", "mirror-y"],
	];

	/** Each parent's children in TREE order, which is also their priority order. */
	function childLists(): Map<string | null, string[]>
	{
		const lists = new Map<string | null, string[]>();
		for (const [id, parentId] of TREE)
		{
			lists.set(parentId, [...(lists.get(parentId) ?? []), id]);
		}
		return lists;
	}

	const INITIAL_OUTLINE =
	{
		root: ["projects", "agendas", "other"],
		projects: ["task-y", "mirror-in", "task-a", "task-b"],
		"task-a": ["task-a1", "mirror-y"],
		"task-b": ["mirror-nested", "mirror-b"],
		agendas: ["agenda-1", "mirror-out", "agenda-2", "agenda-3"],
		other: ["other-original", "mirror-a1"],
	};

	/**
	 * @param failCall A `METHOD /path` call the fake server answers with a 500.
	 * @param serverOutline Children lists the fake server holds in place of the cached ones, as when the cache is stale.
	 */
	function setup({
		failCall,
		serverOutline = {},
		referencesRootIds = [],
	}:
	{
		failCall?: string;
		serverOutline?: Record<string, string[]>;
		/** Nodes to mark as references roots, making their mirror children backlink items. */
		referencesRootIds?: string[];
	} = {})
	{
		const sqlite = migratedMemoryDatabase();
		const database = drizzle(
			sqlite,
			{
				schema,
			},
		);
		const seededLists = childLists();
		database
			.insert(nodeContent)
			.values(
				TREE.map(([id, parentId]) => (
				{
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
				TREE.map(([id, parentId]) => (
				{
					nodeId: id,
					orderKey: integerOrderKey(seededLists.get(parentId)!.indexOf(id)),
					systemFrom: SEEDED_AT,
					systemTo: FAR_FUTURE_DATE,
				})),
			)
			.run();
		database
			.insert(mirrors)
			.values(
				MIRRORS.map(([originalId, mirrorId]) => (
				{
					originalId,
					mirrorId,
					systemFrom: SEEDED_AT,
					systemTo: FAR_FUTURE_DATE,
				})),
			)
			.run();
		for (const nodeId of referencesRootIds)
		{
			database
				.insert(referencesRoots)
				.values(
					{
						nodeId,
						systemFrom: SEEDED_AT,
						systemTo: FAR_FUTURE_DATE,
					},
				)
				.run();
		}

		// A fake Workflowy that tracks each parent's ordered children, so moves and GETs agree.
		const server = childLists();
		for (const [parentId, ids] of Object.entries(serverOutline))
		{
			server.set(parentId, [...ids]);
		}
		const parentOf = (id: string) => [...server].find(([, ids]) => ids.includes(id))?.[0] ?? null;
		const detach = (id: string) =>
		{
			for (const ids of server.values())
			{
				const index = ids.indexOf(id);
				if (index !== -1)
				{
					ids.splice(index, 1);
				}
			}
		};

		const calls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) =>
			{
				const method = init?.method ?? "GET";
				const path = url.replace("https://workflowy.test/api/v1", "");
				const call = `${method} ${path}`;
				calls.push(init?.body === undefined ? call : `${call} ${requestBody(init)}`);
				if (call === failCall)
				{
					return Promise.resolve(
						new Response(
							'{"code":"server_error"}',
							{
								status: 500,
								statusText: "Internal Server Error",
							},
						),
					);
				}
				const toApi = (id: string, parentId: string | null) => (
				{
					id,
					name: id,
					note: null,
					parent_id: parentId,
					priority: server.get(parentId)!.indexOf(id),
					completed: false,
					createdAt: 0,
					modifiedAt: 0,
					completedAt: null,
				});
				if (method === "GET" && path.startsWith("/nodes?parent_id="))
				{
					const parentId = path.slice("/nodes?parent_id=".length);
					// Workflowy lists children in no particular order, so list them reversed.
					const nodes = (server.get(parentId) ?? []).map((id) => toApi(id, parentId)).toReversed();
					return Promise.resolve(
						Response.json(
							{
								nodes,
							},
							{
								status: 200,
							},
						),
					);
				}
				const id = path.split("/")[2];
				if (id === undefined)
				{
					throw new Error(`Unexpected request path: ${path}`);
				}
				if (method === "DELETE")
				{
					detach(id);
				}
				else if (method === "POST" && path.endsWith("/move"))
				{
					const body = moveBodySchema.parse(requestJson(init));
					detach(id);
					const siblings = server.get(body.parent_id) ?? [];
					server.set(body.parent_id, body.position === "top" ? [id, ...siblings] : [...siblings, id]);
				}
				else if (method === "GET")
				{
					return Promise.resolve(
						Response.json(
							{
								node: toApi(id, parentOf(id)),
							},
							{
								status: 200,
							},
						),
					);
				}
				return Promise.resolve(
					new Response(
						'{"status":"ok"}',
						{
							status: 200,
						},
					),
				);
			}),
		);
		const apiClient = new WorkflowyApiClient("test-key", undefined, "https://workflowy.test");
		const client = new WorkflowyWriteThroughClient(apiClient, new CacheService(database));

		/** Each cached parent's current children in sibling order (roots under `root`), and the current mirrors. */
		const cacheState = () =>
		{
			const rows = database
				.select(
					{
						id: nodeContent.id,
						parentId: nodeContent.parentId,
						orderKey: nodeMetadata.orderKey,
					},
				)
				.from(nodeContent)
				.innerJoin(
					nodeMetadata,
					and(eq(nodeMetadata.nodeId, nodeContent.id), eq(nodeMetadata.systemTo, FAR_FUTURE_DATE)),
				)
				.where(eq(nodeContent.systemTo, FAR_FUTURE_DATE))
				.all()
				.toSorted((a, b) => compareBinary(a.orderKey ?? "", b.orderKey ?? "") || compareBinary(a.id, b.id));
			const outline: Record<string, string[]> = {};
			for (const row of rows)
			{
				(outline[row.parentId ?? "root"] ??= []).push(row.id);
			}
			return {
				outline,
				mirrors: database
					.select(
						{
							originalId: mirrors.originalId,
							mirrorId: mirrors.mirrorId,
						},
					)
					.from(mirrors)
					.where(eq(mirrors.systemTo, FAR_FUTURE_DATE))
					.orderBy(mirrors.mirrorId)
					.all(),
			};
		};

		return {
			client,
			calls,
			cacheState,
			database,
			sqlite,
		};
	}

	const PROJECTS_PLAN =
	{
		mirrorIds: ["mirror-in", "mirror-nested", "mirror-b"],
		promotions: [
			{
				originalId: "task-a",
				mirrorId: "mirror-out",
				parentId: "agendas",
				position: "top",
				siblingIds: ["agenda-1"],
				index: 1,
			},
			{
				originalId: "task-y",
				mirrorId: "mirror-y",
				parentId: "task-a",
				position: "bottom",
				siblingIds: [],
				index: 1,
			},
		],
		nodeId: "projects",
	} satisfies DeletePlan;

	describe("WorkflowyWriteThroughClient.deleteNode with mirrors", () =>
	{
		afterEach(() =>
		{
			vi.unstubAllGlobals();
		});

		it("removes a mirror through the mirror endpoint, which also drops it from its original", async () =>
		{
			const {client, calls, cacheState} = setup();

			const plan = await client.deleteNode("mirror-out");

			expect(
				{
					plan,
					calls,
					cache: cacheState(),
				},
			).toStrictEqual(
				{
					plan:
					{
						mirrorIds: ["mirror-out"],
						promotions: [],
						nodeId: null,
					},
					calls: ["DELETE /nodes/mirror-out/mirror"],
					cache:
					{
						outline:
						{
							...INITIAL_OUTLINE,
							agendas: ["agenda-1", "agenda-2", "agenda-3"],
						},
						mirrors: [
							{
								originalId: "task-a1",
								mirrorId: "mirror-a1",
							},
							{
								originalId: "task-a",
								mirrorId: "mirror-b",
							},
							{
								originalId: "other-original",
								mirrorId: "mirror-in",
							},
							{
								originalId: "task-a",
								mirrorId: "mirror-nested",
							},
							{
								originalId: "task-y",
								mirrorId: "mirror-y",
							},
						],
					},
				},
			);
		});

		it("keeps originals with mirrors elsewhere by moving them into a mirror slot, as the web app does, before deleting the rest", async () =>
		{
			const {client, calls, cacheState} = setup();

			const plan = await client.deleteNode("projects");

			expect(
				{
					plan,
					calls,
					cache: cacheState(),
				},
			).toStrictEqual(
				{
					plan: PROJECTS_PLAN,
					calls: [
						"GET /nodes?parent_id=agendas",
						"GET /nodes?parent_id=task-a",
						"DELETE /nodes/mirror-in/mirror",
						"DELETE /nodes/mirror-nested/mirror",
						"DELETE /nodes/mirror-b/mirror",
						"DELETE /nodes/mirror-out/mirror",
						'POST /nodes/task-a/move {"parent_id":"agendas","position":"top"}',
						"GET /nodes/task-a",
						"GET /nodes?parent_id=agendas",
						'POST /nodes/agenda-1/move {"parent_id":"agendas","position":"top"}',
						"GET /nodes/agenda-1",
						"GET /nodes?parent_id=agendas",
						"DELETE /nodes/mirror-y/mirror",
						'POST /nodes/task-y/move {"parent_id":"task-a","position":"bottom"}',
						"GET /nodes/task-y",
						"GET /nodes?parent_id=task-a",
						"DELETE /nodes/projects",
					],
					cache:
					{
						outline:
						{
							root: ["agendas", "other"],
							agendas: ["agenda-1", "task-a", "agenda-2", "agenda-3"],
							"task-a": ["task-a1", "task-y"],
							other: ["other-original", "mirror-a1"],
						},
						mirrors: [
							{
								originalId: "task-a1",
								mirrorId: "mirror-a1",
							},
						],
					},
				},
			);
		});

		it("places a kept original in its mirror's live slot, read from Workflowy, when the cached sibling order is stale", async () =>
		{
			const {client, calls, cacheState} = setup(
				{
					serverOutline:
					{
						agendas: ["agenda-1", "agenda-2", "mirror-out", "agenda-3"],
					},
				},
			);

			const plan = await client.deleteNode("projects");

			expect(
				{
					plan,
					calls,
					cache: cacheState(),
				},
			).toStrictEqual(
				{
					plan:
					{
						...PROJECTS_PLAN,
						promotions: [
							{
								originalId: "task-a",
								mirrorId: "mirror-out",
								parentId: "agendas",
								position: "bottom",
								siblingIds: ["agenda-3"],
								index: 2,
							},
							PROJECTS_PLAN.promotions[1],
						],
					},
					calls: [
						"GET /nodes?parent_id=agendas",
						"GET /nodes?parent_id=task-a",
						"DELETE /nodes/mirror-in/mirror",
						"DELETE /nodes/mirror-nested/mirror",
						"DELETE /nodes/mirror-b/mirror",
						"DELETE /nodes/mirror-out/mirror",
						'POST /nodes/task-a/move {"parent_id":"agendas","position":"bottom"}',
						"GET /nodes/task-a",
						"GET /nodes?parent_id=agendas",
						'POST /nodes/agenda-3/move {"parent_id":"agendas","position":"bottom"}',
						"GET /nodes/agenda-3",
						"GET /nodes?parent_id=agendas",
						"DELETE /nodes/mirror-y/mirror",
						'POST /nodes/task-y/move {"parent_id":"task-a","position":"bottom"}',
						"GET /nodes/task-y",
						"GET /nodes?parent_id=task-a",
						"DELETE /nodes/projects",
					],
					cache:
					{
						outline:
						{
							root: ["agendas", "other"],
							agendas: ["agenda-1", "agenda-2", "task-a", "agenda-3"],
							"task-a": ["task-a1", "task-y"],
							other: ["other-original", "mirror-a1"],
						},
						mirrors: [
							{
								originalId: "task-a1",
								mirrorId: "mirror-a1",
							},
						],
					},
				},
			);
		});

		it("moves a target with several mirrors elsewhere into the one with the lowest id, as the web app does on a fresh load, leaves the others mirroring it, and deletes nothing", async () =>
		{
			const {client, calls, cacheState} = setup();

			const plan = await client.deleteNode("task-a");

			expect(
				{
					plan,
					calls,
					cache: cacheState(),
				},
			).toStrictEqual(
				{
					plan:
					{
						mirrorIds: [],
						promotions: [
							{
								originalId: "task-a",
								mirrorId: "mirror-b",
								parentId: "task-b",
								position: "bottom",
								siblingIds: [],
								index: 1,
							},
						],
						nodeId: null,
					},
					calls: [
						"GET /nodes?parent_id=task-b",
						"DELETE /nodes/mirror-b/mirror",
						'POST /nodes/task-a/move {"parent_id":"task-b","position":"bottom"}',
						"GET /nodes/task-a",
						"GET /nodes?parent_id=task-b",
					],
					cache:
					{
						outline:
						{
							...INITIAL_OUTLINE,
							projects: ["task-y", "mirror-in", "task-b"],
							"task-b": ["mirror-nested", "task-a"],
						},
						mirrors: [
							{
								originalId: "task-a1",
								mirrorId: "mirror-a1",
							},
							{
								originalId: "other-original",
								mirrorId: "mirror-in",
							},
							{
								originalId: "task-a",
								mirrorId: "mirror-nested",
							},
							{
								originalId: "task-a",
								mirrorId: "mirror-out",
							},
							{
								originalId: "task-y",
								mirrorId: "mirror-y",
							},
						],
					},
				},
			);
		});

		it("deletes a backlink source without promoting it into its backlink item, which stays in place", async () =>
		{
			const {client, calls, cacheState} = setup(
				{
					referencesRootIds: ["other"],
				},
			);

			const plan = await client.deleteNode("task-a1");

			expect(
				{
					plan,
					calls,
					cache: cacheState(),
				},
			).toStrictEqual(
				{
					plan:
					{
						mirrorIds: [],
						promotions: [],
						nodeId: "task-a1",
					},
					calls: ["DELETE /nodes/task-a1"],
					cache:
					{
						outline:
						{
							...INITIAL_OUTLINE,
							"task-a": ["mirror-y"],
						},
						mirrors: [
							{
								originalId: "task-a",
								mirrorId: "mirror-b",
							},
							{
								originalId: "other-original",
								mirrorId: "mirror-in",
							},
							{
								originalId: "task-a",
								mirrorId: "mirror-nested",
							},
							{
								originalId: "task-a",
								mirrorId: "mirror-out",
							},
							{
								originalId: "task-y",
								mirrorId: "mirror-y",
							},
						],
					},
				},
			);
		});

		it("ends the promoted mirror's composite and moves the original into its slot at one system time", async () =>
		{
			const {client, database} = setup();
			database
				.insert(nodeEmbeddings)
				.values(
					{
						nodeId: "mirror-b",
						model: "minilm",
						embedding: Buffer.from([1]),
						systemFrom: SEEDED_AT,
						systemTo: FAR_FUTURE_DATE,
					},
				)
				.run();

			await client.deleteNode("task-a");

			const promoted = database
				.select(
					{
						systemFrom: nodeContent.systemFrom,
					},
				)
				.from(nodeContent)
				.where(and(eq(nodeContent.id, "task-a"), eq(nodeContent.parentId, "task-b")))
				.get();
			const ended = [
				database
					.select(
						{
							systemTo: nodeContent.systemTo,
						},
					)
					.from(nodeContent)
					.where(eq(nodeContent.id, "mirror-b"))
					.get(),
				database
					.select(
						{
							systemTo: nodeMetadata.systemTo,
						},
					)
					.from(nodeMetadata)
					.where(eq(nodeMetadata.nodeId, "mirror-b"))
					.get(),
				database
					.select(
						{
							systemTo: nodeEmbeddings.systemTo,
						},
					)
					.from(nodeEmbeddings)
					.where(eq(nodeEmbeddings.nodeId, "mirror-b"))
					.get(),
				database
					.select(
						{
							systemTo: mirrors.systemTo,
						},
					)
					.from(mirrors)
					.where(eq(mirrors.mirrorId, "mirror-b"))
					.get(),
			].map((row) => row?.systemTo);
			expect([...new Set([promoted?.systemFrom, ...ended])]).toStrictEqual([promoted?.systemFrom]);
		});

		it("rolls back the whole promotion in the cache when versioning the original fails", async () =>
		{
			const {client, cacheState, sqlite} = setup();
			const before = cacheState();
			sqlite.exec(
				"CREATE TRIGGER fail_promotion BEFORE INSERT ON node_content WHEN NEW.id = 'task-a' BEGIN SELECT RAISE(ABORT, 'promotion failed'); END",
			);

			await expect(client.deleteNode("task-a")).rejects.toThrow("promotion failed");

			expect(cacheState()).toStrictEqual(before);
		});

		it("deletes a node without mirrors through the generic endpoint only", async () =>
		{
			const {client, calls} = setup();

			const plan = await client.deleteNode("agenda-2");

			expect(
				{
					plan,
					calls,
				},
			).toStrictEqual(
				{
					plan:
					{
						mirrorIds: [],
						promotions: [],
						nodeId: "agenda-2",
					},
					calls: ["DELETE /nodes/agenda-2"],
				},
			);
		});

		it("plans a delete from the live sibling order without changing Workflowy or the cache", async () =>
		{
			const {client, calls, cacheState} = setup();
			const before = cacheState();

			const plan = await client.planDelete("projects");

			expect(
				{
					plan,
					calls,
					cache: cacheState(),
				},
			).toStrictEqual(
				{
					plan: PROJECTS_PLAN,
					calls: ["GET /nodes?parent_id=agendas", "GET /nodes?parent_id=task-a"],
					cache: before,
				},
			);
		});

		it("does not send the generic delete when removing an inner mirror fails, so no dead reference is left", async () =>
		{
			const {client, calls, cacheState} = setup(
				{
					failCall: "DELETE /nodes/mirror-nested/mirror",
				},
			);

			await expect(client.deleteNode("projects")).rejects.toThrow(
				'Failed to delete mirror: 500 Internal Server Error\n{"code":"server_error"}',
			);

			expect(
				{
					calls,
					cache: cacheState(),
				},
			).toStrictEqual(
				{
					calls: [
						"GET /nodes?parent_id=agendas",
						"GET /nodes?parent_id=task-a",
						"DELETE /nodes/mirror-in/mirror",
						"DELETE /nodes/mirror-nested/mirror",
					],
					cache:
					{
						outline:
						{
							...INITIAL_OUTLINE,
							projects: ["task-y", "task-a", "task-b"],
						},
						mirrors: [
							{
								originalId: "task-a1",
								mirrorId: "mirror-a1",
							},
							{
								originalId: "task-a",
								mirrorId: "mirror-b",
							},
							{
								originalId: "task-a",
								mirrorId: "mirror-nested",
							},
							{
								originalId: "task-a",
								mirrorId: "mirror-out",
							},
							{
								originalId: "task-y",
								mirrorId: "mirror-y",
							},
						],
					},
				},
			);
		});

		it("does not send the generic delete when moving a kept original fails, so its content survives", async () =>
		{
			const {client, calls, cacheState} = setup(
				{
					failCall: "POST /nodes/task-a/move",
				},
			);

			await expect(client.deleteNode("projects")).rejects.toThrow(
				'Failed to move node: 500 Internal Server Error\n{"code":"server_error"}',
			);

			expect(
				{
					calls,
					cache: cacheState(),
				},
			).toStrictEqual(
				{
					calls: [
						"GET /nodes?parent_id=agendas",
						"GET /nodes?parent_id=task-a",
						"DELETE /nodes/mirror-in/mirror",
						"DELETE /nodes/mirror-nested/mirror",
						"DELETE /nodes/mirror-b/mirror",
						"DELETE /nodes/mirror-out/mirror",
						'POST /nodes/task-a/move {"parent_id":"agendas","position":"top"}',
					],
					cache:
					{
						outline:
						{
							root: ["projects", "agendas", "other"],
							projects: ["task-y", "task-a", "task-b"],
							"task-a": ["task-a1", "mirror-y"],
							agendas: ["agenda-1", "agenda-2", "agenda-3"],
							other: ["other-original", "mirror-a1"],
						},
						mirrors: [
							{
								originalId: "task-a1",
								mirrorId: "mirror-a1",
							},
							{
								originalId: "task-y",
								mirrorId: "mirror-y",
							},
						],
					},
				},
			);
		});
	});
});

describe("write through mirror update", () =>
{
	const ORIGINAL_ID = "original-node";
	const MIRROR_ID = "mirror-node";
	const PLAIN_ID = "plain-node";

	/** An API that records which node id each update targets, over an empty cache that knows one mirror. */
	function fakes()
	{
		const updates: [string, UpdateNodeRequest][] = [];
		const apiClient = new WorkflowyApiClient("test-key");
		vi.spyOn(apiClient, "updateNode").mockImplementation(async (id, request) =>
		{
			updates.push([id, request]);
			return Promise.resolve();
		});
		vi.spyOn(apiClient, "getNode").mockImplementation(async (id) =>
			Promise.resolve(
				{
					id,
					name: "fresh",
					priority: 0,
					createdAt: 0,
					modifiedAt: null,
				},
			),
		);
		const cacheService = new CacheService(buildTestDb().database);
		vi.spyOn(cacheService, "getMirrorOriginal").mockImplementation((id) => (id === MIRROR_ID ? ORIGINAL_ID : null));
		return {
			client: new WorkflowyWriteThroughClient(apiClient, cacheService),
			updates,
		};
	}

	describe("WorkflowyWriteThroughClient.resolveUpdateTarget on mirrors", () =>
	{
		it("resolves the update target the same way for callers that pre-check the current text", () =>
		{
			const {client} = fakes();

			expect([client.resolveUpdateTarget(MIRROR_ID), client.resolveUpdateTarget(PLAIN_ID)]).toStrictEqual([
				ORIGINAL_ID,
				PLAIN_ID,
			]);
		});
	});
});

describe("write through uncached parent", () =>
{
	const NODE_ID = "uncached-node";
	const PARENT_ID = "api-parent";

	/** An API whose node lives under a parent at Home, over an empty cache. */
	function fakes()
	{
		const apiClient = new WorkflowyApiClient("test-key");
		vi.spyOn(apiClient, "updateNode").mockResolvedValue();
		vi.spyOn(apiClient, "completeNode").mockResolvedValue();
		vi.spyOn(apiClient, "getNode").mockImplementation(async (id) =>
			Promise.resolve(
				id === NODE_ID
					?
						{
							id,
							name: "fresh",
							parent_id: PARENT_ID,
							priority: 0,
							createdAt: 0,
							modifiedAt: null,
						}
					:
						{
							id,
							name: "parent",
							priority: 0,
							createdAt: 0,
							modifiedAt: null,
						},
			),
		);
		const cacheService = new CacheService(buildTestDb().database);
		return {
			client: new WorkflowyWriteThroughClient(apiClient, cacheService),
			cacheService,
		};
	}

	describe("WorkflowyWriteThroughClient caching a node it had not cached", () =>
	{
		it("files a completed node under the parent the API reports", async () =>
		{
			const {client, cacheService} = fakes();

			await client.completeNode(NODE_ID);

			expect(cacheService.getNode(NODE_ID)?.parentId).toBe(PARENT_ID);
		});
	});
});
