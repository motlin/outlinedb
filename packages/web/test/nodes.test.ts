import {afterEach, describe, expect, it, vi, beforeEach} from "vite-plus/test";
import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {Hono} from "hono";
import {join} from "node:path";
import {
	BULK_IMPORT_LEASE_NAME,
	BULK_IMPORT_TIMEOUT_MS,
	closeCurrentVersions,
	runUnitOfWork,
	stampImportTime,
	TRANSACTION_TIMEOUT_MS,
	CacheService,
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
import {LadderEventBus} from "../src/server/ladder-events.js";
import {inProcessStore} from "../src/server/store.js";
import type {StoreClient} from "../src/server/store.js";
import {upstreamExpansionKey} from "@outlinedb/shared/workflowy";

describe("nodes changes route", () => {
	const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");

	function apiNode(id: string, parentId: string | null, priority: number): WorkflowyNode {
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
	function stamp(ms: number): string {
		return new Date(T0 + ms).toISOString().replace("T", " ").replace("Z", "");
	}

	/**
	 * Home holds `parents` parents P0.., each with two children, seeded at {@link T0}. The clock then stands a
	 * transaction timeout plus a minute later, so the seeding falls behind every watermark the test sees.
	 */
	function setup(parents: number) {
		vi.useFakeTimers({toFake: ["Date"], now: T0});
		const sqlite = new DatabaseConstructor(":memory:");
		let statements = 0;
		const db = drizzle(sqlite, {
			schema,
			logger: {
				logQuery() {
					statements += 1;
				},
			},
		});
		migrate(db, {migrationsFolder});
		const cacheService = new CacheService(db);
		for (let p = 0; p < parents; p++) {
			cacheService.insertNode(apiNode(`P${p}`, null, p), null);
			for (let k = 0; k < 2; k++) {
				cacheService.insertNode(apiNode(`P${p}c${k}`, `P${p}`, k), `P${p}`);
			}
		}
		vi.setSystemTime(T0 + TRANSACTION_TIMEOUT_MS + 60_000);
		const ctx = {db, cacheService} as unknown as ServerContext;
		const app = new Hono<AppEnv>();
		app.use("*", async (c, next) => {
			c.set("ctx", ctx);
			await next();
		});
		app.route("/", httpAppFor(ctx));
		const changes = async (since: string | null) => {
			const before = statements;
			const query = since === null ? "" : `?since=${encodeURIComponent(since)}`;
			const res = await app.fetch(new Request(`http://x/api/v1/nodes/changes${query}`));
			const body = (await res.json()) as NodeChangesResponse;
			return {status: res.status, body, statements: statements - before};
		};
		return {db, cacheService, changes};
	}

	/** A response reduced to what a test compares: id sets, and each list as parent -> child ids. */
	function shape(body: NodeChangesResponse) {
		return {
			reset: body.reset,
			changedIds: new Set(body.changedIds),
			deletedIds: new Set(body.deletedIds),
			children: Object.fromEntries(
				body.children.map(({parentId, nodes}) => [parentId ?? "home", nodes.map((node) => node.id)]),
			),
		};
	}

	describe("GET /api/v1/nodes/changes", () => {
		afterEach(() => {
			vi.useRealTimers();
		});

		it("without since answers only the watermark: now less the transaction timeout", async () => {
			const {changes} = setup(1);

			const {status, body} = await changes(null);

			expect({status, latest: body.latest, ...shape(body)}).toStrictEqual({
				status: 200,
				latest: stamp(60_000),
				reset: false,
				changedIds: new Set(),
				deletedIds: new Set(),
				children: {},
			});
		});

		it("answers a created node with its parent's refreshed children", async () => {
			const {cacheService, changes} = setup(2);
			const seeded = await changes(null);
			vi.setSystemTime(T0 + TRANSACTION_TIMEOUT_MS + 70_000);
			cacheService.insertNode(apiNode("New", "P1", 5), "P1");

			const {body} = await changes(seeded.body.latest);

			expect({latest: body.latest, ...shape(body)}).toStrictEqual({
				latest: stamp(70_000),
				reset: false,
				changedIds: new Set(["New"]),
				deletedIds: new Set(),
				children: {P1: ["P1c0", "P1c1", "New"]},
			});
		});

		it("answers a moved node with both its old and new parents' children", async () => {
			const {cacheService, changes} = setup(2);
			const seeded = await changes(null);
			cacheService.insertNode(apiNode("P0c1", "P1", 5), "P1");

			const {body} = await changes(seeded.body.latest);

			expect(shape(body)).toStrictEqual({
				reset: false,
				changedIds: new Set(["P0c1"]),
				deletedIds: new Set(),
				children: {P0: ["P0c0"], P1: ["P1c0", "P1c1", "P0c1"]},
			});
		});

		it("answers a deleted node as deleted, with its parent's children", async () => {
			const {cacheService, changes} = setup(2);
			const seeded = await changes(null);
			cacheService.deleteNode("P1c0");

			const {body} = await changes(seeded.body.latest);

			expect(shape(body)).toStrictEqual({
				reset: false,
				changedIds: new Set(["P1c0"]),
				deletedIds: new Set(["P1c0"]),
				children: {P1: ["P1c1"]},
			});
		});

		it("delivers a change stamped before an earlier poll's watermark that commits after it", async () => {
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

			const reduce = ({body}: {body: NodeChangesResponse}) => ({latest: body.latest, ...shape(body)});
			expect({
				first: reduce(first),
				second: reduce(second),
				third: reduce(third),
				fourth: reduce(fourth),
			}).toStrictEqual({
				first: {
					latest: stamp(70_000),
					reset: false,
					changedIds: new Set(["Later"]),
					deletedIds: new Set(),
					children: {P0: ["P0c0", "P0c1", "Later"]},
				},
				// The last timeout window is read again, so "Later" repeats, once, beside "Earlier".
				second: {
					latest: stamp(80_000),
					reset: false,
					changedIds: new Set(["Later", "Earlier"]),
					deletedIds: new Set(),
					children: {P0: ["P0c0", "P0c1", "Later"], P1: ["P1c0", "P1c1", "Earlier"]},
				},
				third: {
					latest: stamp(2 * TRANSACTION_TIMEOUT_MS + 120_000),
					reset: false,
					changedIds: new Set(["Later", "Earlier"]),
					deletedIds: new Set(),
					children: {P0: ["P0c0", "P0c1", "Later"], P1: ["P1c0", "P1c1", "Earlier"]},
				},
				fourth: {
					latest: stamp(2 * TRANSACTION_TIMEOUT_MS + 120_000),
					reset: false,
					changedIds: new Set(),
					deletedIds: new Set(),
					children: {},
				},
			});
			expect(second.body.changedIds).toStrictEqual([...new Set(second.body.changedIds)]);
		});

		it("holds the watermark before an in-flight bulk import's lease, so its late commit still arrives", async () => {
			const {db, cacheService, changes} = setup(1);
			const leaseAt = T0 + TRANSACTION_TIMEOUT_MS + 60_000;
			runUnitOfWork(db, (unitOfWork) => {
				stampImportTime(unitOfWork, BULK_IMPORT_LEASE_NAME, leaseAt + BULK_IMPORT_TIMEOUT_MS);
			});
			// The import runs five minutes, far past the transaction timeout.
			vi.setSystemTime(leaseAt + 300_000);
			const during = await changes(null);
			// It commits a row stamped when it read the clock, right after taking its lease, and ends the lease.
			vi.setSystemTime(leaseAt);
			cacheService.insertNode(apiNode("Bulk", "P0", 5), "P0");
			vi.setSystemTime(leaseAt + 300_001);
			runUnitOfWork(db, ({tx, systemTime}) => {
				closeCurrentVersions(
					tx,
					schema.apiImportTimestamp,
					systemTime,
					eq(schema.apiImportTimestamp.name, BULK_IMPORT_LEASE_NAME),
				);
			});
			const after = await changes(during.body.latest);

			const reduce = ({body}: {body: NodeChangesResponse}) => ({latest: body.latest, ...shape(body)});
			expect({during: reduce(during), after: reduce(after)}).toStrictEqual({
				during: {
					latest: stamp(TRANSACTION_TIMEOUT_MS + 60_000 - 1),
					reset: false,
					changedIds: new Set(),
					deletedIds: new Set(),
					children: {},
				},
				after: {
					latest: stamp(TRANSACTION_TIMEOUT_MS + 60_000 + 300_001 - TRANSACTION_TIMEOUT_MS),
					reset: false,
					changedIds: new Set(["Bulk"]),
					deletedIds: new Set(),
					children: {P0: ["P0c0", "P0c1", "Bulk"]},
				},
			});
		});

		it("ignores a bulk import lease past its expiry, which a crashed import leaves open", async () => {
			const {db, changes} = setup(1);
			const leaseAt = T0 + TRANSACTION_TIMEOUT_MS + 60_000;
			runUnitOfWork(db, (unitOfWork) => {
				stampImportTime(unitOfWork, BULK_IMPORT_LEASE_NAME, leaseAt + BULK_IMPORT_TIMEOUT_MS);
			});
			vi.setSystemTime(leaseAt + BULK_IMPORT_TIMEOUT_MS + 1000);

			const {body} = await changes(null);

			expect(body.latest).toBe(stamp(60_000 + BULK_IMPORT_TIMEOUT_MS + 1000));
		});

		it("answers reset for a cursor it never issued", async () => {
			const {changes} = setup(1);
			const seeded = await changes(null);

			const resets = await Promise.all(
				["42", stamp(60_001)].map(async (since) => {
					const {body} = await changes(since);
					return {reset: body.reset, latest: body.latest};
				}),
			);

			expect(resets).toStrictEqual([
				{reset: true, latest: seeded.body.latest},
				{reset: true, latest: seeded.body.latest},
			]);
		});

		it("keeps its statement count independent of how many parents changed", async () => {
			const run = async (parents: number) => {
				const {cacheService, changes} = setup(parents);
				const seeded = await changes(null);
				vi.setSystemTime(T0 + TRANSACTION_TIMEOUT_MS + 70_000);
				for (let p = 0; p < parents; p++) {
					cacheService.insertNode(apiNode(`New${p}`, `P${p}`, 5), `P${p}`);
				}
				return changes(seeded.body.latest);
			};

			const few = await run(2);
			const many = await run(12);

			expect({
				few: Object.keys(shape(few.body).children).length,
				many: Object.keys(shape(many.body).children).length,
				same: few.statements === many.statements,
			}).toStrictEqual({few: 2, many: 12, same: true});
			expect(many.statements).toBeLessThanOrEqual(40);
		});
	});
});

describe("nodes children batch route", () => {
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
});

describe("nodes complete mirror route", () => {
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
});

describe("nodes duplicate route", () => {
	const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");

	function apiNode(
		id: string,
		parentId: string | null,
		priority: number,
		extra: Partial<WorkflowyNode> = {},
	): WorkflowyNode {
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
	function setup(expanded: string[] = [], mode: "mirror" | "standalone" = "mirror") {
		const sqlite = new DatabaseConstructor(":memory:");
		const db = drizzle(sqlite, {schema});
		migrate(db, {migrationsFolder});
		const cacheService = new CacheService(db);
		cacheService.insertNode(apiNode("P", null, 0), null);
		cacheService.insertNode(apiNode("O", null, 1, {note: "n", completed: true, completedAt: 5}), null);
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
		const createTreesAt = vi.fn<WorkflowyInternalAdapter["createTreesAt"]>(async (input) =>
			Promise.resolve({ids: input.trees.map((tree) => tree.id ?? "")}),
		);
		const setExpanded = vi.fn<WorkflowyInternalAdapter["setExpanded"]>(async () => Promise.resolve());
		const expansionTest = vi.fn<WorkflowyInternalAdapter["expansionTest"]>(
			() => (id: string) => expanded.includes(id),
		);
		const ctx = {
			db,
			cacheService,
			mode,
			apiKey: mode === "standalone" ? undefined : "test-key",
			internalAuth: {},
			internalAdapter: () => ({createTreesAt, setExpanded, expansionTest}) as unknown as WorkflowyInternalAdapter,
		} as unknown as ServerContext;
		const app = new Hono<AppEnv>();
		app.use("*", async (c, next) => {
			c.set("ctx", ctx);
			await next();
		});
		app.route("/", httpAppFor(ctx));
		const post = async (body: unknown) =>
			app.fetch(
				new Request("http://x/api/v1/nodes/duplicate", {
					method: "POST",
					headers: {"content-type": "application/json"},
					body: JSON.stringify(body),
				}),
			);
		return {createTreesAt, setExpanded, post, cacheService};
	}

	const anyId = expect.any(String) as string;

	describe("POST /api/v1/nodes/duplicate", () => {
		it("deep-copies each item to consecutive slots with one bulk create: note, completion, children, and child mirrors stay mirrors", async () => {
			const {createTreesAt, post} = setup();

			const res = await post({ids: ["O", "P"], parent_id: "P", index: 2});

			const call = createTreesAt.mock.calls[0]?.[0];
			expect({status: res.status, call, ids: ((await res.json()) as {ids: string[]}).ids}).toStrictEqual({
				status: 201,
				call: {
					parentId: "P",
					index: 2,
					trees: [
						{
							id: anyId,
							name: "o",
							note: "n",
							completed: true,
							children: [
								{id: anyId, name: "c", children: [{id: anyId, name: "g"}]},
								{id: anyId, name: "", metadata: {mirror: {originalId: "X", isMirrorRoot: true}}},
							],
						},
						{
							id: anyId,
							name: "p",
							children: [
								{id: anyId, name: "", metadata: {mirror: {originalId: "O", isMirrorRoot: true}}},
							],
						},
					],
				},
				ids: call.trees.map((tree) => tree.id),
			});
		});

		it("duplicates a mirror from its original and opens copies whose source rows are expanded", async () => {
			const {createTreesAt, setExpanded, post} = setup(["M", "C"]);

			await post({ids: ["M"], parent_id: null, index: 0});

			const [tree] = createTreesAt.mock.calls[0]?.[0].trees ?? [];
			expect({
				name: tree.name,
				parent: createTreesAt.mock.calls[0]?.[0].parentId,
				opened: setExpanded.mock.calls,
			}).toStrictEqual({
				name: "o",
				parent: "home",
				opened: [[{[tree.id ?? ""]: true, [tree.children?.[0]?.id ?? ""]: true}]],
			});
		});

		it("rejects an empty id list and an unknown id without writing", async () => {
			const {createTreesAt, post} = setup();

			const empty = await post({ids: [], parent_id: "P", index: 0});
			const unknown = await post({ids: ["nope"], parent_id: "P", index: 0});

			expect({
				empty: empty.status,
				unknown: unknown.status,
				calls: createTreesAt.mock.calls.length,
			}).toStrictEqual({
				empty: 400,
				unknown: 404,
				calls: 0,
			});
		});

		it("deep-copies into the local tables in a standalone context, with no adapter", async () => {
			const {createTreesAt, post, cacheService} = setup([], "standalone");
			const shape = (parentId: string | null): unknown[] =>
				cacheService.getChildren(parentId).map((node) => ({
					name: node.name,
					note: node.note,
					completed: node.completedAt !== null,
					mirrorOf: cacheService.getMirrorOriginal(node.id) ?? null,
					children: shape(node.id),
				}));

			const res = await post({ids: ["O"], parent_id: "P", index: 0});
			const {ids} = (await res.json()) as {ids: string[]};

			expect({
				status: res.status,
				copy: shape("P")[0],
				first: ids[0] === cacheService.getChildren("P")[0]?.id,
				calls: createTreesAt.mock.calls.length,
			}).toStrictEqual({
				status: 201,
				copy: {
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
							children: [{name: "g", note: null, completed: false, mirrorOf: null, children: []}],
						},
						{name: "x", note: null, completed: false, mirrorOf: "X", children: []},
					],
				},
				first: true,
				calls: 0,
			});
		});
	});
});

describe("nodes lookup op", () => {
	const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");

	let sqlite: DatabaseConstructor.Database;
	let ctx: ServerContext;
	let store: StoreClient;

	beforeEach(() => {
		sqlite = new DatabaseConstructor(":memory:");
		const db = drizzle(sqlite, {schema});
		migrate(db, {migrationsFolder});
		ctx = buildServerContext({
			db,
			config: readNodeConfig({WORKFLOWY_API_KEY: "test-api-key"}),
			ladderEvents: new LadderEventBus(),
		});
		store = inProcessStore(ctx);
		const insert = (id: string, name: string, parentId: string | null, completedAt: number | null = null) => {
			ctx.cacheService.insertNode(
				{id, name, note: null, priority: 0, createdAt: 1_600_000_000, modifiedAt: 1_600_000_000, completedAt},
				parentId,
			);
		};
		insert("work", "Work", null);
		insert("projects", "Projects", "work");
		insert("alpha", "Alpha", "projects", 1_600_000_100);
		// A path the cache lacks falls back to the public API, which knows nothing more.
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => Promise.resolve(Response.json({nodes: []})));
	});

	afterEach(() => {
		sqlite.close();
	});

	describe("nodes.resolve", () => {
		it("resolves a comma path from the cache", async () => {
			await expect(store.call("nodes.resolve", {path: "Work, Projects"})).resolves.toStrictEqual({
				ok: true,
				value: {id: "projects"},
			});
		});

		it("resolves home to null as a parent", async () => {
			await expect(store.call("nodes.resolve", {id: "home", parent: true})).resolves.toStrictEqual({
				ok: true,
				value: {id: null},
			});
		});

		it("answers 404 with the resolver's message for an unknown path", async () => {
			await expect(store.call("nodes.resolve", {path: "Work,Nowhere"})).resolves.toStrictEqual({
				ok: false,
				status: 404,
				body: {error: "Node not found at path: Work > Nowhere"},
			});
		});

		it("needs the API key", async () => {
			const keyless = inProcessStore({...ctx, apiKey: undefined});

			await expect(keyless.call("nodes.resolve", {id: "work"})).resolves.toStrictEqual({
				ok: false,
				status: 500,
				body: {error: "WORKFLOWY_API_KEY environment variable is required"},
			});
		});
	});

	describe("nodes.readTree", () => {
		it("reads a parent's children with the requested depth of descendants", async () => {
			const result = await store.call("nodes.readTree", {parentId: "work", depth: 1});

			expect(
				result.ok &&
					result.value.nodes.map((node) => {
						const {id, children} = node as {id: string; children: {id: string}[]};
						return {id, children: children.map((child) => child.id)};
					}),
			).toStrictEqual([{id: "projects", children: ["alpha"]}]);
		});

		it("reads the named nodes without descendants by default", async () => {
			const result = await store.call("nodes.readTree", {ids: ["alpha"]});

			expect(
				result.ok &&
					result.value.nodes.map((node) => {
						const {id, name, completedAt} = node as {id: string; name: string; completedAt: string};
						return {id, name, completedAt, readsChildren: "children" in (node as object)};
					}),
			).toStrictEqual([
				{id: "alpha", name: "Alpha", completedAt: "2020-09-13T12:28:20.000Z", readsChildren: false},
			]);
		});
	});

	describe("cache.status", () => {
		it("counts live nodes, roots and completed nodes", async () => {
			await expect(store.call("cache.status", {})).resolves.toStrictEqual({
				ok: true,
				value: {
					totalNodes: 3,
					rootNodes: 1,
					completedNodes: 1,
					lastSync: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u),
					lastBackupImport: null,
				},
			});
		});
	});
});

describe("nodes mirror route", () => {
	const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");

	function apiNode(id: string, parentId: string | null, priority: number): WorkflowyNode {
		return {id, name: id.toUpperCase(), note: null, parent_id: parentId, priority, createdAt: 100, modifiedAt: 200};
	}

	/** Home holds O, P, L; P holds Q; Q holds R; M under P mirrors O. */
	function setup(configured = true, expanded: string[] = []) {
		const sqlite = new DatabaseConstructor(":memory:");
		const db = drizzle(sqlite, {schema});
		migrate(db, {migrationsFolder});
		const cacheService = new CacheService(db);
		for (const [index, id] of ["O", "P", "L"].entries()) {
			cacheService.insertNode(apiNode(id, null, index), null);
		}
		cacheService.insertNode(apiNode("Q", "P", 0), "P");
		cacheService.insertNode(apiNode("R", "Q", 0), "Q");
		cacheService.insertNode(apiNode("M", "P", 1), "P");
		sqlite
			.prepare("INSERT INTO mirrors (mirror_id, original_id, system_from, system_to) VALUES (?, ?, ?, ?)")
			.run("M", "O", "2000-01-01T00:00:00.000Z", FAR_FUTURE_DATE);
		let counter = 0;
		const createMirrorsAt = vi.fn<WorkflowyInternalAdapter["createMirrorsAt"]>(async (input) => {
			const mirrors = input.originalIds.map((originId) => {
				counter += 1;
				const mirrorId = `new${counter}`;
				cacheService.insertNode(apiNode(mirrorId, input.parentId === "home" ? null : input.parentId, 9), null);
				return {mirrorId, originId};
			});
			return Promise.resolve({mirrors});
		});
		const moveTo = vi.fn<WorkflowyInternalAdapter["moveTo"]>(async () => Promise.resolve());
		const setExpanded = vi.fn<WorkflowyInternalAdapter["setExpanded"]>(async () => Promise.resolve());
		const expansionTest = vi.fn<WorkflowyInternalAdapter["expansionTest"]>(
			() => (id: string) => expanded.includes(id),
		);
		const ctx = {
			db,
			cacheService,
			apiKey: "test-key",
			internalAuth: configured ? {} : undefined,
			internalAdapter: () =>
				configured
					? ({createMirrorsAt, setExpanded, expansionTest, moveTo} as unknown as WorkflowyInternalAdapter)
					: undefined,
		} as unknown as ServerContext;
		const app = new Hono<AppEnv>();
		app.use("*", async (c, next) => {
			c.set("ctx", ctx);
			await next();
		});
		app.route("/", httpAppFor(ctx));
		const post = async (path: string, body: unknown) =>
			app.fetch(
				new Request(`http://x/api/v1/nodes${path}`, {
					method: "POST",
					headers: {"content-type": "application/json"},
					body: JSON.stringify(body),
				}),
			);
		const get = async (path: string) => app.fetch(new Request(`http://x/api/v1/nodes${path}`));
		return {createMirrorsAt, setExpanded, moveTo, cacheService, sqlite, post, get};
	}

	describe("hasMirrors in the node DTO", () => {
		it("flags originals with a live mirror, and nothing else", async () => {
			const {get} = setup();

			const res = await get("?parent_id=P");
			const rows = ((await res.json()) as {nodes: {id: string; hasMirrors: boolean; isMirror: boolean}[]}).nodes;
			const home = ((await (await get("")).json()) as {nodes: {id: string; hasMirrors: boolean}[]}).nodes;

			expect({
				children: rows.map(({id, hasMirrors, isMirror}) => ({id, hasMirrors, isMirror})),
				home: home.map(({id, hasMirrors}) => ({id, hasMirrors})),
			}).toStrictEqual({
				children: [
					{id: "Q", hasMirrors: false, isMirror: false},
					{id: "M", hasMirrors: false, isMirror: true},
				],
				home: [
					{id: "O", hasMirrors: true},
					{id: "P", hasMirrors: false},
					{id: "L", hasMirrors: false},
				],
			});
		});
	});

	describe("POST /api/v1/nodes/mirror", () => {
		it("mirrors each item in order at consecutive indexes", async () => {
			const {createMirrorsAt, post} = setup();

			const res = await post("/mirror", {item_ids: ["O", "L"], parent_id: "P", index: 1});

			expect({status: res.status, calls: createMirrorsAt.mock.calls}).toStrictEqual({
				status: 201,
				calls: [[{originalIds: ["O", "L"], parentId: "P", index: 1}]],
			});
			const body = (await res.json()) as {nodes: {id: string}[]};
			expect(body.nodes.map((node) => node.id)).toStrictEqual(["new1", "new2"]);
		});

		it("resolves a mirror source to its original", async () => {
			const {createMirrorsAt, post} = setup();

			await post("/mirror", {item_ids: ["M"], parent_id: "L", index: 0});

			expect(createMirrorsAt.mock.calls).toStrictEqual([[{originalIds: ["O"], parentId: "L", index: 0}]]);
		});

		it("writes into the original's child list when the parent is a mirror", async () => {
			const {createMirrorsAt, post} = setup();

			await post("/mirror", {item_ids: ["L"], parent_id: "M", index: 0});

			expect(createMirrorsAt.mock.calls).toStrictEqual([[{originalIds: ["L"], parentId: "O", index: 0}]]);
		});

		it("rejects Home as the source", async () => {
			const {createMirrorsAt, post} = setup();

			const res = await post("/mirror", {item_ids: ["None"], parent_id: "P", index: 0});

			expect({
				status: res.status,
				body: await res.json(),
				calls: createMirrorsAt.mock.calls.length,
			}).toStrictEqual({
				status: 400,
				body: {error: "Cannot mirror Home"},
				calls: 0,
			});
		});

		it("rejects a source that is the parent or an ancestor of the destination", async () => {
			const {createMirrorsAt, post} = setup();

			const ancestor = await post("/mirror", {item_ids: ["P"], parent_id: "R", index: 0});
			const parent = await post("/mirror", {item_ids: ["Q"], parent_id: "Q", index: 0});

			expect({
				ancestor: [ancestor.status, await ancestor.json()],
				parent: [parent.status, await parent.json()],
				calls: createMirrorsAt.mock.calls.length,
			}).toStrictEqual({
				ancestor: [400, {error: "Cannot mirror an item into itself"}],
				parent: [400, {error: "Cannot mirror an item into itself"}],
				calls: 0,
			});
		});

		it("gives each new mirror its source row's expansion, a mirror source included", async () => {
			const {setExpanded, post} = setup(true, ["O", "M"]);

			await post("/mirror", {item_ids: ["O", "L", "M"], parent_id: "P", index: 0});

			expect(setExpanded.mock.calls).toStrictEqual([[{new1: true, new3: true}]]);
		});

		it("leaves expansion alone when no source is expanded", async () => {
			const {setExpanded, post} = setup();

			await post("/mirror", {item_ids: ["O"], parent_id: "P", index: 0});

			expect(setExpanded.mock.calls).toStrictEqual([]);
		});

		it("needs the internal adapter", async () => {
			const {post} = setup(false);

			const res = await post("/mirror", {item_ids: ["O"], parent_id: "P", index: 0});

			expect(res.status).toBe(503);
		});
	});

	describe("POST /api/v1/nodes/:id/swap-mirror-origin", () => {
		it("moves the mirror next to its original, then the original into the mirror's old slot", async () => {
			const {moveTo, post} = setup();

			const res = await post("/M/swap-mirror-origin", {});

			expect({status: res.status, moves: moveTo.mock.calls}).toStrictEqual({
				status: 200,
				moves: [[{ids: ["M"], parentId: "home", index: 0}], [{ids: ["O"], parentId: "P", index: 1}]],
			});
		});

		it("warns, and moves nothing, when the item is already the origin", async () => {
			const {moveTo, post} = setup();

			const res = await post("/O/swap-mirror-origin", {});

			expect({status: res.status, body: await res.json(), moves: moveTo.mock.calls.length}).toStrictEqual({
				status: 200,
				body: {warning: "This item is already the origin."},
				moves: 0,
			});
		});

		it("refuses a plain item, and a mirror that sits inside its own original", async () => {
			const {moveTo, cacheService, sqlite, post} = setup();
			cacheService.insertNode(apiNode("IN", "O", 0), "O");
			cacheService.insertNode(apiNode("CY", "IN", 0), "IN");
			sqlite
				.prepare("INSERT INTO mirrors (mirror_id, original_id, system_from, system_to) VALUES (?, ?, ?, ?)")
				.run("CY", "O", "2000-01-01T00:00:00.000Z", FAR_FUTURE_DATE);

			const plain = await post("/L/swap-mirror-origin", {});
			const cyclical = await post("/CY/swap-mirror-origin", {});

			expect({plain: plain.status, cyclical: cyclical.status, moves: moveTo.mock.calls.length}).toStrictEqual({
				plain: 400,
				cyclical: 400,
				moves: 0,
			});
		});
	});
});

describe("nodes standalone op", () => {
	const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");
	const SEEDED = 1_600_000_000;
	const NOW = 1_700_000_000;
	const NEW_ID = "0b6f3c1e-2d4a-4b8c-9e7f-1a2b3c4d5e6f";

	let sqlite: DatabaseConstructor.Database;
	let store: StoreClient;

	/** A seeded or written node as the REST API answers it: uncompleted, childless, at Home unless overridden. */
	function dto(id: string, overrides: Partial<NodeResponse> = {}): NodeResponse {
		return {
			id,
			parent_id: null,
			name: id,
			note: null,
			priority: 0,
			data: {layoutMode: null},
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

	beforeEach(() => {
		vi.useFakeTimers({toFake: ["Date"]});
		vi.setSystemTime(SEEDED * 1000);
		sqlite = new DatabaseConstructor(":memory:");
		const db = drizzle(sqlite, {schema});
		migrate(db, {migrationsFolder});
		// No WORKFLOWY_API_KEY: a standalone Node host.
		const ctx = buildServerContext({db, config: readNodeConfig({}), ladderEvents: new LadderEventBus()});
		store = inProcessStore(ctx);
		const insert = (id: string, parentId: string | null, priority: number) => {
			ctx.cacheService.insertNode(
				{id, name: id, note: null, priority, createdAt: SEEDED, modifiedAt: SEEDED, completedAt: null},
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

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		sqlite.close();
	});

	describe("node writes in a standalone context", () => {
		it("creates a node at a slot and reads it back", async () => {
			const created = dto(NEW_ID, {parent_id: "p", name: "new", priority: 1, createdAt: NOW, modifiedAt: NOW});

			await expect(
				store.call("nodes.create", {parent_id: "p", name: "new", index: 1, id: NEW_ID}),
			).resolves.toStrictEqual({ok: true, value: {node: created}, meta: {created: true}});
			await expect(store.call("nodes.children", {parentIds: ["p"]})).resolves.toStrictEqual({
				ok: true,
				value: {children: {p: [dto("a", {parent_id: "p"}), created, dto("b", {parent_id: "p", priority: 2})]}},
			});
		});

		it("creates at Home's bottom when the parent is omitted, as an empty outline's first bullet sends", async () => {
			await expect(store.call("nodes.create", {name: "", id: NEW_ID})).resolves.toStrictEqual({
				ok: true,
				value: {node: dto(NEW_ID, {name: "", priority: 2, createdAt: NOW, modifiedAt: NOW})},
				meta: {created: true},
			});
		});

		it("answers 404 for a create under an unknown parent", async () => {
			await expect(
				store.call("nodes.create", {parent_id: "4d7c2f10-0000-4000-8000-000000000000", name: "x"}),
			).resolves.toStrictEqual({ok: false, status: 404, body: {error: "Parent node not found"}});
		});

		it("updates a node's name and note and reads it back", async () => {
			const updated = dto("a", {parent_id: "p", name: "renamed", note: "a note", modifiedAt: NOW});

			await expect(store.call("nodes.update", {id: "a", name: "renamed", note: "a note"})).resolves.toStrictEqual(
				{
					ok: true,
					value: {node: updated, effects: {backlinkTargets: [], dates: false}},
				},
			);
			await expect(store.call("nodes.get", {id: "a"})).resolves.toStrictEqual({ok: true, value: {node: updated}});
		});

		it("writes numberedStart locally", async () => {
			await expect(store.call("nodes.update", {id: "a", numberedStart: 3})).resolves.toStrictEqual({
				ok: true,
				value: {
					node: dto("a", {parent_id: "p", numberedStart: 3, modifiedAt: NOW}),
					effects: {backlinkTargets: [], dates: false},
				},
			});
		});

		it("creates several trees at one slot", async () => {
			const result = await store.call("nodes.trees", {
				parent_id: "p",
				after_id: "a",
				trees: [
					{name: "t1", children: [{name: "t2"}]},
					{name: "t3", completed: true},
				],
			});
			const children = await store.call("nodes.children", {parentIds: ["p"]});

			expect(
				children.ok && result.ok
					? {
							ids: result.value.ids.length,
							names: children.value.children.p.map((node) => [
								node.name,
								node.hasChildren,
								node.completedAt,
							]),
						}
					: {result, children},
			).toStrictEqual({
				ids: 2,
				names: [
					["a", false, null],
					["t1", true, null],
					["t3", false, NOW],
					["b", false, null],
				],
			});
		});

		it("restores a deleted node under its original id, and answers 409 for a live one", async () => {
			await store.call("nodes.delete", {id: "a"});
			vi.setSystemTime((NOW + 1) * 1000);

			await expect(store.call("nodes.restore", {id: "a"})).resolves.toStrictEqual({
				ok: true,
				value: {node: dto("a", {parent_id: "p"})},
			});
			await expect(store.call("nodes.restore", {id: "b"})).resolves.toStrictEqual({
				ok: false,
				status: 409,
				body: {error: "Node is not deleted"},
			});
			await expect(
				store.call("nodes.restore", {id: "4d7c2f10-0000-4000-8000-000000000000"}),
			).resolves.toStrictEqual({
				ok: false,
				status: 404,
				body: {error: "Node not found"},
			});
		});

		it("deletes a node and closes the gap", async () => {
			await expect(store.call("nodes.delete", {id: "a"})).resolves.toStrictEqual({ok: true, value: null});
			await expect(store.call("nodes.get", {id: "a"})).resolves.toStrictEqual({
				ok: false,
				status: 404,
				body: {error: "Node not found"},
			});
			await expect(store.call("nodes.children", {parentIds: ["p"]})).resolves.toStrictEqual({
				ok: true,
				value: {children: {p: [dto("b", {parent_id: "p"})]}},
			});
		});

		it("completes and uncompletes a node", async () => {
			const completed = dto("a", {parent_id: "p", modifiedAt: NOW, completedAt: NOW});

			await expect(store.call("nodes.complete", {id: "a"})).resolves.toStrictEqual({
				ok: true,
				value: {node: completed},
			});
			await expect(store.call("nodes.get", {id: "a"})).resolves.toStrictEqual({
				ok: true,
				value: {node: completed},
			});
			vi.setSystemTime((NOW + 1) * 1000);
			await expect(store.call("nodes.uncomplete", {id: "a"})).resolves.toStrictEqual({
				ok: true,
				value: {node: dto("a", {parent_id: "p", modifiedAt: NOW + 1})},
			});
		});

		it("moves a node to another parent and answers both parents' children", async () => {
			const moved = dto("b", {parent_id: "q", modifiedAt: NOW});

			await expect(store.call("nodes.moveOne", {id: "b", parent_id: "q", index: 0})).resolves.toStrictEqual({
				ok: true,
				value: {nodes: [dto("a", {parent_id: "p"}), moved]},
			});
			await expect(store.call("nodes.get", {id: "b"})).resolves.toStrictEqual({ok: true, value: {node: moved}});
		});

		it("moves several blocks in one call", async () => {
			await expect(
				store.call("nodes.move", {
					moves: [
						{ids: ["b"], parent_id: "p", index: 0},
						{ids: ["a"], parent_id: "q"},
					],
				}),
			).resolves.toStrictEqual({
				ok: true,
				value: {
					nodes: [dto("b", {parent_id: "p", modifiedAt: NOW}), dto("a", {parent_id: "q", modifiedAt: NOW})],
				},
			});
		});
	});
});

describe("nodes subtree ids route", () => {
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
		const request = async (path: string) => {
			const res = await app.fetch(new Request(`http://x/api/v1/nodes${path}`));
			return {status: res.status, body: await res.json()};
		};
		/** Make `mirrorId` (a new child of `parentId`) a mirror of `originalId`. */
		const mirror = (mirrorId: string, parentId: string, originalId: string, ownCompletedAt?: number) => {
			cacheService.insertNode(apiNode(mirrorId, parentId, 9, ownCompletedAt), parentId);
			sqlite
				.prepare("INSERT INTO mirrors (mirror_id, original_id, system_from, system_to) VALUES (?, ?, ?, ?)")
				.run(mirrorId, originalId, "2000-01-01T00:00:00.000Z", FAR_FUTURE_DATE);
		};
		return {request, mirror};
	}

	describe("GET /api/v1/nodes/:id/subtree-ids", () => {
		it("lists every descendant of the node with its parent, completion and child flag", async () => {
			const {request} = setup();

			await expect(request("/Alpha/subtree-ids")).resolves.toStrictEqual({
				status: 200,
				body: {
					items: [
						{id: "A1", parentId: "Alpha", completed: false, hasChildren: true},
						{id: "A1a", parentId: "A1", completed: false, hasChildren: false},
						{id: "A2", parentId: "Alpha", completed: true, hasChildren: false},
					],
				},
			});
		});

		it("walks the whole Home tree for home, with null parents at the top", async () => {
			const {request} = setup();

			await expect(request("/home/subtree-ids")).resolves.toStrictEqual({
				status: 200,
				body: {
					items: [
						{id: "Alpha", parentId: null, completed: false, hasChildren: true},
						{id: "A1", parentId: "Alpha", completed: false, hasChildren: true},
						{id: "A1a", parentId: "A1", completed: false, hasChildren: false},
						{id: "A2", parentId: "Alpha", completed: true, hasChildren: false},
						{id: "Beta", parentId: null, completed: false, hasChildren: true},
						{id: "B1", parentId: "Beta", completed: false, hasChildren: false},
					],
				},
			});
		});

		it("lists a mirror's original children under the mirror", async () => {
			const {request, mirror} = setup();
			mirror("MA1", "Beta", "A1");

			await expect(request("/Beta/subtree-ids")).resolves.toStrictEqual({
				status: 200,
				body: {
					items: [
						{id: "B1", parentId: "Beta", completed: false, hasChildren: false},
						{id: "MA1", parentId: "Beta", completed: false, hasChildren: true},
						{id: "A1a", parentId: "MA1", completed: false, hasChildren: false},
					],
				},
			});
		});

		it("reports a mirror as completed exactly when its original is", async () => {
			const {request, mirror} = setup();
			mirror("MA2", "Beta", "A2");
			mirror("MA1", "Beta", "A1", 400);

			const {body} = await request("/Beta/subtree-ids");

			const completion = new Map(
				(body as {items: {id: string; completed: boolean}[]}).items.map((item) => [item.id, item.completed]),
			);

			expect({MA1: completion.get("MA1"), MA2: completion.get("MA2")}).toStrictEqual({MA1: false, MA2: true});
		});

		it("does not descend into a mirror of its own ancestor", async () => {
			const {request, mirror} = setup();
			mirror("MAlpha", "A1", "Alpha");

			await expect(request("/Alpha/subtree-ids")).resolves.toStrictEqual({
				status: 200,
				body: {
					items: [
						{id: "A1", parentId: "Alpha", completed: false, hasChildren: true},
						{id: "A1a", parentId: "A1", completed: false, hasChildren: false},
						{id: "MAlpha", parentId: "A1", completed: false, hasChildren: true},
						{id: "A2", parentId: "Alpha", completed: true, hasChildren: false},
					],
				},
			});
		});

		it("answers 404 for an unknown node", async () => {
			const {request} = setup();

			await expect(request("/nope/subtree-ids")).resolves.toStrictEqual({
				status: 404,
				body: {error: "Node not found"},
			});
		});
	});
});

describe("nodes tree read statement count", () => {
	const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");

	function apiNode(id: string, parentId: string | null, priority: number): WorkflowyNode {
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
	function setup(parents: number) {
		const sqlite = new DatabaseConstructor(":memory:");
		let statements = 0;
		const db = drizzle(sqlite, {
			schema,
			logger: {
				logQuery() {
					statements += 1;
				},
			},
		});
		migrate(db, {migrationsFolder});
		const cacheService = new CacheService(db);
		cacheService.insertNode(apiNode("Original", null, 0), null);
		for (let p = 0; p < parents; p++) {
			cacheService.insertNode(apiNode(`P${p}`, null, p + 1), null);
			for (let k = 0; k < 2; k++) {
				cacheService.insertNode(apiNode(`P${p}c${k}`, `P${p}`, k), `P${p}`);
			}
			cacheService.insertNode(apiNode(`P${p}m`, `P${p}`, 9), `P${p}`);
			sqlite
				.prepare("INSERT INTO mirrors (mirror_id, original_id, system_from, system_to) VALUES (?, ?, ?, ?)")
				.run(`P${p}m`, "Original", "2000-01-01T00:00:00.000Z", FAR_FUTURE_DATE);
		}
		const ctx = {db, cacheService} as unknown as ServerContext;
		const app = new Hono<AppEnv>();
		app.use("*", async (c, next) => {
			c.set("ctx", ctx);
			await next();
		});
		app.route("/", httpAppFor(ctx));
		const post = async (path: string, body: unknown) => {
			const before = statements;
			const res = await app.fetch(
				new Request(`http://x/api/v1/nodes${path}`, {
					method: "POST",
					headers: {"Content-Type": "application/json"},
					body: JSON.stringify(body),
				}),
			);
			await res.json();
			if (process.env.PRINT_COUNTS) {
				console.log(`COUNT ${path} ${parents} parents: ${statements - before}`);
			}
			return {status: res.status, statements: statements - before};
		};
		return {post};
	}

	const parentIds = (n: number) => Array.from({length: n}, (_, p) => `P${p}`);

	describe("tree reads keep their SQL statement count independent of the parent count", () => {
		it("POST /children", async () => {
			const few = await setup(2).post("/children", {parentIds: parentIds(2)});
			const many = await setup(12).post("/children", {parentIds: parentIds(12)});

			expect({few: few.status, many: many.status, same: many.statements === few.statements}).toStrictEqual({
				few: 200,
				many: 200,
				same: true,
			});
			expect(many.statements).toBeLessThanOrEqual(20);
		});

		it("POST /view over expanded rows", async () => {
			const view = (n: number) => ({rootId: null, expandedIds: parentIds(n), limit: 1000, showCompleted: true});
			const few = await setup(2).post("/view", view(2));
			const many = await setup(12).post("/view", view(12));

			expect({few: few.status, many: many.status, same: many.statements === few.statements}).toStrictEqual({
				few: 200,
				many: 200,
				same: true,
			});
			expect(many.statements).toBeLessThanOrEqual(40);
		});
	});
});

describe("nodes view route", () => {
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

	/** Home holds Alpha>{A1>{A1a}, A2 (completed)>{A2a}} and Beta>{B1}. */
	/** `accountExpanded`: the account's expanded ids the internal API holds; undefined leaves it unconfigured. */
	function setup(accountExpanded?: readonly string[]) {
		const sqlite = new DatabaseConstructor(":memory:");
		const db = drizzle(sqlite, {schema});
		migrate(db, {migrationsFolder});
		const cacheService = new CacheService(db);
		cacheService.insertNode(apiNode("Alpha", null, 0), null);
		cacheService.insertNode(apiNode("Beta", null, 1), null);
		cacheService.insertNode(apiNode("A1", "Alpha", 0), "Alpha");
		cacheService.insertNode(apiNode("A2", "Alpha", 1, 300), "Alpha");
		cacheService.insertNode(apiNode("A1a", "A1", 0), "A1");
		cacheService.insertNode(apiNode("A2a", "A2", 0), "A2");
		cacheService.insertNode(apiNode("B1", "Beta", 0), "Beta");
		// The account's expansion lives in `expanded_nodes` under upstream's keys, which the internal API tests ids against.
		for (const key of new Set(accountExpanded?.map(upstreamExpansionKey))) {
			sqlite
				.prepare("INSERT INTO expanded_nodes (short_key, system_from, system_to) VALUES (?, ?, ?)")
				.run(key, "2000-01-01T00:00:00.000Z", FAR_FUTURE_DATE);
		}
		const adapter =
			accountExpanded === undefined
				? undefined
				: {
						expansionTest: () => (id: string) =>
							accountExpanded.map(upstreamExpansionKey).includes(upstreamExpansionKey(id)),
					};
		const ctx = {db, cacheService, internalAdapter: () => adapter} as unknown as ServerContext;
		const app = new Hono<AppEnv>();
		app.use("*", async (c, next) => {
			c.set("ctx", ctx);
			await next();
		});
		app.route("/", httpAppFor(ctx));
		const post = async (body: unknown) => {
			const res = await app.fetch(
				new Request("http://x/api/v1/nodes/view", {
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
		/** Add `id` under `parentId`; without metadata its priority and creation time read as 0. */
		const add = (
			id: string,
			parentId: string,
			priority: number,
			{completedAt, metadata = true} = {} as {completedAt?: number; metadata?: boolean},
		) => {
			cacheService.insertNode(apiNode(id, parentId, priority, completedAt), parentId);
			if (!metadata) {
				sqlite.prepare("DELETE FROM node_metadata WHERE node_id = ?").run(id);
			}
		};
		/** Make `id` (a new child of `targetId`) `targetId`'s references root. */
		const referencesRoot = (id: string, targetId: string) => {
			cacheService.insertNode(apiNode(id, targetId, 99), targetId);
			sqlite
				.prepare("INSERT INTO references_roots (node_id, system_from, system_to) VALUES (?, ?, ?)")
				.run(id, "2000-01-01T00:00:00.000Z", FAR_FUTURE_DATE);
		};
		return {post, mirror, add, referencesRoot};
	}

	interface ListBody {
		parentId: string | null;
		nodes: {id: string}[];
		backlinks: unknown;
	}

	/** Each list as [parentId, child ids, backlinks]. */
	function lists(body: {lists: ListBody[]}): [string | null, string[], unknown][] {
		return body.lists.map((list) => [list.parentId, list.nodes.map((node) => node.id), list.backlinks]);
	}

	const NO_BACKLINKS = {rootId: null, items: []};

	/**
	 * A Backlinks section item as the view sends it: the item row (named after its source, priority 9 from `mirror`)
	 * carrying its source's text, completion and child flags. A crumb given as a string is a node named after its id.
	 */
	function backlinkItem(
		id: string,
		rootId: string,
		sourceId: string,
		{
			completedAt = null,
			children = false,
			crumbs,
		}: {completedAt?: number | null; children?: boolean; crumbs: (string | {id: string; name: string})[]},
	) {
		return {
			node: {
				id,
				parent_id: rootId,
				name: sourceId,
				note: null,
				priority: 9,
				data: {layoutMode: null},
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
			crumbs: crumbs.map((crumb) => (typeof crumb === "string" ? {id: crumb, name: crumb} : crumb)),
		};
	}

	describe("POST /api/v1/nodes/view", () => {
		it("lists the root's and every expanded rendered row's children depth-first, with their Backlinks", async () => {
			const {post} = setup();

			const {status, body} = await post({
				rootId: null,
				expandedIds: ["Alpha", "A1", "A2", "Beta"],
				limit: 100,
				showCompleted: false,
			});

			expect({status, lists: lists(body)}).toStrictEqual({
				status: 200,
				lists: [
					[null, ["Alpha", "Beta"], null],
					["Alpha", ["A1", "A2"], NO_BACKLINKS],
					["A1", ["A1a"], NO_BACKLINKS],
					["Beta", ["B1"], NO_BACKLINKS],
				],
			});
		});

		it("descends into a completed expanded row when completed rows show", async () => {
			const {post} = setup();

			const {body} = await post({rootId: "Alpha", expandedIds: ["A2"], limit: 100, showCompleted: true});

			expect(lists(body)).toStrictEqual([
				["Alpha", ["A1", "A2"], NO_BACKLINKS],
				["A2", ["A2a"], NO_BACKLINKS],
			]);
		});

		it("stops descending once the row budget is spent", async () => {
			const {post} = setup();

			const {body} = await post({
				rootId: null,
				expandedIds: ["Alpha", "A1", "Beta"],
				limit: 3,
				showCompleted: false,
			});

			expect(lists(body)).toStrictEqual([
				[null, ["Alpha", "Beta"], null],
				["Alpha", ["A1", "A2"], NO_BACKLINKS],
				["A1", ["A1a"], NO_BACKLINKS],
			]);
		});

		it("lists an expanded mirror's original's children under the mirror's id", async () => {
			const {post, mirror} = setup();
			mirror("M", "Beta", "Alpha");

			const {body} = await post({rootId: "Beta", expandedIds: ["M"], limit: 100, showCompleted: false});

			expect(lists(body)).toStrictEqual([
				["Beta", ["B1", "M"], NO_BACKLINKS],
				["M", ["A1", "A2"], NO_BACKLINKS],
			]);
		});

		it("sends each list once and stops at a mirror inside its own original", async () => {
			const {post, mirror} = setup();
			mirror("Mmmm", "A1", "Alpha");

			const {body} = await post({
				rootId: null,
				expandedIds: ["Alpha", "A1", "Mmmm"],
				limit: 200,
				showCompleted: false,
			});

			expect(lists(body)).toStrictEqual([
				[null, ["Alpha", "Beta"], null],
				["Alpha", ["A1", "A2"], NO_BACKLINKS],
				["A1", ["A1a", "Mmmm"], NO_BACKLINKS],
				["Mmmm", ["A1", "A2"], NO_BACKLINKS],
			]);
		});

		it("orders siblings by priority then creation time and spends the budget in that order", async () => {
			const {post, add} = setup();
			add("Neg", "Beta", -5);
			add("Huge", "Beta", 2 ** 40);
			add("H1", "Huge", 0);
			add("NoMeta", "Beta", 3, {metadata: false});

			const {body} = await post({rootId: "Beta", expandedIds: ["Huge", "B1"], limit: 3, showCompleted: false});

			expect(lists(body)).toStrictEqual([
				["Beta", ["Neg", "NoMeta", "B1", "Huge"], NO_BACKLINKS],
				["B1", [], NO_BACKLINKS],
			]);
		});

		it("neither counts nor expands a hidden completed row", async () => {
			const {post, add} = setup();
			add("A0", "Alpha", -1, {completedAt: 300});
			add("A0a", "A0", 0);

			const {body} = await post({rootId: "Alpha", expandedIds: ["A0", "A1"], limit: 1, showCompleted: false});

			expect(lists(body)).toStrictEqual([
				["Alpha", ["A0", "A1", "A2"], NO_BACKLINKS],
				["A1", ["A1a"], NO_BACKLINKS],
			]);
		});

		it("expands a row inside a mirror by its instance key, not its own id", async () => {
			const {post, mirror} = setup();
			mirror("M", "Beta", "Alpha");

			const [instance, plain] = await Promise.all([
				post({rootId: "Beta", expandedIds: ["M", "virtual_A1_M_M"], limit: 100, showCompleted: false}),
				post({rootId: "Beta", expandedIds: ["M", "A1"], limit: 100, showCompleted: false}),
			]);

			expect({instance: lists(instance.body), plain: lists(plain.body)}).toStrictEqual({
				instance: [
					["Beta", ["B1", "M"], NO_BACKLINKS],
					["M", ["A1", "A2"], NO_BACKLINKS],
					["A1", ["A1a"], NO_BACKLINKS],
				],
				plain: [
					["Beta", ["B1", "M"], NO_BACKLINKS],
					["M", ["A1", "A2"], NO_BACKLINKS],
				],
			});
		});

		it("expands the account's expanded rows for null expandedIds, returning those the view reached", async () => {
			const {post} = setup(["Alpha", "A1", "A2", "Beta", "Elsewhere"]);

			const {body} = await post({rootId: null, expandedIds: null, limit: 100, showCompleted: false});

			expect({lists: lists(body), expandedIds: body.expandedIds}).toStrictEqual({
				lists: [
					[null, ["Alpha", "Beta"], null],
					["Alpha", ["A1", "A2"], NO_BACKLINKS],
					["A1", ["A1a"], NO_BACKLINKS],
					["Beta", ["B1"], NO_BACKLINKS],
				],
				expandedIds: ["Alpha", "Beta", "A1", "A2"],
			});
		});

		it("expands nothing for null expandedIds without the internal API", async () => {
			const {post} = setup();

			const {body} = await post({rootId: null, expandedIds: null, limit: 100, showCompleted: false});

			expect({lists: lists(body), expandedIds: body.expandedIds}).toStrictEqual({
				lists: [[null, ["Alpha", "Beta"], null]],
				expandedIds: [],
			});
		});

		it("sends each listed parent's whole Backlinks section", async () => {
			const {post, mirror, add, referencesRoot} = setup();
			add("D1", "B1", 0);
			add("D2", "D1", 0);
			add("D3", "D2", 0);
			add("Cmp", "Beta", 5, {completedAt: 300});
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

			const {body} = await post({
				rootId: null,
				expandedIds: ["Alpha", "A1", "Beta", "B1", "M"],
				limit: 100,
				showCompleted: true,
			});

			const alpha = {
				rootId: "RA",
				items: [
					backlinkItem("IA1", "RA", "D3", {crumbs: ["Beta", "B1", "D1", "D2"]}),
					backlinkItem("IA2", "RA", "Cmp", {completedAt: 300, crumbs: ["Beta"]}),
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
							backlinkItem("IX", "RA1", "Nested", {
								crumbs: ["Beta", {id: "RB", name: "1 Backlink"}],
							}),
						],
					},
				],
				[
					"Beta",
					{
						rootId: "RB",
						items: [backlinkItem("IB", "RB", "D2", {children: true, crumbs: ["Beta", "B1", "D1"]})],
					},
				],
				["B1", {rootId: "RB1", items: []}],
				["M", alpha],
			]);
		});

		it("answers 404 for an unresolvable short root id and 400 for a malformed body", async () => {
			const {post} = setup();

			await expect(
				Promise.all([
					post({rootId: "0123456789ab", expandedIds: [], limit: 10, showCompleted: false}),
					post({rootId: null, expandedIds: "Alpha", limit: 10, showCompleted: false}),
				]),
			).resolves.toStrictEqual([
				{status: 404, body: {error: "Node not found"}},
				{status: 400, body: {error: "body must be {rootId, expandedIds, limit, showCompleted}"}},
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
	function wideSetup(width: number, depth: number, {backlinks = false, sourceDepth = 2} = {}) {
		const sqlite = new DatabaseConstructor(":memory:");
		const db = drizzle(sqlite, {schema});
		migrate(db, {migrationsFolder});
		const cacheService = new CacheService(db);
		cacheService.insertNode(apiNode("Root", null, 0), null);
		cacheService.insertNode(apiNode("Sources", null, 1), null);
		cacheService.insertNode(apiNode("Group", "Sources", 0), "Sources");
		// Every source sits `sourceDepth` levels under Home: Sources > Group > Group-2 > ...
		let sourceParent = "Group";
		for (let level = 2; level < sourceDepth; level += 1) {
			cacheService.insertNode(apiNode(`Group-${level}`, sourceParent, 0), sourceParent);
			sourceParent = `Group-${level}`;
		}
		const live = ["2000-01-01T00:00:00.000Z", FAR_FUTURE_DATE];
		/** Give `target` a references root holding a backlink item from a new source row. */
		const backlinkTo = (target: string) => {
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
		for (let index = 0; index < width; index += 1) {
			let parentId = "Root";
			for (let level = 0; level < depth; level += 1) {
				const id = `P${String(index).padStart(3, "0")}-${level}`;
				cacheService.insertNode(apiNode(id, parentId, level === 0 ? index : 0), parentId);
				expandedIds.push(id);
				if (backlinks) {
					backlinkTo(id);
				}
				parentId = id;
			}
		}
		let statements = 0;
		const prepare = sqlite.prepare.bind(sqlite);
		sqlite.prepare = (source: string) => {
			statements += 1;
			const parameters = source.match(/\?/gu)?.length ?? 0;
			if (parameters > DURABLE_OBJECT_PARAMETER_CAP) {
				throw new Error(`too many SQL variables: ${parameters}`);
			}
			return prepare(source);
		};
		const ctx = {db, cacheService, internalAdapter: () => {}} as unknown as ServerContext;
		const app = new Hono<AppEnv>();
		app.use("*", async (c, next) => {
			c.set("ctx", ctx);
			await next();
		});
		app.route("/", httpAppFor(ctx));
		const view = async () => {
			statements = 0;
			const res = await app.fetch(
				new Request("http://x/api/v1/nodes/view", {
					method: "POST",
					headers: {"Content-Type": "application/json"},
					body: JSON.stringify({rootId: "Root", expandedIds, limit: 100_000, showCompleted: false}),
				}),
			);
			// A failed view answers {error} without lists.
			const {lists: viewLists = []} = (await res.json()) as {lists?: ListBody[]};
			return {status: res.status, lists: viewLists, listCount: viewLists.length, statements};
		};
		return {view};
	}

	describe("POST /api/v1/nodes/view deep fetch", () => {
		it("reads a level of more expanded parents than a Durable Object statement may bind", async () => {
			const {view} = wideSetup(150, 2);

			const {status, listCount} = await view();

			expect({status, listCount}).toStrictEqual({status: 200, listCount: 1 + 150 * 2});
		});

		it("reads the whole tree in one statement however wide or deep the view", async () => {
			const narrow = await wideSetup(3, 2).view();
			const wide = await wideSetup(150, 2).view();
			const deep = await wideSetup(20, 6).view();

			expect({narrow: narrow.statements, wide: wide.statements, deep: deep.statements}).toStrictEqual({
				narrow: 1,
				wide: 1,
				deep: 1,
			});
		});

		it("reads every expanded row's Backlinks section in one more statement however many rows have one or how deep their sources sit", async () => {
			const narrow = await wideSetup(3, 2, {backlinks: true}).view();
			const wide = await wideSetup(150, 2, {backlinks: true}).view();
			const deepSources = await wideSetup(3, 2, {backlinks: true, sourceDepth: 8}).view();

			expect({
				statements: [narrow.statements, wide.statements, deepSources.statements],
				last: wide.lists.at(-1),
			}).toStrictEqual({
				statements: [2, 2, 2],
				last: {
					parentId: "P149-1",
					nodes: [],
					backlinks: {
						rootId: "R-P149-1",
						items: [
							{
								node: expect.objectContaining({
									id: "I-P149-1",
									isMirror: true,
									originalNodeId: "S-P149-1",
								}),
								sourceId: "S-P149-1",
								crumbs: [
									{id: "Sources", name: "Sources"},
									{id: "Group", name: "Group"},
								],
							},
						],
					},
				},
			});
		});
	});
});

describe("nodes virtual id route", () => {
	const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");
	const CHILD = "7b1c2d3e-aaaa-4bbb-8ccc-c910f3eac9b3";
	const MIRROR = "0e9f8d7c-1111-4222-8333-d4f14a54f384";

	describe("GET /api/v1/nodes/:id with a virtual location id", () => {
		it("resolves v_<child12>_<mirror12> to the original child it shows", async () => {
			const sqlite = new DatabaseConstructor(":memory:");
			const db = drizzle(sqlite, {schema});
			migrate(db, {migrationsFolder});
			const cacheService = new CacheService(db);
			cacheService.insertNode(
				{id: CHILD, name: "child", note: null, parent_id: null, priority: 0, createdAt: 1, modifiedAt: 2},
				null,
			);
			const ctx = {db, cacheService} as unknown as ServerContext;
			const app = new Hono<AppEnv>();
			app.use("*", async (c, next) => {
				c.set("ctx", ctx);
				await next();
			});
			app.route("/", httpAppFor(ctx));

			const res = await app.fetch(new Request(`http://x/api/v1/nodes/v_c910f3eac9b3_${MIRROR.slice(-12)}_0e9f`));

			expect({status: res.status, id: ((await res.json()) as {node: {id: string}}).node.id}).toStrictEqual({
				status: 200,
				id: CHILD,
			});
		});
	});

	describe("GET /api/v1/nodes/:id/ancestors with a virtual location id", () => {
		it("lists the mirror's ancestors and the mirror, then the rows below its original down to the row", async () => {
			const sqlite = new DatabaseConstructor(":memory:");
			const db = drizzle(sqlite, {schema});
			migrate(db, {migrationsFolder});
			const cacheService = new CacheService(db);
			const ORIGINAL = "aaaa1111-0000-4000-8000-a0a0a0a0a0a0";
			const MIDDLE = "5d5d5d5d-aaaa-4bbb-8ccc-0123456789ab";
			const PARENT = "99990000-1111-4222-8333-444455556666";
			const node = (id: string, parentId: string | null) => ({
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
			const ctx = {db, cacheService} as unknown as ServerContext;
			const app = new Hono<AppEnv>();
			app.use("*", async (c, next) => {
				c.set("ctx", ctx);
				await next();
			});
			app.route("/", httpAppFor(ctx));
			const ids = async (id: string) => {
				const res = await app.fetch(new Request(`http://x/api/v1/nodes/${id}/ancestors`));
				return ((await res.json()) as {ancestors: {id: string}[]}).ancestors.map((ancestor) => ancestor.id);
			};

			expect({
				instance: await ids(`v_c910f3eac9b3_${MIRROR.slice(-12)}_0e9f5d5d`),
				plain: await ids(CHILD),
			}).toStrictEqual({
				instance: [PARENT, MIRROR, MIDDLE, CHILD],
				plain: [ORIGINAL, MIDDLE, CHILD],
			});
		});
	});
});
