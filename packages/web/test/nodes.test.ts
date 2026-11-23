import {afterEach, describe, expect, it, vi, beforeEach} from "vite-plus/test";
import type DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {Hono} from "hono";
import
{
	BULK_IMPORT_LEASE_NAME,
	BULK_IMPORT_TIMEOUT_MS,
	closeCurrentVersions,
	runUnitOfWork,
	stampImportTime,
	TRANSACTION_TIMEOUT_MS,
	CacheService,
	readPendingAccountOutbox,
	readPendingOutbox,
	replaceExpansion,
} from "@outlinedb/shared/cache";
import {eq} from "drizzle-orm";
import * as schema from "@outlinedb/shared/db";
import type {WorkflowyNode} from "@outlinedb/shared/types";
import type {AppEnv, ServerContext} from "../src/server/context.js";
import type {NodeChangesResponse, NodeResponse} from "../src/node-types.js";
import {httpAppFor} from "./http-app-for.js";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import {WorkflowyApiClient} from "@outlinedb/shared/api";
import type {WorkflowyInternalAdapter} from "@outlinedb/shared/internal";
import {readNodeConfig} from "../src/server/config.js";
import {buildServerContext} from "../src/server/context.js";
import {changesAfter} from "../src/server/system-changes.js";
import {LadderEventBus} from "../src/server/ladder-events.js";
import {inProcessStore} from "../src/server/store.js";
import type {StoreClient} from "../src/server/store.js";
import {upstreamExpansionKey} from "@outlinedb/shared/workflowy";
import {integerOrderKey} from "./helpers/integer-order-key.js";
import {migratedMemoryDatabase} from "../../shared/test/helpers/migrated-memory-database.js";

describe("nodes changes route", () =>
{
	function apiNode(id: string, parentId: string | null, priority: number): WorkflowyNode
	{
		return {
			id,
			name: id,
			note: null,
			parent_id: parentId,
			priority,
			createdAt: 100,
			modifiedAt: 200,
			completed: false,
		};
	}

	/** When `setup` seeds the tree; tests move the clock relative to it. */
	const T0 = Date.parse("2026-10-29T12:00:00.000Z");

	/** The temporal timestamp `ms` after {@link T0}. */
	/** The changes-feed mark for `ms` milliseconds plus `micros` microseconds after {@link T0}. */
	function stamp(ms: number, micros = 0): string
	{
		return String((T0 + ms) * 1000 + micros);
	}

	/**
	 * Home holds `parents` parents P0.., each with two children, seeded at {@link T0}. The clock then stands a
	 * transaction timeout plus a minute later, so the seeding falls behind every watermark the test sees.
	 */
	function setup(parents: number)
	{
		vi.useFakeTimers(
			{
				toFake: ["Date"],
				now: T0,
			},
		);
		const sqlite = migratedMemoryDatabase();
		let statements = 0;
		const db = drizzle(
			sqlite,
			{
				schema,
				logger:
				{
					logQuery()
					{
						statements += 1;
					},
				},
			},
		);
		const cacheService = new CacheService(db);
		for (let p = 0; p < parents; p++)
		{
			cacheService.insertNode(apiNode(`P${p}`, null, p), null);
			for (let k = 0; k < 2; k++)
			{
				cacheService.insertNode(apiNode(`P${p}c${k}`, `P${p}`, k), `P${p}`);
			}
		}
		vi.setSystemTime(T0 + TRANSACTION_TIMEOUT_MS + 60_000);
		const ctx =
		{
			db,
			cacheService,
		} as unknown as ServerContext;
		const app = new Hono<AppEnv>();
		app.use("*", async (c, next) =>
		{
			c.set("ctx", ctx);
			await next();
		});
		app.route("/", httpAppFor(ctx));
		const changes = async (since: string | null) =>
		{
			const before = statements;
			const query = since === null ? "" : `?since=${encodeURIComponent(since)}`;
			const res = await app.fetch(new Request(`http://x/api/v1/nodes/changes${query}`));
			const body = (await res.json()) as NodeChangesResponse;
			return {
				status: res.status,
				body,
				statements: statements - before,
			};
		};
		return {
			db,
			cacheService,
			changes,
		};
	}

	/** A response reduced to what a test compares: id sets, and each list as parent -> child ids. */
	function shape(body: NodeChangesResponse)
	{
		return {
			reset: body.reset,
			changedIds: new Set(body.changedIds),
			deletedIds: new Set(body.deletedIds),
			children: Object.fromEntries(
				body.children.map(({parentId, nodes}) => [parentId ?? "home", nodes.map((node) => node.id)]),
			),
		};
	}

	describe("GET /api/v1/nodes/changes", () =>
	{
		afterEach(() =>
		{
			vi.useRealTimers();
		});

		it("without since answers only the watermark: now less the transaction timeout", async () =>
		{
			const {changes} = setup(1);

			const {status, body} = await changes(null);

			expect(
				{
					status,
					latest: body.latest,
					...shape(body),
				},
			).toStrictEqual(
				{
					status: 200,
					latest: stamp(60_000),
					reset: false,
					changedIds: new Set(),
					deletedIds: new Set(),
					children: {},
				},
			);
		});

		it("answers a created node with its parent's refreshed children", async () =>
		{
			const {cacheService, changes} = setup(2);
			const seeded = await changes(null);
			vi.setSystemTime(T0 + TRANSACTION_TIMEOUT_MS + 70_000);
			cacheService.insertNode(apiNode("New", "P1", 5), "P1");

			const {body} = await changes(seeded.body.latest);

			expect(
				{
					latest: body.latest,
					...shape(body),
				},
			).toStrictEqual(
				{
					latest: stamp(70_000),
					reset: false,
					changedIds: new Set(["New"]),
					deletedIds: new Set(),
					children:
					{
						P1: ["P1c0", "P1c1", "New"],
					},
				},
			);
		});

		it("answers a moved node with both its old and new parents' children", async () =>
		{
			const {cacheService, changes} = setup(2);
			const seeded = await changes(null);
			cacheService.insertNode(apiNode("P0c1", "P1", 5), "P1");

			const {body} = await changes(seeded.body.latest);

			expect(shape(body)).toStrictEqual(
				{
					reset: false,
					changedIds: new Set(["P0c1"]),
					deletedIds: new Set(),
					children:
					{
						P0: ["P0c0"],
						P1: ["P1c0", "P1c1", "P0c1"],
					},
				},
			);
		});

		it("answers a deleted node as deleted, with its parent's children", async () =>
		{
			const {cacheService, changes} = setup(2);
			const seeded = await changes(null);
			cacheService.deleteNode("P1c0");

			const {body} = await changes(seeded.body.latest);

			expect(shape(body)).toStrictEqual(
				{
					reset: false,
					changedIds: new Set(["P1c0"]),
					deletedIds: new Set(["P1c0"]),
					children:
					{
						P1: ["P1c1"],
					},
				},
			);
		});

		it("delivers a change stamped before an earlier poll's watermark that commits after it", async () =>
		{
			const {cacheService, changes} = setup(2);
			const seeded = await changes(null);
			vi.setSystemTime(T0 + TRANSACTION_TIMEOUT_MS + 70_000);
			cacheService.insertNode(apiNode("Later", "P0", 5), "P0");
			const first = await changes(seeded.body.latest);
			// A unit that read the clock before "Later" and committed after the first poll, within the timeout.
			vi.setSystemTime(T0 + TRANSACTION_TIMEOUT_MS + 40_000);
			cacheService.insertNode(apiNode("Earlier", "P1", 5), "P1");
			vi.setSystemTime(T0 + TRANSACTION_TIMEOUT_MS + 80_000);
			const second = await changes(first.body.latest);
			// Past the timeout window, the re-reads stop.
			vi.setSystemTime(T0 + 3 * TRANSACTION_TIMEOUT_MS + 120_000);
			const third = await changes(second.body.latest);
			const fourth = await changes(third.body.latest);

			const reduce = ({body}: {body: NodeChangesResponse}) => (
			{
				latest: body.latest,
				...shape(body),
			});
			expect(
				{
					first: reduce(first),
					second: reduce(second),
					third: reduce(third),
					fourth: reduce(fourth),
				},
			).toStrictEqual(
				{
					first:
					{
						latest: stamp(70_000),
						reset: false,
						changedIds: new Set(["Later"]),
						deletedIds: new Set(),
						children:
						{
							P0: ["P0c0", "P0c1", "Later"],
						},
					},
					// The last timeout window is read again, so "Later" repeats, once, beside "Earlier".
					second:
					{
						latest: stamp(80_000),
						reset: false,
						changedIds: new Set(["Later", "Earlier"]),
						deletedIds: new Set(),
						children:
						{
							P0: ["P0c0", "P0c1", "Later"],
							P1: ["P1c0", "P1c1", "Earlier"],
						},
					},
					third:
					{
						latest: stamp(2 * TRANSACTION_TIMEOUT_MS + 120_000),
						reset: false,
						changedIds: new Set(["Later", "Earlier"]),
						deletedIds: new Set(),
						children:
						{
							P0: ["P0c0", "P0c1", "Later"],
							P1: ["P1c0", "P1c1", "Earlier"],
						},
					},
					fourth:
					{
						latest: stamp(2 * TRANSACTION_TIMEOUT_MS + 120_000),
						reset: false,
						changedIds: new Set(),
						deletedIds: new Set(),
						children: {},
					},
				},
			);
			expect(second.body.changedIds).toStrictEqual([...new Set(second.body.changedIds)]);
		});

		it("holds the watermark before an in-flight bulk import's lease, so its late commit still arrives", async () =>
		{
			const {db, cacheService, changes} = setup(1);
			const leaseAt = T0 + TRANSACTION_TIMEOUT_MS + 60_000;
			runUnitOfWork(db, (unitOfWork) =>
			{
				stampImportTime(unitOfWork, BULK_IMPORT_LEASE_NAME, leaseAt + BULK_IMPORT_TIMEOUT_MS);
			});
			// The import runs five minutes, far past the transaction timeout.
			vi.setSystemTime(leaseAt + 300_000);
			const during = await changes(null);
			// It commits a row stamped when it read the clock, right after taking its lease, and ends the lease.
			vi.setSystemTime(leaseAt);
			cacheService.insertNode(apiNode("Bulk", "P0", 5), "P0");
			vi.setSystemTime(leaseAt + 300_001);
			runUnitOfWork(db, ({tx, systemTime}) =>
			{
				closeCurrentVersions(
					tx,
					schema.apiImportTimestamp,
					systemTime,
					eq(schema.apiImportTimestamp.name, BULK_IMPORT_LEASE_NAME),
				);
			});
			const after = await changes(during.body.latest);

			const reduce = ({body}: {body: NodeChangesResponse}) => (
			{
				latest: body.latest,
				...shape(body),
			});
			expect(
				{
					during: reduce(during),
					after: reduce(after),
				},
			).toStrictEqual(
				{
					during:
					{
						latest: stamp(TRANSACTION_TIMEOUT_MS + 60_000, -1),
						reset: false,
						changedIds: new Set(),
						deletedIds: new Set(),
						children: {},
					},
					after:
					{
						latest: stamp(TRANSACTION_TIMEOUT_MS + 60_000 + 300_001 - TRANSACTION_TIMEOUT_MS),
						reset: false,
						changedIds: new Set(["Bulk"]),
						deletedIds: new Set(),
						children:
						{
							P0: ["P0c0", "P0c1", "Bulk"],
						},
					},
				},
			);
		});

		it("ignores a bulk import lease past its expiry, which a crashed import leaves open", async () =>
		{
			const {db, changes} = setup(1);
			const leaseAt = T0 + TRANSACTION_TIMEOUT_MS + 60_000;
			runUnitOfWork(db, (unitOfWork) =>
			{
				stampImportTime(unitOfWork, BULK_IMPORT_LEASE_NAME, leaseAt + BULK_IMPORT_TIMEOUT_MS);
			});
			vi.setSystemTime(leaseAt + BULK_IMPORT_TIMEOUT_MS + 1000);

			const {body} = await changes(null);

			expect(body.latest).toBe(stamp(60_000 + BULK_IMPORT_TIMEOUT_MS + 1000));
		});

		it("counts the limit in changed nodes, not in the version rows each one opens and closes", async () =>
		{
			const {db, cacheService, changes} = setup(2);
			const seeded = await changes(null);
			// Each move opens one node_content version and closes another: six rows for three nodes.
			cacheService.insertNode(apiNode("P0c0", "P1", 5), "P1");
			cacheService.insertNode(apiNode("P0c1", "P1", 6), "P1");
			cacheService.insertNode(apiNode("P1c0", "P0", 5), "P0");

			expect(
				{
					atLimit: changesAfter(db, seeded.body.latest, 3)?.ids,
					overLimit: changesAfter(db, seeded.body.latest, 2),
				},
			).toStrictEqual(
				{
					atLimit: new Set(["P0c0", "P0c1", "P1c0"]),
					overLimit: undefined,
				},
			);
		});

		it("answers reset for a cursor it never issued", async () =>
		{
			const {changes} = setup(1);
			const seeded = await changes(null);

			const resets = await Promise.all(
				["not-a-mark", stamp(60_001)].map(async (since) =>
				{
					const {body} = await changes(since);
					return {
						reset: body.reset,
						latest: body.latest,
					};
				}),
			);

			expect(resets).toStrictEqual([
				{
					reset: true,
					latest: seeded.body.latest,
				},
				{
					reset: true,
					latest: seeded.body.latest,
				},
			]);
		});

		it("keeps its statement count independent of how many parents changed", async () =>
		{
			const run = async (parents: number) =>
			{
				const {cacheService, changes} = setup(parents);
				const seeded = await changes(null);
				vi.setSystemTime(T0 + TRANSACTION_TIMEOUT_MS + 70_000);
				for (let p = 0; p < parents; p++)
				{
					cacheService.insertNode(apiNode(`New${p}`, `P${p}`, 5), `P${p}`);
				}
				return changes(seeded.body.latest);
			};

			const few = await run(2);
			const many = await run(12);

			expect(
				{
					few: Object.keys(shape(few.body).children).length,
					many: Object.keys(shape(many.body).children).length,
					same: few.statements === many.statements,
				},
			).toStrictEqual(
				{
					few: 2,
					many: 12,
					same: true,
				},
			);
			expect(many.statements).toBeLessThanOrEqual(40);
		});
	});
});

describe("nodes children batch route", () =>
{
	function apiNode(id: string, parentId: string | null, priority: number, completedAt?: number): WorkflowyNode
	{
		return {
			id,
			name: id,
			note: null,
			parent_id: parentId,
			priority,
			createdAt: 100,
			modifiedAt: 200,
			completed: completedAt !== undefined,
			...(completedAt === undefined
				? {}
				:
					{
						completedAt,
					}),
		};
	}

	/** Home holds Alpha>{A1>{A1a}, A2 (completed)} and Beta>{B1}. */
	function setup()
	{
		const sqlite = migratedMemoryDatabase();
		const db = drizzle(
			sqlite,
			{
				schema,
			},
		);
		const cacheService = new CacheService(db);
		cacheService.insertNode(apiNode("Alpha", null, 0), null);
		cacheService.insertNode(apiNode("Beta", null, 1), null);
		cacheService.insertNode(apiNode("A1", "Alpha", 0), "Alpha");
		cacheService.insertNode(apiNode("A2", "Alpha", 1, 300), "Alpha");
		cacheService.insertNode(apiNode("A1a", "A1", 0), "A1");
		cacheService.insertNode(apiNode("B1", "Beta", 0), "Beta");
		const ctx =
		{
			db,
			cacheService,
		} as unknown as ServerContext;
		const app = new Hono<AppEnv>();
		app.use("*", async (c, next) =>
		{
			c.set("ctx", ctx);
			await next();
		});
		app.route("/", httpAppFor(ctx));
		const post = async (body: unknown) =>
		{
			const res = await app.fetch(
				new Request(
					"http://x/api/v1/nodes/children",
					{
						method: "POST",
						headers:
						{
							"Content-Type": "application/json",
						},
						body: JSON.stringify(body),
					},
				),
			);
			return {
				status: res.status,
				body: await res.json(),
			};
		};
		/** Make `mirrorId` (a new child of `parentId`) a mirror of `originalId`. */
		const mirror = (mirrorId: string, parentId: string, originalId: string) =>
		{
			cacheService.insertNode(apiNode(mirrorId, parentId, 9), parentId);
			sqlite
				.prepare("INSERT INTO mirrors (mirror_id, original_id, system_from, system_to) VALUES (?, ?, ?, ?)")
				.run(mirrorId, originalId, "2000-01-01T00:00:00.000Z", FAR_FUTURE_DATE);
		};
		return {
			post,
			mirror,
		};
	}

	/** The ids of each listed parent's children, in order. */
	function childIds(
		children: Record<
			string,
			{
				id: string;
			}[]
		>,
	): Record<string, string[]>
	{
		return Object.fromEntries(Object.entries(children).map(([id, nodes]) => [id, nodes.map((node) => node.id)]));
	}

	describe("POST /api/v1/nodes/children", () =>
	{
		it("returns the children of every requested parent in one response, like one GET per parent", async () =>
		{
			const {post} = setup();

			const {status, body} = await post(
				{
					parentIds: ["Alpha", "A1", "B1", "missing"],
				},
			);

			expect(
				{
					status,
					children: childIds(body.children),
				},
			).toStrictEqual(
				{
					status: 200,
					children:
					{
						Alpha: ["A1", "A2"],
						A1: ["A1a"],
						B1: [],
						missing: [],
					},
				},
			);
		});

		it("lists a mirror's original's children under the mirror's id", async () =>
		{
			const {post, mirror} = setup();
			mirror("M", "Beta", "Alpha");

			const {body} = await post(
				{
					parentIds: ["M"],
				},
			);

			expect(childIds(body.children)).toStrictEqual(
				{
					M: ["A1", "A2"],
				},
			);
		});

		it("rejects a body without a parentIds string array", async () =>
		{
			const {post} = setup();

			await expect(
				post(
					{
						parentIds: "Alpha",
					},
				),
			).resolves.toStrictEqual(
				{
					status: 400,
					body:
					{
						error: "parentIds must be an array of strings",
					},
				},
			);
		});
	});
});

describe("nodes complete mirror route", () =>
{
	interface Row
	{
		id: string;
		completedAt: number | null;
	}

	interface CompleteBody
	{
		node: Row &
		{
			parent_id: string | null;
			isMirror: boolean;
			originalNodeId: string | null;
		};
		nodes: Row[];
	}

	function apiNode(id: string, parentId: string | null, priority: number, completedAt?: number): WorkflowyNode
	{
		return {
			id,
			name: id,
			note: null,
			parent_id: parentId,
			priority,
			createdAt: 100,
			modifiedAt: 200,
			completed: completedAt !== undefined,
			...(completedAt === undefined
				? {}
				:
					{
						completedAt,
					}),
		};
	}

	/** Home holds P and Q. O (original) sits under Q; P holds mirror M of O. */
	function setup()
	{
		const sqlite = migratedMemoryDatabase();
		const db = drizzle(
			sqlite,
			{
				schema,
			},
		);
		const cacheService = new CacheService(db);
		cacheService.insertNode(apiNode("P", null, 0), null);
		cacheService.insertNode(apiNode("Q", null, 1), null);
		cacheService.insertNode(apiNode("O", "Q", 0), "Q");
		cacheService.insertNode(apiNode("M", "P", 0), "P");
		sqlite
			.prepare("INSERT INTO mirrors (mirror_id, original_id, system_from, system_to) VALUES (?, ?, ?, ?)")
			.run("M", "O", "2000-01-01T00:00:00.000Z", FAR_FUTURE_DATE);

		// A mirror host whose adapter is never called: completion is a local write plus an outbox row.
		const ctx =
		{
			db,
			cacheService,
			mode: "mirror",
			apiKey: "test-key",
			config: {} as ServerContext["config"],
			internalAuth: {},
			internalAdapter: () => ({}) as WorkflowyInternalAdapter,
		} as unknown as ServerContext;
		const app = new Hono<AppEnv>();
		app.use("*", async (c, next) =>
		{
			c.set("ctx", ctx);
			await next();
		});
		app.route("/", httpAppFor(ctx));
		const request = async (method: string, path: string) =>
		{
			const res = await app.fetch(
				new Request(
					`http://x/api/v1/nodes${path}`,
					{
						method,
					},
				),
			);
			return {
				status: res.status,
				body: (await res.json()) as CompleteBody,
			};
		};
		/** Every pending outbox row as `id:aspect`, sorted. */
		const pending = () =>
			readPendingOutbox(db, 1000)
				.map(({nodeId, aspect}) => `${nodeId}:${aspect}`)
				// oxlint-disable-next-line unicorn/no-array-sort -- the test tsconfig lib has no toSorted
				.sort();
		return {
			request,
			pending,
		};
	}

	describe("POST /api/v1/nodes/:id/complete and /uncomplete on a mirror", () =>
	{
		afterEach(() =>
		{
			vi.restoreAllMocks();
		});

		it("completes the original, answers the mirror row with the original's completion, and lists both as done", async () =>
		{
			const {request, pending} = setup();

			const completed = await request("POST", "/M/complete");
			const mirrorList = await request("GET", "?parent_id=P");
			const originalList = await request("GET", "?parent_id=Q");

			expect(
				{
					pending: pending(),
					node:
					{
						id: completed.body.node.id,
						parent_id: completed.body.node.parent_id,
						isMirror: completed.body.node.isMirror,
						originalNodeId: completed.body.node.originalNodeId,
						completed: typeof completed.body.node.completedAt === "number",
					},
					mirror: mirrorList.body.nodes.map((n) => [n.id, typeof n.completedAt]),
					original: originalList.body.nodes.map((n) => [n.id, typeof n.completedAt]),
				},
			).toStrictEqual(
				{
					pending: ["O:completion"],
					node:
					{
						id: "M",
						parent_id: "P",
						isMirror: true,
						originalNodeId: "O",
						completed: true,
					},
					mirror: [["M", "number"]],
					original: [["O", "number"]],
				},
			);
		});

		it("uncompletes the original and answers the mirror row as open", async () =>
		{
			const {request, pending} = setup();
			await request("POST", "/M/complete");

			const reopened = await request("POST", "/M/uncomplete");

			expect(
				{
					pending: pending(),
					node: [reopened.body.node.id, reopened.body.node.isMirror, reopened.body.node.completedAt],
				},
			).toStrictEqual(
				{
					pending: ["O:completion"],
					node: ["M", true, null],
				},
			);
		});
	});
});

describe("nodes duplicate route", () =>
{
	function apiNode(
		id: string,
		parentId: string | null,
		priority: number,
		extra: Partial<WorkflowyNode> = {},
	): WorkflowyNode
	{
		return {
			id,
			name: id.toLowerCase(),
			note: null,
			parent_id: parentId,
			priority,
			createdAt: 100,
			modifiedAt: 200,
			...extra,
		};
	}

	/** Home holds P and O; O (completed, note "n") holds C (with G) and E, a mirror of X; X holds Y. */
	function setup(expanded: string[] = [], mode: "mirror" | "standalone" = "mirror")
	{
		const sqlite = migratedMemoryDatabase();
		const db = drizzle(
			sqlite,
			{
				schema,
			},
		);
		const cacheService = new CacheService(db);
		cacheService.insertNode(apiNode("P", null, 0), null);
		cacheService.insertNode(
			apiNode(
				"O",
				null,
				1,
				{
					note: "n",
					completed: true,
					completedAt: 5,
				},
			),
			null,
		);
		cacheService.insertNode(apiNode("X", null, 2), null);
		cacheService.insertNode(apiNode("Y", "X", 0), "X");
		cacheService.insertNode(apiNode("C", "O", 0), "O");
		cacheService.insertNode(apiNode("G", "C", 0), "C");
		cacheService.insertNode(apiNode("E", "O", 1), "O");
		cacheService.insertNode(apiNode("M", "P", 0), "P");
		const link = sqlite.prepare(
			"INSERT INTO mirrors (mirror_id, original_id, system_from, system_to) VALUES (?, ?, ?, ?)",
		);
		link.run("E", "X", "2000-01-01T00:00:00.000Z", FAR_FUTURE_DATE);
		link.run("M", "O", "2000-01-01T00:00:00.000Z", FAR_FUTURE_DATE);
		// Expansion is account state: it lands in the seeded local store with account outbox rows, never pushed first.
		runUnitOfWork(db, (unitOfWork) =>
		{
			replaceExpansion(unitOfWork, [], 0);
		});
		/** The expansion keys pending for the account outbox. */
		const opened = () => readPendingAccountOutbox(db).map(({key}) => key);
		const expansionTest = vi.fn<WorkflowyInternalAdapter["expansionTest"]>(
			() => (id: string) => expanded.includes(id),
		);
		const ctx =
		{
			db,
			cacheService,
			mode,
			apiKey: mode === "standalone" ? undefined : "test-key",
			internalAuth: {},
			internalAdapter: () =>
				(
				{
					expansionTest,
				}) as unknown as WorkflowyInternalAdapter,
		} as unknown as ServerContext;
		const app = new Hono<AppEnv>();
		app.use("*", async (c, next) =>
		{
			c.set("ctx", ctx);
			await next();
		});
		app.route("/", httpAppFor(ctx));
		const post = async (body: unknown) =>
			app.fetch(
				new Request(
					"http://x/api/v1/nodes/duplicate",
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
		/** Every pending outbox row as `id:aspect`. */
		const pending = () => readPendingOutbox(db, 1000).map(({nodeId, aspect}) => `${nodeId}:${aspect}`);
		return {
			opened,
			post,
			cacheService,
			pending,
		};
	}

	describe("POST /api/v1/nodes/duplicate", () =>
	{
		it("deep-copies each item to consecutive slots locally in mirror mode, records the creates, and keeps child mirrors as mirrors", async () =>
		{
			const {post, cacheService, pending} = setup();
			const shape = (parentId: string | null): unknown[] =>
				cacheService.getChildren(parentId).map((node) => (
				{
					name: node.name,
					completed: node.completedAt !== null,
					mirrorOf: cacheService.getMirrorOriginal(node.id) ?? null,
					children: shape(node.id),
				}));

			const res = await post(
				{
					ids: ["O", "P"],
					parent_id: "P",
					index: 1,
				},
			);
			const {ids} = (await res.json()) as
			{
				ids: string[];
			};
			const rootRows = ids.flatMap((id) => [`${id}:create`, `${id}:placement`]);

			expect(
				{
					status: res.status,
					copies: shape("P").slice(1),
					placed: cacheService
						.getChildren("P")
						.slice(1)
						.map((node) => node.id),
					rootRows: rootRows.every((row) => pending().includes(row)),
				},
			).toStrictEqual(
				{
					status: 201,
					copies: [
						{
							name: "o",
							completed: true,
							mirrorOf: null,
							children: [
								{
									name: "c",
									completed: false,
									mirrorOf: null,
									children: [
										{
											name: "g",
											completed: false,
											mirrorOf: null,
											children: [],
										},
									],
								},
								{
									name: "x",
									completed: false,
									mirrorOf: "X",
									children: [],
								},
							],
						},
						{
							name: "p",
							completed: false,
							mirrorOf: null,
							children: [
								{
									name: "o",
									completed: false,
									mirrorOf: "O",
									children: [],
								},
							],
						},
					],
					placed: ids,
					rootRows: true,
				},
			);
		});

		it("duplicates a mirror from its original and opens copies whose source rows are expanded", async () =>
		{
			const {opened, post, cacheService} = setup(["M", "C"]);

			const res = await post(
				{
					ids: ["M"],
					parent_id: null,
					index: 0,
				},
			);
			const {ids} = (await res.json()) as
			{
				ids: string[];
			};
			const [copy] = cacheService.getChildren(null);
			const [childCopy] = cacheService.getChildren(copy.id);

			expect(
				{
					name: copy.name,
					first: copy.id === ids[0],
					opened: opened(),
				},
			).toStrictEqual(
				{
					name: "o",
					first: true,
					// oxlint-disable-next-line unicorn/no-array-sort -- the test tsconfig lib has no toSorted
					opened: [copy.id.slice(0, 8), childCopy.id.slice(0, 8)].sort(),
				},
			);
		});

		it("rejects an empty id list and an unknown id without writing", async () =>
		{
			const {post} = setup();

			const empty = await post(
				{
					ids: [],
					parent_id: "P",
					index: 0,
				},
			);
			const unknown = await post(
				{
					ids: ["nope"],
					parent_id: "P",
					index: 0,
				},
			);

			expect(
				{
					empty: empty.status,
					unknown: unknown.status,
				},
			).toStrictEqual(
				{
					empty: 400,
					unknown: 404,
				},
			);
		});

		it("deep-copies into the local tables in a standalone context, with no adapter", async () =>
		{
			const {post, cacheService} = setup([], "standalone");
			const shape = (parentId: string | null): unknown[] =>
				cacheService.getChildren(parentId).map((node) => (
				{
					name: node.name,
					note: node.note,
					completed: node.completedAt !== null,
					mirrorOf: cacheService.getMirrorOriginal(node.id) ?? null,
					children: shape(node.id),
				}));

			const res = await post(
				{
					ids: ["O"],
					parent_id: "P",
					index: 0,
				},
			);
			const {ids} = (await res.json()) as
			{
				ids: string[];
			};

			expect(
				{
					status: res.status,
					copy: shape("P")[0],
					first: ids[0] === cacheService.getChildren("P")[0]?.id,
				},
			).toStrictEqual(
				{
					status: 201,
					copy:
					{
						name: "o",
						note: "n",
						completed: true,
						mirrorOf: null,
						children: [
							{
								name: "c",
								note: null,
								completed: false,
								mirrorOf: null,
								children: [
									{
										name: "g",
										note: null,
										completed: false,
										mirrorOf: null,
										children: [],
									},
								],
							},
							{
								name: "x",
								note: null,
								completed: false,
								mirrorOf: "X",
								children: [],
							},
						],
					},
					first: true,
				},
			);
		});
	});
});

describe("nodes lookup op", () =>
{
	let sqlite: DatabaseConstructor.Database;
	let ctx: ServerContext;
	let store: StoreClient;

	beforeEach(() =>
	{
		sqlite = migratedMemoryDatabase();
		const db = drizzle(
			sqlite,
			{
				schema,
			},
		);
		ctx = buildServerContext(
			{
				db,
				config: readNodeConfig(
					{
						OUTLINEDB_MODE: "mirror",
						WORKFLOWY_API_KEY: "test-api-key",
					},
				),
				ladderEvents: new LadderEventBus(),
			},
		);
		store = inProcessStore(ctx);
		const insert = (id: string, name: string, parentId: string | null, completedAt: number | null = null) =>
		{
			ctx.cacheService.insertNode(
				{
					id,
					name,
					note: null,
					priority: 0,
					createdAt: 1_600_000_000,
					modifiedAt: 1_600_000_000,
					completedAt,
				},
				parentId,
			);
		};
		insert("work", "Work", null);
		insert("projects", "Projects", "work");
		insert("alpha", "Alpha", "projects", 1_600_000_100);
		// A path the cache lacks falls back to the public API, which knows nothing more.
		vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
			Promise.resolve(
				Response.json(
					{
						nodes: [],
					},
				),
			),
		);
	});

	afterEach(() =>
	{
		sqlite.close();
	});

	describe("nodes.resolve", () =>
	{
		it("resolves a comma path from the cache", async () =>
		{
			await expect(
				store.call(
					"nodes.resolve",
					{
						path: "Work, Projects",
					},
				),
			).resolves.toStrictEqual(
				{
					ok: true,
					value:
					{
						id: "projects",
					},
				},
			);
		});

		it("resolves home to null as a parent", async () =>
		{
			await expect(
				store.call(
					"nodes.resolve",
					{
						id: "home",
						parent: true,
					},
				),
			).resolves.toStrictEqual(
				{
					ok: true,
					value:
					{
						id: null,
					},
				},
			);
		});

		it("answers 404 with the resolver's message for an unknown path", async () =>
		{
			await expect(
				store.call(
					"nodes.resolve",
					{
						path: "Work,Nowhere",
					},
				),
			).resolves.toStrictEqual(
				{
					ok: false,
					status: 404,
					body:
					{
						error: "Node not found at path: Work > Nowhere",
					},
				},
			);
		});

		it("needs the API key", async () =>
		{
			const keyless = inProcessStore(
				{
					...ctx,
					apiKey: undefined,
				},
			);

			await expect(
				keyless.call(
					"nodes.resolve",
					{
						id: "work",
					},
				),
			).resolves.toStrictEqual(
				{
					ok: false,
					status: 500,
					body:
					{
						error: "WORKFLOWY_API_KEY environment variable is required",
					},
				},
			);
		});
	});

	describe("nodes.readTree", () =>
	{
		it("reads a parent's children with the requested depth of descendants", async () =>
		{
			const result = await store.call(
				"nodes.readTree",
				{
					parentId: "work",
					depth: 1,
				},
			);

			expect(
				result.ok &&
					result.value.nodes.map((node) =>
					{
						const {id, children} = node as
						{
							id: string;
							children:
							{
								id: string;
							}[];
						};
						return {
							id,
							children: children.map((child) => child.id),
						};
					}),
			).toStrictEqual([
				{
					id: "projects",
					children: ["alpha"],
				},
			]);
		});

		it("reads the named nodes without descendants by default", async () =>
		{
			const result = await store.call(
				"nodes.readTree",
				{
					ids: ["alpha"],
				},
			);

			expect(
				result.ok &&
					result.value.nodes.map((node) =>
					{
						const {id, name, completedAt} = node as
						{
							id: string;
							name: string;
							completedAt: string;
						};
						return {
							id,
							name,
							completedAt,
							readsChildren: "children" in (node as object),
						};
					}),
			).toStrictEqual([
				{
					id: "alpha",
					name: "Alpha",
					completedAt: "2020-09-13T12:28:20.000Z",
					readsChildren: false,
				},
			]);
		});
	});

	describe("cache.status", () =>
	{
		it("counts live nodes, roots and completed nodes", async () =>
		{
			await expect(store.call("cache.status", {})).resolves.toStrictEqual(
				{
					ok: true,
					value:
					{
						totalNodes: 3,
						rootNodes: 1,
						completedNodes: 1,
						lastSync: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u),
						lastBackupImport: null,
					},
				},
			);
		});
	});
});

describe("nodes mirror route", () =>
{
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

	const UNREACHABLE = new Error("workflowy.com is unreachable");

	afterEach(() =>
	{
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	/**
	 * A mirror context: Home holds O, P, L; P holds Q; Q holds R; M under P mirrors O. workflowy.com is down: every
	 * upstream tree write fails, while expansion (account state) still answers. New ids are new1, new2, ...
	 */
	function setup(configured = true, expanded: string[] = [])
	{
		vi.useFakeTimers(
			{
				toFake: ["Date"],
			},
		);
		vi.setSystemTime(1_600_000_000_000);
		const sqlite = migratedMemoryDatabase();
		const db = drizzle(
			sqlite,
			{
				schema,
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
		// Writes start later than the seed: a unit of work may not overwrite a version from its own millisecond.
		vi.setSystemTime(1_700_000_000_000);
		let counter = 0;
		vi.spyOn(crypto, "randomUUID").mockImplementation(() =>
		{
			counter += 1;
			return `new${counter}` as ReturnType<typeof crypto.randomUUID>;
		});
		const moveTo = vi.fn<WorkflowyInternalAdapter["moveTo"]>(async () => Promise.reject(UNREACHABLE));
		// Expansion is account state: it lands in the seeded local store with account outbox rows, never pushed first.
		runUnitOfWork(db, (unitOfWork) =>
		{
			replaceExpansion(unitOfWork, [], 0);
		});
		/** The expansion keys pending for the account outbox. */
		const opened = () => readPendingAccountOutbox(db).map(({key}) => key);
		const expansionTest = vi.fn<WorkflowyInternalAdapter["expansionTest"]>(
			() => (id: string) => expanded.includes(id),
		);
		const outboxWritten = vi.fn<() => void>();
		const ctx =
		{
			db,
			cacheService,
			apiKey: "test-key",
			internalAuth: configured ? {} : undefined,
			outboxWritten,
			internalAdapter: () =>
				configured
					? (
						{
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
		/** Each parent's children in order, keyed by parent (`home` for Home). */
		const children = (...parents: (string | null)[]) =>
			Object.fromEntries(
				parents.map((parent) => [parent ?? "home", cacheService.getChildren(parent).map((child) => child.id)]),
			);
		/** The pending outbox rows, as `node aspect`. */
		const pending = () => readPendingOutbox(db, 100).map(({nodeId, aspect}) => `${nodeId} ${aspect}`);
		return {
			opened,
			moveTo,
			cacheService,
			sqlite,
			post,
			get,
			children,
			pending,
			outboxWritten,
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
		it("mirrors each item locally in order at consecutive indexes while workflowy.com is down, leaving pending rows", async () =>
		{
			const {post, children, pending, outboxWritten} = setup();

			const res = await post(
				"/mirror",
				{
					item_ids: ["O", "L"],
					parent_id: "P",
					index: 1,
				},
			);
			const body = (await res.json()) as
			{
				nodes:
				{
					id: string;
					isMirror: boolean;
					originalNodeId: string | null;
				}[];
			};
			await Promise.resolve();

			expect(
				{
					status: res.status,
					nodes: body.nodes.map(({id, isMirror, originalNodeId}) => (
					{
						id,
						isMirror,
						originalNodeId,
					})),
					children: children("P"),
					pending: pending(),
					drains: outboxWritten.mock.calls.length,
				},
			).toStrictEqual(
				{
					status: 201,
					nodes: [
						{
							id: "new1",
							isMirror: true,
							originalNodeId: "O",
						},
						{
							id: "new2",
							isMirror: true,
							originalNodeId: "L",
						},
					],
					children:
					{
						P: ["Q", "new1", "new2", "M"],
					},
					pending: [
						"new1 create",
						"new1 mirror",
						"new1 placement",
						"new2 create",
						"new2 mirror",
						"new2 placement",
					],
					drains: 1,
				},
			);
		});

		it("resolves a mirror source to its original", async () =>
		{
			const {cacheService, post, children} = setup();

			await post(
				"/mirror",
				{
					item_ids: ["M"],
					parent_id: "L",
					index: 0,
				},
			);

			expect(
				{
					children: children("L"),
					original: cacheService.getMirrorOriginal("new1"),
				},
			).toStrictEqual(
				{
					children:
					{
						L: ["new1"],
					},
					original: "O",
				},
			);
		});

		it("writes into the original's child list when the parent is a mirror", async () =>
		{
			const {cacheService, post, children} = setup();

			await post(
				"/mirror",
				{
					item_ids: ["L"],
					parent_id: "M",
					index: 0,
				},
			);

			expect(
				{
					children: children("O", "M"),
					original: cacheService.getMirrorOriginal("new1"),
				},
			).toStrictEqual(
				{
					children:
					{
						O: ["new1"],
						M: [],
					},
					original: "L",
				},
			);
		});

		it("rejects Home as the source", async () =>
		{
			const {post} = setup();

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
				},
			).toStrictEqual(
				{
					status: 400,
					body:
					{
						error: "Cannot mirror Home",
					},
				},
			);
		});

		it("rejects a source that is the parent or an ancestor of the destination", async () =>
		{
			const {post} = setup();

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
				},
			);
		});

		it("gives each new mirror its source row's expansion, a mirror source included", async () =>
		{
			const {opened, post} = setup(true, ["O", "M"]);

			await post(
				"/mirror",
				{
					item_ids: ["O", "L", "M"],
					parent_id: "P",
					index: 0,
				},
			);

			expect(opened()).toStrictEqual(["new1", "new3"]);
		});

		it("leaves expansion alone when no source is expanded", async () =>
		{
			const {opened, post} = setup();

			await post(
				"/mirror",
				{
					item_ids: ["O"],
					parent_id: "P",
					index: 0,
				},
			);

			expect(opened()).toStrictEqual([]);
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
		it("moves the mirror next to its original, then the original into the mirror's old slot, locally", async () =>
		{
			const {moveTo, post, children, pending} = setup();

			const res = await post("/M/swap-mirror-origin", {});

			expect(
				{
					status: res.status,
					children: children(null, "P"),
					pending: pending(),
					upstream: moveTo.mock.calls.length,
				},
			).toStrictEqual(
				{
					status: 200,
					children:
					{
						home: ["M", "P", "L"],
						P: ["Q", "O"],
					},
					pending: ["M placement", "O placement"],
					upstream: 0,
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
});

describe("nodes standalone op", () =>
{
	const SEEDED = 1_600_000_000;
	const NOW = 1_700_000_000;
	const NEW_ID = "0b6f3c1e-2d4a-4b8c-9e7f-1a2b3c4d5e6f";

	let sqlite: DatabaseConstructor.Database;
	let store: StoreClient;

	/** A seeded or written node as the REST API answers it: uncompleted, childless, at Home unless overridden. */
	function dto(id: string, overrides: Partial<NodeResponse> = {}): NodeResponse
	{
		return {
			id,
			parent_id: null,
			name: id,
			note: null,
			priority: 0,
			data:
			{
				layoutMode: null,
			},
			numberedStart: null,
			createdAt: SEEDED,
			modifiedAt: SEEDED,
			completedAt: null,
			hasChildren: false,
			hasUncompletedChildren: false,
			isMirror: false,
			hasMirrors: false,
			originalNodeId: null,
			attachment: null,
			defaultToBottom: false,
			calendar: null,
			table: null,
			...overrides,
		};
	}

	beforeEach(() =>
	{
		vi.useFakeTimers(
			{
				toFake: ["Date"],
			},
		);
		vi.setSystemTime(SEEDED * 1000);
		sqlite = migratedMemoryDatabase();
		const db = drizzle(
			sqlite,
			{
				schema,
			},
		);
		// A standalone Node host.
		const ctx = buildServerContext(
			{
				db,
				config: readNodeConfig(
					{
						OUTLINEDB_MODE: "standalone",
					},
				),
				ladderEvents: new LadderEventBus(),
			},
		);
		store = inProcessStore(ctx);
		const insert = (id: string, parentId: string | null, priority: number) =>
		{
			ctx.cacheService.insertNode(
				{
					id,
					name: id,
					note: null,
					priority,
					createdAt: SEEDED,
					modifiedAt: SEEDED,
					completedAt: null,
				},
				parentId,
			);
		};
		insert("p", null, 0);
		insert("a", "p", 0);
		insert("b", "p", 1);
		insert("q", null, 1);
		// Writes start later than the seed: a unit of work may not overwrite a version from its own millisecond.
		vi.setSystemTime(NOW * 1000);
		// No upstream exists; any request to one fails the test.
		vi.spyOn(globalThis, "fetch").mockRejectedValue(
			new Error("unexpected fetch: a standalone write called an upstream"),
		);
	});

	afterEach(() =>
	{
		vi.useRealTimers();
		vi.restoreAllMocks();
		sqlite.close();
	});

	describe("node writes in a standalone context", () =>
	{
		it("creates a node at a slot and reads it back", async () =>
		{
			const created = dto(
				NEW_ID,
				{
					parent_id: "p",
					name: "new",
					priority: 1,
					createdAt: NOW,
					modifiedAt: NOW,
				},
			);

			await expect(
				store.call(
					"nodes.create",
					{
						parent_id: "p",
						name: "new",
						index: 1,
						id: NEW_ID,
					},
				),
			).resolves.toStrictEqual(
				{
					ok: true,
					value:
					{
						node: created,
					},
					meta:
					{
						created: true,
					},
				},
			);
			await expect(
				store.call(
					"nodes.children",
					{
						parentIds: ["p"],
					},
				),
			).resolves.toStrictEqual(
				{
					ok: true,
					value:
					{
						children:
						{
							p: [
								dto(
									"a",
									{
										parent_id: "p",
									},
								),
								created,
								dto(
									"b",
									{
										parent_id: "p",
										priority: 2,
									},
								),
							],
						},
					},
				},
			);
		});

		it("creates at Home's bottom when the parent is omitted, as an empty outline's first bullet sends", async () =>
		{
			await expect(
				store.call(
					"nodes.create",
					{
						name: "",
						id: NEW_ID,
					},
				),
			).resolves.toStrictEqual(
				{
					ok: true,
					value:
					{
						node: dto(
							NEW_ID,
							{
								name: "",
								priority: 2,
								createdAt: NOW,
								modifiedAt: NOW,
							},
						),
					},
					meta:
					{
						created: true,
					},
				},
			);
		});

		it("answers 404 for a create under an unknown parent", async () =>
		{
			await expect(
				store.call(
					"nodes.create",
					{
						parent_id: "4d7c2f10-0000-4000-8000-000000000000",
						name: "x",
					},
				),
			).resolves.toStrictEqual(
				{
					ok: false,
					status: 404,
					body:
					{
						error: "Parent node not found",
					},
				},
			);
		});

		it("updates a node's name and note and reads it back", async () =>
		{
			const updated = dto(
				"a",
				{
					parent_id: "p",
					name: "renamed",
					note: "a note",
					modifiedAt: NOW,
				},
			);

			await expect(
				store.call(
					"nodes.update",
					{
						id: "a",
						name: "renamed",
						note: "a note",
					},
				),
			).resolves.toStrictEqual(
				{
					ok: true,
					value:
					{
						node: updated,
						effects:
						{
							backlinkTargets: [],
							dates: false,
						},
					},
				},
			);
			await expect(
				store.call(
					"nodes.get",
					{
						id: "a",
					},
				),
			).resolves.toStrictEqual(
				{
					ok: true,
					value:
					{
						node: updated,
					},
				},
			);
		});

		it("writes numberedStart locally", async () =>
		{
			await expect(
				store.call(
					"nodes.update",
					{
						id: "a",
						numberedStart: 3,
					},
				),
			).resolves.toStrictEqual(
				{
					ok: true,
					value:
					{
						node: dto(
							"a",
							{
								parent_id: "p",
								numberedStart: 3,
								modifiedAt: NOW,
							},
						),
						effects:
						{
							backlinkTargets: [],
							dates: false,
						},
					},
				},
			);
		});

		it("creates several trees at one slot", async () =>
		{
			const result = await store.call(
				"nodes.trees",
				{
					parent_id: "p",
					after_id: "a",
					trees: [
						{
							name: "t1",
							children: [
								{
									name: "t2",
								},
							],
						},
						{
							name: "t3",
							completed: true,
						},
					],
				},
			);
			const children = await store.call(
				"nodes.children",
				{
					parentIds: ["p"],
				},
			);

			expect(
				children.ok && result.ok
					?
						{
							ids: result.value.ids.length,
							names: children.value.children.p.map((node) => [
								node.name,
								node.hasChildren,
								node.completedAt,
							]),
						}
					:
						{
							result,
							children,
						},
			).toStrictEqual(
				{
					ids: 2,
					names: [
						["a", false, null],
						["t1", true, null],
						["t3", false, NOW],
						["b", false, null],
					],
				},
			);
		});

		it("restores a deleted node under its original id, and answers 409 for a live one", async () =>
		{
			await store.call(
				"nodes.delete",
				{
					id: "a",
				},
			);
			vi.setSystemTime((NOW + 1) * 1000);

			await expect(
				store.call(
					"nodes.restore",
					{
						id: "a",
					},
				),
			).resolves.toStrictEqual(
				{
					ok: true,
					value:
					{
						node: dto(
							"a",
							{
								parent_id: "p",
								// workflowy.com's undelete stamps the restored node.
								modifiedAt: NOW + 1,
							},
						),
					},
				},
			);
			await expect(
				store.call(
					"nodes.restore",
					{
						id: "b",
					},
				),
			).resolves.toStrictEqual(
				{
					ok: false,
					status: 409,
					body:
					{
						error: "Node is not deleted",
					},
				},
			);
			await expect(
				store.call(
					"nodes.restore",
					{
						id: "4d7c2f10-0000-4000-8000-000000000000",
					},
				),
			).resolves.toStrictEqual(
				{
					ok: false,
					status: 404,
					body:
					{
						error: "Node not found",
					},
				},
			);
		});

		it("deletes a node and closes the gap", async () =>
		{
			await expect(
				store.call(
					"nodes.delete",
					{
						id: "a",
					},
				),
			).resolves.toStrictEqual(
				{
					ok: true,
					value: null,
				},
			);
			await expect(
				store.call(
					"nodes.get",
					{
						id: "a",
					},
				),
			).resolves.toStrictEqual(
				{
					ok: false,
					status: 404,
					body:
					{
						error: "Node not found",
					},
				},
			);
			await expect(
				store.call(
					"nodes.children",
					{
						parentIds: ["p"],
					},
				),
			).resolves.toStrictEqual(
				{
					ok: true,
					value:
					{
						children:
						{
							p: [
								dto(
									"b",
									{
										parent_id: "p",
									},
								),
							],
						},
					},
				},
			);
		});

		it("completes and uncompletes a node", async () =>
		{
			const completed = dto(
				"a",
				{
					parent_id: "p",
					modifiedAt: NOW,
					completedAt: NOW,
				},
			);

			await expect(
				store.call(
					"nodes.complete",
					{
						id: "a",
					},
				),
			).resolves.toStrictEqual(
				{
					ok: true,
					value:
					{
						node: completed,
					},
				},
			);
			await expect(
				store.call(
					"nodes.get",
					{
						id: "a",
					},
				),
			).resolves.toStrictEqual(
				{
					ok: true,
					value:
					{
						node: completed,
					},
				},
			);
			vi.setSystemTime((NOW + 1) * 1000);
			await expect(
				store.call(
					"nodes.uncomplete",
					{
						id: "a",
					},
				),
			).resolves.toStrictEqual(
				{
					ok: true,
					value:
					{
						node: dto(
							"a",
							{
								parent_id: "p",
								modifiedAt: NOW + 1,
							},
						),
					},
				},
			);
		});

		it("moves a node to another parent and answers both parents' children", async () =>
		{
			const moved = dto(
				"b",
				{
					parent_id: "q",
					modifiedAt: NOW,
				},
			);

			await expect(
				store.call(
					"nodes.moveOne",
					{
						id: "b",
						parent_id: "q",
						index: 0,
					},
				),
			).resolves.toStrictEqual(
				{
					ok: true,
					value:
					{
						nodes: [
							dto(
								"a",
								{
									parent_id: "p",
								},
							),
							moved,
						],
					},
				},
			);
			await expect(
				store.call(
					"nodes.get",
					{
						id: "b",
					},
				),
			).resolves.toStrictEqual(
				{
					ok: true,
					value:
					{
						node: moved,
					},
				},
			);
		});

		it("moves several blocks in one call", async () =>
		{
			await expect(
				store.call(
					"nodes.move",
					{
						moves: [
							{
								ids: ["b"],
								parent_id: "p",
								index: 0,
							},
							{
								ids: ["a"],
								parent_id: "q",
							},
						],
					},
				),
			).resolves.toStrictEqual(
				{
					ok: true,
					value:
					{
						nodes: [
							dto(
								"b",
								{
									parent_id: "p",
									modifiedAt: NOW,
								},
							),
							dto(
								"a",
								{
									parent_id: "q",
									modifiedAt: NOW,
								},
							),
						],
					},
				},
			);
		});
	});

	describe("mirrors and backlinks in a standalone context", () =>
	{
		const TARGET = "7a1b2c3d-4e5f-4a6b-8c7d-0123456789ab";
		const SOURCE = "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b";
		const link = `<a href="https://workflowy.com/#/${TARGET.slice(-12)}">target</a>`;

		interface Row
		{
			id: string;
			name: string | null;
			isMirror: boolean | undefined;
			originalNodeId: string | null | undefined;
		}

		async function rows(parentId: string): Promise<Row[]>
		{
			const result = await store.call(
				"nodes.children",
				{
					parentIds: [parentId],
				},
			);
			if (!result.ok)
			{
				throw new Error(`children of ${parentId}: ${result.status}`);
			}
			return (result.value.children[parentId] ?? []).map((node) => (
			{
				id: node.id,
				name: node.name,
				isMirror: node.isMirror,
				originalNodeId: node.originalNodeId,
			}));
		}

		function row(id: string, name = id, originalNodeId: string | null = null): Row
		{
			return {
				id,
				name,
				isMirror: originalNodeId !== null,
				originalNodeId,
			};
		}

		async function mirror(itemIds: string[], parentId: string, index: number): Promise<string[]>
		{
			const result = await store.call(
				"nodes.mirror",
				{
					item_ids: itemIds,
					parent_id: parentId,
					index,
				},
			);
			if (!result.ok)
			{
				throw new Error(`mirror: ${result.status} ${JSON.stringify(result.body)}`);
			}
			return result.value.nodes.map((node) => node.id);
		}

		/** The next write runs a second later: a unit of work may not overwrite a version from its own second. */
		function tick(seconds = 1): void
		{
			vi.setSystemTime((NOW + seconds) * 1000);
		}

		async function backlinkSources(targetId: string): Promise<
		{
			rootId: string | null;
			sourceIds: string[];
		}>
		{
			const result = await store.call(
				"nodes.backlinks",
				{
					id: targetId,
				},
			);
			if (!result.ok)
			{
				throw new Error(`backlinks: ${result.status}`);
			}
			return {
				rootId: result.value.rootId,
				sourceIds: result.value.items.map((item) => item.sourceId),
			};
		}

		/** Every current node under `parentId`, references roots and backlink items included. */
		function liveChildIds(parentId: string): string[]
		{
			return sqlite
				.prepare<
					[string, number],
					{
						id: string;
					}
				>("SELECT id FROM node_content WHERE parent_id = ? AND system_to = ? ORDER BY id")
				.all(parentId, FAR_FUTURE_DATE)
				.map(({id}) => id);
		}

		it("mirrors items at consecutive slots, with no upstream", async () =>
		{
			const [mirrorA, mirrorB] = await mirror(["a", "b"], "q", 0);

			expect(
				{
					q: await rows("q"),
					p: await rows("p"),
				},
			).toStrictEqual(
				{
					q: [row(mirrorA, "a", "a"), row(mirrorB, "b", "b")],
					p: [row("a"), row("b")],
				},
			);
		});

		it("detaches a mirror into a plain copy at its slot", async () =>
		{
			const [mirrorA] = await mirror(["a"], "q", 0);
			tick();

			const result = await store.call(
				"nodes.detachMirror",
				{
					id: mirrorA,
				},
			);

			const copyId = result.ok ? result.value.node?.id : undefined;
			expect(
				{
					ok: result.ok,
					q: await rows("q"),
					p: await rows("p"),
				},
			).toStrictEqual(
				{
					ok: true,
					q: [row(copyId ?? "", "a")],
					p: [row("a"), row("b")],
				},
			);
		});

		it("detaches an original in place, promoting its mirror into the mirror's slot", async () =>
		{
			await mirror(["a"], "q", 0);
			tick();

			const result = await store.call(
				"nodes.detachMirror",
				{
					id: "a",
				},
			);

			const copyId = result.ok ? result.value.node?.id : undefined;
			expect(
				{
					ok: result.ok,
					q: await rows("q"),
					p: await rows("p"),
				},
			).toStrictEqual(
				{
					ok: true,
					q: [row("a")],
					p: [row(copyId ?? "", "a"), row("b")],
				},
			);
		});

		it("swaps a mirror with its original", async () =>
		{
			const [mirrorA] = await mirror(["a"], "q", 0);
			tick();

			await expect(
				store.call(
					"nodes.swapMirrorOrigin",
					{
						id: mirrorA,
					},
				),
			).resolves.toStrictEqual(
				{
					ok: true,
					value:
					{
						swapped:
						{
							mirrorId: mirrorA,
							originalId: "a",
						},
					},
				},
			);
			expect(
				{
					q: await rows("q"),
					p: await rows("p"),
				},
			).toStrictEqual(
				{
					q: [row("a")],
					p: [row(mirrorA, "a", "a"), row("b")],
				},
			);
		});

		it("creates, keeps and removes a source's backlink items locally as its links change", async () =>
		{
			await store.call(
				"nodes.create",
				{
					parent_id: "q",
					name: "target",
					id: TARGET,
				},
			);
			await store.call(
				"nodes.create",
				{
					parent_id: "p",
					name: "source",
					id: SOURCE,
				},
			);
			tick();

			const linked = await store.call(
				"nodes.update",
				{
					id: SOURCE,
					name: `see ${link}`,
				},
			);
			const afterLink = await backlinkSources(TARGET);
			tick(2);
			await store.call(
				"nodes.update",
				{
					id: SOURCE,
					note: "still linked",
				},
			);
			const afterNote = await backlinkSources(TARGET);
			tick(3);
			const unlinked = await store.call(
				"nodes.update",
				{
					id: SOURCE,
					name: "no link",
				},
			);

			expect(
				{
					linkedEffects: linked.ok ? linked.value.effects.backlinkTargets : undefined,
					afterLink,
					afterNote,
					unlinkedEffects: unlinked.ok ? unlinked.value.effects.backlinkTargets : undefined,
					afterUnlink: await backlinkSources(TARGET),
					rootChildren: afterLink.rootId === null ? undefined : liveChildIds(afterLink.rootId),
					targetRows: await rows(TARGET),
				},
			).toStrictEqual(
				{
					linkedEffects: [TARGET],
					afterLink:
					{
						rootId: expect.any(String) as string,
						sourceIds: [SOURCE],
					},
					afterNote:
					{
						rootId: afterLink.rootId,
						sourceIds: [SOURCE],
					},
					unlinkedEffects: [TARGET],
					afterUnlink:
					{
						rootId: afterLink.rootId,
						sourceIds: [],
					},
					rootChildren: [],
					targetRows: [],
				},
			);
		});

		it("links a created source and removes its backlink item when the source is deleted", async () =>
		{
			await store.call(
				"nodes.create",
				{
					parent_id: "q",
					name: "target",
					id: TARGET,
				},
			);
			tick();
			await store.call(
				"nodes.create",
				{
					parent_id: "p",
					name: `see ${link}`,
					id: SOURCE,
				},
			);
			const afterCreate = await backlinkSources(TARGET);
			tick(2);

			await store.call(
				"nodes.delete",
				{
					id: "p",
				},
			);

			expect(
				{
					afterCreate,
					rootChildren: afterCreate.rootId === null ? undefined : liveChildIds(afterCreate.rootId),
				},
			).toStrictEqual(
				{
					afterCreate:
					{
						rootId: expect.any(String) as string,
						sourceIds: [SOURCE],
					},
					rootChildren: [],
				},
			);
		});
	});
});

describe("nodes subtree ids route", () =>
{
	function apiNode(id: string, parentId: string | null, priority: number, completedAt?: number): WorkflowyNode
	{
		return {
			id,
			name: id,
			note: null,
			parent_id: parentId,
			priority,
			createdAt: 100,
			modifiedAt: 200,
			completed: completedAt !== undefined,
			...(completedAt === undefined
				? {}
				:
					{
						completedAt,
					}),
		};
	}

	/** Home holds Alpha>{A1>{A1a}, A2 (completed)} and Beta>{B1}. */
	function setup()
	{
		const sqlite = migratedMemoryDatabase();
		const db = drizzle(
			sqlite,
			{
				schema,
			},
		);
		const cacheService = new CacheService(db);
		cacheService.insertNode(apiNode("Alpha", null, 0), null);
		cacheService.insertNode(apiNode("Beta", null, 1), null);
		cacheService.insertNode(apiNode("A1", "Alpha", 0), "Alpha");
		cacheService.insertNode(apiNode("A2", "Alpha", 1, 300), "Alpha");
		cacheService.insertNode(apiNode("A1a", "A1", 0), "A1");
		cacheService.insertNode(apiNode("B1", "Beta", 0), "Beta");
		const ctx =
		{
			db,
			cacheService,
		} as unknown as ServerContext;
		const app = new Hono<AppEnv>();
		app.use("*", async (c, next) =>
		{
			c.set("ctx", ctx);
			await next();
		});
		app.route("/", httpAppFor(ctx));
		const request = async (path: string) =>
		{
			const res = await app.fetch(new Request(`http://x/api/v1/nodes${path}`));
			return {
				status: res.status,
				body: await res.json(),
			};
		};
		/** Make `mirrorId` (a new child of `parentId`) a mirror of `originalId`. */
		const mirror = (mirrorId: string, parentId: string, originalId: string, ownCompletedAt?: number) =>
		{
			cacheService.insertNode(apiNode(mirrorId, parentId, 9, ownCompletedAt), parentId);
			sqlite
				.prepare("INSERT INTO mirrors (mirror_id, original_id, system_from, system_to) VALUES (?, ?, ?, ?)")
				.run(mirrorId, originalId, "2000-01-01T00:00:00.000Z", FAR_FUTURE_DATE);
		};
		return {
			request,
			mirror,
		};
	}

	describe("GET /api/v1/nodes/:id/subtree-ids", () =>
	{
		it("lists every descendant of the node with its parent, completion and child flag", async () =>
		{
			const {request} = setup();

			await expect(request("/Alpha/subtree-ids")).resolves.toStrictEqual(
				{
					status: 200,
					body:
					{
						items: [
							{
								id: "A1",
								parentId: "Alpha",
								completed: false,
								hasChildren: true,
							},
							{
								id: "A1a",
								parentId: "A1",
								completed: false,
								hasChildren: false,
							},
							{
								id: "A2",
								parentId: "Alpha",
								completed: true,
								hasChildren: false,
							},
						],
					},
				},
			);
		});

		it("walks the whole Home tree for home, with null parents at the top", async () =>
		{
			const {request} = setup();

			await expect(request("/home/subtree-ids")).resolves.toStrictEqual(
				{
					status: 200,
					body:
					{
						items: [
							{
								id: "Alpha",
								parentId: null,
								completed: false,
								hasChildren: true,
							},
							{
								id: "A1",
								parentId: "Alpha",
								completed: false,
								hasChildren: true,
							},
							{
								id: "A1a",
								parentId: "A1",
								completed: false,
								hasChildren: false,
							},
							{
								id: "A2",
								parentId: "Alpha",
								completed: true,
								hasChildren: false,
							},
							{
								id: "Beta",
								parentId: null,
								completed: false,
								hasChildren: true,
							},
							{
								id: "B1",
								parentId: "Beta",
								completed: false,
								hasChildren: false,
							},
						],
					},
				},
			);
		});

		it("lists a mirror's original children under the mirror", async () =>
		{
			const {request, mirror} = setup();
			mirror("MA1", "Beta", "A1");

			await expect(request("/Beta/subtree-ids")).resolves.toStrictEqual(
				{
					status: 200,
					body:
					{
						items: [
							{
								id: "B1",
								parentId: "Beta",
								completed: false,
								hasChildren: false,
							},
							{
								id: "MA1",
								parentId: "Beta",
								completed: false,
								hasChildren: true,
							},
							{
								id: "A1a",
								parentId: "MA1",
								completed: false,
								hasChildren: false,
							},
						],
					},
				},
			);
		});

		it("reports a mirror as completed exactly when its original is", async () =>
		{
			const {request, mirror} = setup();
			mirror("MA2", "Beta", "A2");
			mirror("MA1", "Beta", "A1", 400);

			const {body} = await request("/Beta/subtree-ids");

			const completion = new Map(
				(
					body as
					{
						items:
						{
							id: string;
							completed: boolean;
						}[];
					}
				).items.map((item) => [item.id, item.completed]),
			);

			expect(
				{
					MA1: completion.get("MA1"),
					MA2: completion.get("MA2"),
				},
			).toStrictEqual(
				{
					MA1: false,
					MA2: true,
				},
			);
		});

		it("does not descend into a mirror of its own ancestor", async () =>
		{
			const {request, mirror} = setup();
			mirror("MAlpha", "A1", "Alpha");

			await expect(request("/Alpha/subtree-ids")).resolves.toStrictEqual(
				{
					status: 200,
					body:
					{
						items: [
							{
								id: "A1",
								parentId: "Alpha",
								completed: false,
								hasChildren: true,
							},
							{
								id: "A1a",
								parentId: "A1",
								completed: false,
								hasChildren: false,
							},
							{
								id: "MAlpha",
								parentId: "A1",
								completed: false,
								hasChildren: true,
							},
							{
								id: "A2",
								parentId: "Alpha",
								completed: true,
								hasChildren: false,
							},
						],
					},
				},
			);
		});

		it("answers 404 for an unknown node", async () =>
		{
			const {request} = setup();

			await expect(request("/nope/subtree-ids")).resolves.toStrictEqual(
				{
					status: 404,
					body:
					{
						error: "Node not found",
					},
				},
			);
		});
	});
});

describe("nodes tree read statement count", () =>
{
	function apiNode(id: string, parentId: string | null, priority: number): WorkflowyNode
	{
		return {
			id,
			name: id,
			note: null,
			parent_id: parentId,
			priority,
			createdAt: 100,
			modifiedAt: 200,
			completed: false,
		};
	}

	/** Home holds `parents` expanded parents P0.., each with three children, one of them a mirror of Original. */
	function setup(parents: number)
	{
		const sqlite = migratedMemoryDatabase();
		let statements = 0;
		const db = drizzle(
			sqlite,
			{
				schema,
				logger:
				{
					logQuery()
					{
						statements += 1;
					},
				},
			},
		);
		const cacheService = new CacheService(db);
		cacheService.insertNode(apiNode("Original", null, 0), null);
		for (let p = 0; p < parents; p++)
		{
			cacheService.insertNode(apiNode(`P${p}`, null, p + 1), null);
			for (let k = 0; k < 2; k++)
			{
				cacheService.insertNode(apiNode(`P${p}c${k}`, `P${p}`, k), `P${p}`);
			}
			cacheService.insertNode(apiNode(`P${p}m`, `P${p}`, 9), `P${p}`);
			sqlite
				.prepare("INSERT INTO mirrors (mirror_id, original_id, system_from, system_to) VALUES (?, ?, ?, ?)")
				.run(`P${p}m`, "Original", "2000-01-01T00:00:00.000Z", FAR_FUTURE_DATE);
			sqlite
				.prepare("INSERT INTO expanded_nodes (short_key, system_from, system_to) VALUES (?, ?, ?)")
				.run(upstreamExpansionKey(`P${p}`), "2000-01-01T00:00:00.000Z", FAR_FUTURE_DATE);
		}
		const ctx =
		{
			db,
			cacheService,
			internalAdapter: () => (
			{
				expansionTest: () => (id: string) => /^P\d+$/u.test(id),
			}),
		} as unknown as ServerContext;
		const app = new Hono<AppEnv>();
		app.use("*", async (c, next) =>
		{
			c.set("ctx", ctx);
			await next();
		});
		app.route("/", httpAppFor(ctx));
		const post = async (path: string, body: unknown) =>
		{
			const before = statements;
			const res = await app.fetch(
				new Request(
					`http://x/api/v1/nodes${path}`,
					{
						method: "POST",
						headers:
						{
							"Content-Type": "application/json",
						},
						body: JSON.stringify(body),
					},
				),
			);
			await res.json();
			if (process.env.PRINT_COUNTS)
			{
				console.log(`COUNT ${path} ${parents} parents: ${statements - before}`);
			}
			return {
				status: res.status,
				statements: statements - before,
			};
		};
		return {
			post,
		};
	}

	const parentIds = (n: number) =>
		Array.from(
			{
				length: n,
			},
			(_, p) => `P${p}`,
		);

	describe("tree reads keep their SQL statement count independent of the parent count", () =>
	{
		it("POST /children", async () =>
		{
			const few = await setup(2).post(
				"/children",
				{
					parentIds: parentIds(2),
				},
			);
			const many = await setup(12).post(
				"/children",
				{
					parentIds: parentIds(12),
				},
			);

			expect(
				{
					few: few.status,
					many: many.status,
					same: many.statements === few.statements,
				},
			).toStrictEqual(
				{
					few: 200,
					many: 200,
					same: true,
				},
			);
			expect(many.statements).toBeLessThanOrEqual(20);
		});

		it("POST /view over expanded rows", async () =>
		{
			const view =
			{
				rootId: null,
				limit: 1000,
				showCompleted: true,
			};
			const few = await setup(2).post("/view", view);
			const many = await setup(12).post("/view", view);

			expect(
				{
					few: few.status,
					many: many.status,
					same: many.statements === few.statements,
				},
			).toStrictEqual(
				{
					few: 200,
					many: 200,
					same: true,
				},
			);
			expect(many.statements).toBeLessThanOrEqual(40);
		});
	});
});

describe("nodes view route", () =>
{
	function apiNode(id: string, parentId: string | null, priority: number, completedAt?: number): WorkflowyNode
	{
		return {
			id,
			name: id,
			note: null,
			parent_id: parentId,
			priority,
			createdAt: 100,
			modifiedAt: 200,
			completed: completedAt !== undefined,
			...(completedAt === undefined
				? {}
				:
					{
						completedAt,
					}),
		};
	}

	/** Home holds Alpha>{A1>{A1a}, A2 (completed)>{A2a}} and Beta>{B1}. */
	/** `accountExpanded`: the account's expanded ids the internal API holds; undefined leaves it unconfigured. */
	function setup(accountExpanded?: readonly string[])
	{
		const sqlite = migratedMemoryDatabase();
		const db = drizzle(
			sqlite,
			{
				schema,
			},
		);
		const cacheService = new CacheService(db);
		cacheService.insertNode(apiNode("Alpha", null, 0), null);
		cacheService.insertNode(apiNode("Beta", null, 1), null);
		cacheService.insertNode(apiNode("A1", "Alpha", 0), "Alpha");
		cacheService.insertNode(apiNode("A2", "Alpha", 1, 300), "Alpha");
		cacheService.insertNode(apiNode("A1a", "A1", 0), "A1");
		cacheService.insertNode(apiNode("A2a", "A2", 0), "A2");
		cacheService.insertNode(apiNode("B1", "Beta", 0), "Beta");
		// The account's expansion lives in `expanded_nodes` under upstream's keys, which the internal API tests ids against.
		for (const key of new Set(accountExpanded?.map(upstreamExpansionKey)))
		{
			sqlite
				.prepare("INSERT INTO expanded_nodes (short_key, system_from, system_to) VALUES (?, ?, ?)")
				.run(key, "2000-01-01T00:00:00.000Z", FAR_FUTURE_DATE);
		}
		const adapter =
			accountExpanded === undefined
				? undefined
				:
					{
						expansionTest: () => (id: string) =>
							accountExpanded.map(upstreamExpansionKey).includes(upstreamExpansionKey(id)),
					};
		const ctx =
		{
			db,
			cacheService,
			internalAdapter: () => adapter,
		} as unknown as ServerContext;
		const app = new Hono<AppEnv>();
		app.use("*", async (c, next) =>
		{
			c.set("ctx", ctx);
			await next();
		});
		app.route("/", httpAppFor(ctx));
		const post = async (body: unknown) =>
		{
			const res = await app.fetch(
				new Request(
					"http://x/api/v1/nodes/view",
					{
						method: "POST",
						headers:
						{
							"Content-Type": "application/json",
						},
						body: JSON.stringify(body),
					},
				),
			);
			return {
				status: res.status,
				body: await res.json(),
			};
		};
		/** Key `id` among its siblings as the integer `priority`, so the seeds sort by the numbers they were given. */
		const setOrderKey = (id: string, priority: number) =>
		{
			sqlite
				.prepare("UPDATE node_metadata SET order_key = ? WHERE node_id = ?")
				.run(integerOrderKey(priority), id);
		};
		/** PATCH `/api/v1/expansion`, returning the status. */
		const patchExpansion = async (body: unknown) =>
		{
			const res = await app.fetch(
				new Request(
					"http://x/api/v1/expansion",
					{
						method: "PATCH",
						headers:
						{
							"Content-Type": "application/json",
						},
						body: JSON.stringify(body),
					},
				),
			);
			return res.status;
		};
		/** Make `mirrorId` (a new child of `parentId`) a mirror of `originalId`. */
		const mirror = (mirrorId: string, parentId: string, originalId: string) =>
		{
			cacheService.insertNode(apiNode(mirrorId, parentId, 9), parentId);
			setOrderKey(mirrorId, 9);
			sqlite
				.prepare("INSERT INTO mirrors (mirror_id, original_id, system_from, system_to) VALUES (?, ?, ?, ?)")
				.run(mirrorId, originalId, "2000-01-01T00:00:00.000Z", FAR_FUTURE_DATE);
		};
		/** Add `id` under `parentId` keyed by `priority`; without metadata its order key reads as `a0` and creation time as 0. */
		const add = (
			id: string,
			parentId: string,
			priority: number,
			{completedAt, metadata = true} = {} as
			{
				completedAt?: number;
				metadata?: boolean;
			},
		) =>
		{
			cacheService.insertNode(apiNode(id, parentId, priority, completedAt), parentId);
			setOrderKey(id, priority);
			if (!metadata)
			{
				sqlite.prepare("DELETE FROM node_metadata WHERE node_id = ?").run(id);
			}
		};
		/** Make `id` (a new child of `targetId`) `targetId`'s references root. */
		const referencesRoot = (id: string, targetId: string) =>
		{
			cacheService.insertNode(apiNode(id, targetId, 99), targetId);
			setOrderKey(id, 99);
			sqlite
				.prepare("INSERT INTO references_roots (node_id, system_from, system_to) VALUES (?, ?, ?)")
				.run(id, "2000-01-01T00:00:00.000Z", FAR_FUTURE_DATE);
		};
		return {
			post,
			patchExpansion,
			mirror,
			add,
			referencesRoot,
		};
	}

	interface ListBody
	{
		parentId: string | null;
		nodes:
		{
			id: string;
		}[];
		backlinks: unknown;
	}

	/** Each list as [parentId, child ids, backlinks]. */
	function lists(body: {lists: ListBody[]}): [string | null, string[], unknown][]
	{
		return body.lists.map((list) => [list.parentId, list.nodes.map((node) => node.id), list.backlinks]);
	}

	const NO_BACKLINKS =
	{
		rootId: null,
		items: [],
	};

	/**
	 * A Backlinks section item as the view sends it: the item row (named after its source, its index in the section as
	 * its priority) carrying its source's text, completion and child flags. A crumb given as a string is a node named
	 * after its id.
	 */
	function backlinkItem(
		id: string,
		rootId: string,
		sourceId: string,
		{
			completedAt = null,
			children = false,
			index = 0,
			crumbs,
		}:
		{
			completedAt?: number | null;
			children?: boolean;
			index?: number;
			crumbs: (
				| string
				|
				  {
						id: string;
						name: string;
				  }
			)[];
		},
	)
	{
		return {
			node:
			{
				id,
				parent_id: rootId,
				name: sourceId,
				note: null,
				priority: index,
				data:
				{
					layoutMode: null,
				},
				numberedStart: null,
				createdAt: 100,
				modifiedAt: 200,
				completedAt,
				hasChildren: children,
				hasUncompletedChildren: children,
				isMirror: true,
				hasMirrors: false,
				originalNodeId: sourceId,
				attachment: null,
				defaultToBottom: false,
				calendar: null,
				table: null,
			},
			sourceId,
			crumbs: crumbs.map((crumb) =>
				typeof crumb === "string"
					?
						{
							id: crumb,
							name: crumb,
						}
					: crumb,
			),
		};
	}

	describe("POST /api/v1/nodes/view", () =>
	{
		it("lists the root's and every expanded rendered row's children depth-first, with their Backlinks", async () =>
		{
			const {post} = setup(["Alpha", "A1", "A2", "Beta"]);

			const {status, body} = await post(
				{
					rootId: null,
					limit: 100,
					showCompleted: false,
				},
			);

			expect(
				{
					status,
					lists: lists(body),
				},
			).toStrictEqual(
				{
					status: 200,
					lists: [
						[null, ["Alpha", "Beta"], null],
						["Alpha", ["A1", "A2"], NO_BACKLINKS],
						["A1", ["A1a"], NO_BACKLINKS],
						["Beta", ["B1"], NO_BACKLINKS],
					],
				},
			);
		});

		it("expands a pane's own stored expansion when the view names the pane, and the account's otherwise", async () =>
		{
			const {post, patchExpansion} = setup(["Alpha"]);
			const statuses = [
				await patchExpansion(
					{
						paneId: "pane1",
						changes:
						{
							Alpha: true,
							Beta: true,
						},
						replace: true,
					},
				),
				await patchExpansion(
					{
						paneId: "pane1",
						changes:
						{
							Alpha: false,
						},
					},
				),
				await patchExpansion(
					{
						paneId: "pane2",
						changes:
						{
							A1: true,
						},
						replace: true,
					},
				),
			];
			const view = async (paneId?: string) =>
			{
				const {body} = await post(
					{
						rootId: null,
						limit: 100,
						showCompleted: false,
						...(paneId === undefined
							? {}
							:
								{
									paneId,
								}),
					},
				);
				return {
					lists: lists(body),
					expandedIds: body.expandedIds,
				};
			};

			expect(
				{
					statuses,
					pane1: await view("pane1"),
					account: await view(),
				},
			).toStrictEqual(
				{
					statuses: [204, 204, 204],
					pane1:
					{
						lists: [
							[null, ["Alpha", "Beta"], null],
							["Beta", ["B1"], NO_BACKLINKS],
						],
						expandedIds: ["Beta"],
					},
					account:
					{
						lists: [
							[null, ["Alpha", "Beta"], null],
							["Alpha", ["A1", "A2"], NO_BACKLINKS],
						],
						expandedIds: ["Alpha"],
					},
				},
			);
		});

		it("descends into a completed expanded row when completed rows show", async () =>
		{
			const {post} = setup(["A2"]);

			const {body} = await post(
				{
					rootId: "Alpha",
					limit: 100,
					showCompleted: true,
				},
			);

			expect(lists(body)).toStrictEqual([
				["Alpha", ["A1", "A2"], NO_BACKLINKS],
				["A2", ["A2a"], NO_BACKLINKS],
			]);
		});

		it("stops descending once the row budget is spent", async () =>
		{
			const {post} = setup(["Alpha", "A1", "Beta"]);

			const {body} = await post(
				{
					rootId: null,
					limit: 3,
					showCompleted: false,
				},
			);

			expect(lists(body)).toStrictEqual([
				[null, ["Alpha", "Beta"], null],
				["Alpha", ["A1", "A2"], NO_BACKLINKS],
				["A1", ["A1a"], NO_BACKLINKS],
			]);
		});

		it("lists an expanded mirror's original's children under the mirror's id", async () =>
		{
			const {post, mirror} = setup(["M"]);
			mirror("M", "Beta", "Alpha");

			const {body} = await post(
				{
					rootId: "Beta",
					limit: 100,
					showCompleted: false,
				},
			);

			expect(lists(body)).toStrictEqual([
				["Beta", ["B1", "M"], NO_BACKLINKS],
				["M", ["A1", "A2"], NO_BACKLINKS],
			]);
		});

		it("sends each list once and stops at a mirror inside its own original", async () =>
		{
			const {post, mirror} = setup(["Alpha", "A1", "Mmmm"]);
			mirror("Mmmm", "A1", "Alpha");

			const {body} = await post(
				{
					rootId: null,
					limit: 200,
					showCompleted: false,
				},
			);

			expect(lists(body)).toStrictEqual([
				[null, ["Alpha", "Beta"], null],
				["Alpha", ["A1", "A2"], NO_BACKLINKS],
				["A1", ["A1a", "Mmmm"], NO_BACKLINKS],
				["Mmmm", ["A1", "A2"], NO_BACKLINKS],
			]);
		});

		it("orders siblings by order key then creation time and spends the budget in that order", async () =>
		{
			const {post, add} = setup(["Huge", "B1"]);
			add("Neg", "Beta", -5);
			add("Huge", "Beta", 2 ** 40);
			add("H1", "Huge", 0);
			add(
				"NoMeta",
				"Beta",
				3,
				{
					metadata: false,
				},
			);

			const {body} = await post(
				{
					rootId: "Beta",
					limit: 3,
					showCompleted: false,
				},
			);

			expect(
				{
					lists: lists(body),
					priorities: body.lists.map(
						(list: {
							nodes:
							{
								priority: number;
							}[];
						}) => list.nodes.map((node) => node.priority),
					),
				},
			).toStrictEqual(
				{
					lists: [
						["Beta", ["Neg", "NoMeta", "B1", "Huge"], NO_BACKLINKS],
						["B1", [], NO_BACKLINKS],
					],
					priorities: [[0, 1, 2, 3], []],
				},
			);
		});

		it("neither counts nor expands a hidden completed row", async () =>
		{
			const {post, add} = setup(["A0", "A1"]);
			add(
				"A0",
				"Alpha",
				-1,
				{
					completedAt: 300,
				},
			);
			add("A0a", "A0", 0);

			const {body} = await post(
				{
					rootId: "Alpha",
					limit: 1,
					showCompleted: false,
				},
			);

			expect(lists(body)).toStrictEqual([
				["Alpha", ["A0", "A1", "A2"], NO_BACKLINKS],
				["A1", ["A1a"], NO_BACKLINKS],
			]);
		});

		it("expands a row inside a mirror by its instance key, not its own id", async () =>
		{
			const view = async (expanded: string[]) =>
			{
				const {post, mirror} = setup(expanded);
				mirror("M", "Beta", "Alpha");
				return post(
					{
						rootId: "Beta",
						limit: 100,
						showCompleted: false,
					},
				);
			};

			const [instance, plain] = await Promise.all([view(["M", "virtual_A1_M_M"]), view(["M", "A1"])]);

			expect(
				{
					instance: lists(instance.body),
					plain: lists(plain.body),
				},
			).toStrictEqual(
				{
					instance: [
						["Beta", ["B1", "M"], NO_BACKLINKS],
						["M", ["A1", "A2"], NO_BACKLINKS],
						["A1", ["A1a"], NO_BACKLINKS],
					],
					plain: [
						["Beta", ["B1", "M"], NO_BACKLINKS],
						["M", ["A1", "A2"], NO_BACKLINKS],
					],
				},
			);
		});

		it("returns the listed rows the account has expanded", async () =>
		{
			const {post} = setup(["Alpha", "A1", "A2", "Beta", "Elsewhere"]);

			const {body} = await post(
				{
					rootId: null,
					limit: 100,
					showCompleted: false,
				},
			);

			expect(
				{
					lists: lists(body),
					expandedIds: body.expandedIds,
				},
			).toStrictEqual(
				{
					lists: [
						[null, ["Alpha", "Beta"], null],
						["Alpha", ["A1", "A2"], NO_BACKLINKS],
						["A1", ["A1a"], NO_BACKLINKS],
						["Beta", ["B1"], NO_BACKLINKS],
					],
					expandedIds: ["Alpha", "Beta", "A1", "A2"],
				},
			);
		});

		it("expands nothing without the internal API", async () =>
		{
			const {post} = setup();

			const {body} = await post(
				{
					rootId: null,
					limit: 100,
					showCompleted: false,
				},
			);

			expect(
				{
					lists: lists(body),
					expandedIds: body.expandedIds,
				},
			).toStrictEqual(
				{
					lists: [[null, ["Alpha", "Beta"], null]],
					expandedIds: [],
				},
			);
		});

		it("sends each listed parent's whole Backlinks section", async () =>
		{
			const {post, mirror, add, referencesRoot} = setup(["Alpha", "A1", "Beta", "B1", "M"]);
			add("D1", "B1", 0);
			add("D2", "D1", 0);
			add("D3", "D2", 0);
			add(
				"Cmp",
				"Beta",
				5,
				{
					completedAt: 300,
				},
			);
			// Alpha: a deep source, a completed source, and an item whose source is not cached.
			referencesRoot("RA", "Alpha");
			mirror("IA1", "RA", "D3");
			mirror("IA2", "RA", "Cmp");
			mirror("IA3", "RA", "Nope");
			// Beta's references root holds a plain row too, the source of A1's only backlink: its crumbs show the label.
			referencesRoot("RB", "Beta");
			mirror("IB", "RB", "D2");
			add("Nested", "RB", 0);
			referencesRoot("RA1", "A1");
			mirror("IX", "RA1", "Nested");
			// B1's section is empty.
			referencesRoot("RB1", "B1");
			mirror("M", "Beta", "Alpha");

			const {body} = await post(
				{
					rootId: null,
					limit: 100,
					showCompleted: true,
				},
			);

			const alpha =
			{
				rootId: "RA",
				items: [
					backlinkItem(
						"IA1",
						"RA",
						"D3",
						{
							crumbs: ["Beta", "B1", "D1", "D2"],
						},
					),
					backlinkItem(
						"IA2",
						"RA",
						"Cmp",
						{
							completedAt: 300,
							index: 1,
							crumbs: ["Beta"],
						},
					),
				],
			};
			expect(body.lists.map((list: ListBody) => [list.parentId, list.backlinks])).toStrictEqual([
				[null, null],
				["Alpha", alpha],
				[
					"A1",
					{
						rootId: "RA1",
						items: [
							backlinkItem(
								"IX",
								"RA1",
								"Nested",
								{
									crumbs: [
										"Beta",
										{
											id: "RB",
											name: "1 Backlink",
										},
									],
								},
							),
						],
					},
				],
				[
					"Beta",
					{
						rootId: "RB",
						items: [
							backlinkItem(
								"IB",
								"RB",
								"D2",
								{
									children: true,
									crumbs: ["Beta", "B1", "D1"],
								},
							),
						],
					},
				],
				[
					"B1",
					{
						rootId: "RB1",
						items: [],
					},
				],
				["M", alpha],
			]);
		});

		it("answers 404 for an unresolvable short root id and 400 for a malformed body or one carrying expandedIds", async () =>
		{
			const {post} = setup();

			await expect(
				Promise.all([
					post(
						{
							rootId: "0123456789ab",
							limit: 10,
							showCompleted: false,
						},
					),
					post(
						{
							rootId: null,
							limit: "10",
							showCompleted: false,
						},
					),
					post(
						{
							rootId: null,
							expandedIds: ["Alpha"],
							limit: 10,
							showCompleted: false,
						},
					),
				]),
			).resolves.toStrictEqual([
				{
					status: 404,
					body:
					{
						error: "Node not found",
					},
				},
				{
					status: 400,
					body:
					{
						error: "body must be {rootId, limit, showCompleted}",
					},
				},
				{
					status: 400,
					body:
					{
						error: "body must be {rootId, limit, showCompleted}",
					},
				},
			]);
		});
	});

	/** Durable Object SQLite rejects a statement with more than 100 bound parameters. */
	const DURABLE_OBJECT_PARAMETER_CAP = 100;

	/**
	 * Home holds `Root`, which holds `width` rows `P000..`, each the top of a chain `depth` rows deep. Every row is
	 * expanded. With `backlinks`, every row also has a references root holding one backlink item from its own source
	 * row under Home's `Sources > Group`. Statements past the Durable Object's bound-parameter cap fail the way workerd
	 * does, and every prepared statement during a request is counted.
	 */
	function wideSetup(width: number, depth: number, {backlinks = false, sourceDepth = 2} = {})
	{
		const sqlite = migratedMemoryDatabase();
		const db = drizzle(
			sqlite,
			{
				schema,
			},
		);
		const cacheService = new CacheService(db);
		cacheService.insertNode(apiNode("Root", null, 0), null);
		cacheService.insertNode(apiNode("Sources", null, 1), null);
		cacheService.insertNode(apiNode("Group", "Sources", 0), "Sources");
		// Every source sits `sourceDepth` levels under Home: Sources > Group > Group-2 > ...
		let sourceParent = "Group";
		for (let level = 2; level < sourceDepth; level += 1)
		{
			cacheService.insertNode(apiNode(`Group-${level}`, sourceParent, 0), sourceParent);
			sourceParent = `Group-${level}`;
		}
		const live = ["2000-01-01T00:00:00.000Z", FAR_FUTURE_DATE];
		/** Give `target` a references root holding a backlink item from a new source row. */
		const backlinkTo = (target: string) =>
		{
			cacheService.insertNode(apiNode(`S-${target}`, sourceParent, 0), sourceParent);
			cacheService.insertNode(apiNode(`R-${target}`, target, 99), target);
			cacheService.insertNode(apiNode(`I-${target}`, `R-${target}`, 0), `R-${target}`);
			sqlite
				.prepare("INSERT INTO references_roots (node_id, system_from, system_to) VALUES (?, ?, ?)")
				.run(`R-${target}`, ...live);
			sqlite
				.prepare("INSERT INTO mirrors (mirror_id, original_id, system_from, system_to) VALUES (?, ?, ?, ?)")
				.run(`I-${target}`, `S-${target}`, ...live);
		};
		const expandedIds = ["Root"];
		for (let index = 0; index < width; index += 1)
		{
			let parentId = "Root";
			for (let level = 0; level < depth; level += 1)
			{
				const id = `P${String(index).padStart(3, "0")}-${level}`;
				cacheService.insertNode(apiNode(id, parentId, level === 0 ? index : 0), parentId);
				expandedIds.push(id);
				if (backlinks)
				{
					backlinkTo(id);
				}
				parentId = id;
			}
		}
		for (const id of expandedIds)
		{
			sqlite
				.prepare("INSERT INTO expanded_nodes (short_key, system_from, system_to) VALUES (?, ?, ?)")
				.run(upstreamExpansionKey(id), ...live);
		}
		const expanded = new Set(expandedIds.map(upstreamExpansionKey));
		let statements = 0;
		const prepare = sqlite.prepare.bind(sqlite);
		sqlite.prepare = (source: string) =>
		{
			statements += 1;
			const parameters = source.match(/\?/gu)?.length ?? 0;
			if (parameters > DURABLE_OBJECT_PARAMETER_CAP)
			{
				throw new Error(`too many SQL variables: ${parameters}`);
			}
			return prepare(source);
		};
		const ctx =
		{
			db,
			cacheService,
			internalAdapter: () => (
			{
				expansionTest: () => (id: string) => expanded.has(upstreamExpansionKey(id)),
			}),
		} as unknown as ServerContext;
		const app = new Hono<AppEnv>();
		app.use("*", async (c, next) =>
		{
			c.set("ctx", ctx);
			await next();
		});
		app.route("/", httpAppFor(ctx));
		const view = async () =>
		{
			statements = 0;
			const res = await app.fetch(
				new Request(
					"http://x/api/v1/nodes/view",
					{
						method: "POST",
						headers:
						{
							"Content-Type": "application/json",
						},
						body: JSON.stringify(
							{
								rootId: "Root",
								limit: 100_000,
								showCompleted: false,
							},
						),
					},
				),
			);
			// A failed view answers {error} without lists.
			const {lists: viewLists = []} = (await res.json()) as
			{
				lists?: ListBody[];
			};
			return {
				status: res.status,
				lists: viewLists,
				listCount: viewLists.length,
				statements,
			};
		};
		return {
			view,
		};
	}

	describe("POST /api/v1/nodes/view deep fetch", () =>
	{
		it("reads a level of more expanded parents than a Durable Object statement may bind", async () =>
		{
			const {view} = wideSetup(150, 2);

			const {status, listCount} = await view();

			expect(
				{
					status,
					listCount,
				},
			).toStrictEqual(
				{
					status: 200,
					listCount: 1 + 150 * 2,
				},
			);
		});

		it("reads the whole tree in one statement however wide or deep the view", async () =>
		{
			const narrow = await wideSetup(3, 2).view();
			const wide = await wideSetup(150, 2).view();
			const deep = await wideSetup(20, 6).view();

			expect(
				{
					narrow: narrow.statements,
					wide: wide.statements,
					deep: deep.statements,
				},
			).toStrictEqual(
				{
					narrow: 1,
					wide: 1,
					deep: 1,
				},
			);
		});

		it("reads every expanded row's Backlinks section in one more statement however many rows have one or how deep their sources sit", async () =>
		{
			const narrow = await wideSetup(
				3,
				2,
				{
					backlinks: true,
				},
			).view();
			const wide = await wideSetup(
				150,
				2,
				{
					backlinks: true,
				},
			).view();
			const deepSources = await wideSetup(
				3,
				2,
				{
					backlinks: true,
					sourceDepth: 8,
				},
			).view();

			expect(
				{
					statements: [narrow.statements, wide.statements, deepSources.statements],
					last: wide.lists.at(-1),
				},
			).toStrictEqual(
				{
					statements: [2, 2, 2],
					last:
					{
						parentId: "P149-1",
						nodes: [],
						backlinks:
						{
							rootId: "R-P149-1",
							items: [
								{
									node: expect.objectContaining(
										{
											id: "I-P149-1",
											isMirror: true,
											originalNodeId: "S-P149-1",
										},
									),
									sourceId: "S-P149-1",
									crumbs: [
										{
											id: "Sources",
											name: "Sources",
										},
										{
											id: "Group",
											name: "Group",
										},
									],
								},
							],
						},
					},
				},
			);
		});
	});
});

describe("nodes virtual id route", () =>
{
	const CHILD = "7b1c2d3e-aaaa-4bbb-8ccc-c910f3eac9b3";
	const MIRROR = "0e9f8d7c-1111-4222-8333-d4f14a54f384";

	describe("GET /api/v1/nodes/:id with a virtual location id", () =>
	{
		it("resolves v_<child12>_<mirror12> to the original child it shows", async () =>
		{
			const sqlite = migratedMemoryDatabase();
			const db = drizzle(
				sqlite,
				{
					schema,
				},
			);
			const cacheService = new CacheService(db);
			cacheService.insertNode(
				{
					id: CHILD,
					name: "child",
					note: null,
					parent_id: null,
					priority: 0,
					createdAt: 1,
					modifiedAt: 2,
				},
				null,
			);
			const ctx =
			{
				db,
				cacheService,
			} as unknown as ServerContext;
			const app = new Hono<AppEnv>();
			app.use("*", async (c, next) =>
			{
				c.set("ctx", ctx);
				await next();
			});
			app.route("/", httpAppFor(ctx));

			const res = await app.fetch(new Request(`http://x/api/v1/nodes/v_c910f3eac9b3_${MIRROR.slice(-12)}_0e9f`));

			expect(
				{
					status: res.status,
					id: (
						(await res.json()) as
						{
							node:
							{
								id: string;
							};
						}
					).node.id,
				},
			).toStrictEqual(
				{
					status: 200,
					id: CHILD,
				},
			);
		});
	});

	describe("GET /api/v1/nodes/:id/ancestors with a virtual location id", () =>
	{
		it("lists the mirror's ancestors and the mirror, then the rows below its original down to the row", async () =>
		{
			const sqlite = migratedMemoryDatabase();
			const db = drizzle(
				sqlite,
				{
					schema,
				},
			);
			const cacheService = new CacheService(db);
			const ORIGINAL = "aaaa1111-0000-4000-8000-a0a0a0a0a0a0";
			const MIDDLE = "5d5d5d5d-aaaa-4bbb-8ccc-0123456789ab";
			const PARENT = "99990000-1111-4222-8333-444455556666";
			const node = (id: string, parentId: string | null) => (
			{
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
			const ctx =
			{
				db,
				cacheService,
			} as unknown as ServerContext;
			const app = new Hono<AppEnv>();
			app.use("*", async (c, next) =>
			{
				c.set("ctx", ctx);
				await next();
			});
			app.route("/", httpAppFor(ctx));
			const ids = async (id: string) =>
			{
				const res = await app.fetch(new Request(`http://x/api/v1/nodes/${id}/ancestors`));
				return (
					(await res.json()) as
					{
						ancestors:
						{
							id: string;
						}[];
					}
				).ancestors.map((ancestor) => ancestor.id);
			};

			expect(
				{
					instance: await ids(`v_c910f3eac9b3_${MIRROR.slice(-12)}_0e9f5d5d`),
					plain: await ids(CHILD),
				},
			).toStrictEqual(
				{
					instance: [PARENT, MIRROR, MIDDLE, CHILD],
					plain: [ORIGINAL, MIDDLE, CHILD],
				},
			);
		});
	});
});
