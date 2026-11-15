import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {Hono} from "hono";
import {join} from "node:path";
import {CacheService, readPendingOutbox} from "@outlinedb/shared/cache";
import * as schema from "@outlinedb/shared/db";
import type {WorkflowyInternalAdapter} from "@outlinedb/shared/internal";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import type {WorkflowyNode} from "@outlinedb/shared/types";
import type {AppEnv, ServerContext} from "../src/server/context.js";
import {httpAppFor} from "./http-app-for.js";

const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");

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

/**
 * Home holds P, O and X. O (completed, note "n") holds C (which holds G) and D, an original that has a mirror
 * under X, and E, a mirror of X. P holds A, M (mirror of O), B.
 */
function setup(expanded: string[] = [])
{
	vi.useFakeTimers(
		{
			toFake: ["Date"],
		},
	);
	vi.setSystemTime(1_600_000_000_000);
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
	cacheService.insertNode(
		apiNode(
			"C",
			"O",
			0,
			{
				data:
				{
					layoutMode: "board",
				},
			},
		),
		"O",
	);
	cacheService.insertNode(
		apiNode(
			"G",
			"C",
			0,
			{
				completed: true,
				completedAt: 6,
			},
		),
		"C",
	);
	cacheService.insertNode(apiNode("D", "O", 1), "O");
	cacheService.insertNode(apiNode("E", "O", 2), "O");
	cacheService.insertNode(apiNode("A", "P", 0), "P");
	cacheService.insertNode(apiNode("M", "P", 1), "P");
	cacheService.insertNode(apiNode("B", "P", 2), "P");
	cacheService.insertNode(apiNode("DM", "X", 0), "X");
	const link = sqlite.prepare(
		"INSERT INTO mirrors (mirror_id, original_id, system_from, system_to) VALUES (?, ?, ?, ?)",
	);
	link.run("M", "O", "2000-01-01T00:00:00.000Z", FAR_FUTURE_DATE);
	link.run("DM", "D", "2000-01-01T00:00:00.000Z", FAR_FUTURE_DATE);
	link.run("E", "X", "2000-01-01T00:00:00.000Z", FAR_FUTURE_DATE);
	// Writes start later than the seed: a unit of work may not overwrite a version from its own millisecond.
	vi.setSystemTime(1_700_000_000_000);
	let counter = 0;
	vi.spyOn(crypto, "randomUUID").mockImplementation(() =>
	{
		counter += 1;
		return `copy${counter}` as ReturnType<typeof crypto.randomUUID>;
	});
	// workflowy.com is down: every upstream tree write fails, while expansion (account state) still answers.
	const createTreesAt = vi.fn<WorkflowyInternalAdapter["createTreesAt"]>(async () =>
		Promise.reject(new Error("workflowy.com is unreachable")),
	);
	const setExpanded = vi.fn<WorkflowyInternalAdapter["setExpanded"]>(async () => Promise.resolve());
	const expansionTest = vi.fn<WorkflowyInternalAdapter["expansionTest"]>(() => (id: string) => expanded.includes(id));
	const ctx =
	{
		db,
		cacheService,
		apiKey: "test-key",
		config: {} as ServerContext["config"],
		internalAuth: {},
		outboxWritten: () =>
		{
			// The drain is the host's; these tests read the pending rows it would deliver.
		},
		internalAdapter: () =>
			(
			{
				createTreesAt,
				setExpanded,
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
	const post = async (path: string) =>
		app.fetch(
			new Request(
				`http://x/api/v1/nodes${path}`,
				{
					method: "POST",
				},
			),
		);
	/** The subtree under `id` as nested `[label, children]` (a mirror labelled with its original), a leaf left bare. */
	const outline = (id: string | null): unknown[] =>
		cacheService.getChildren(id).map((node) =>
		{
			const original = cacheService.getMirrorOriginal(node.id);
			const label = original === null ? `${node.id} ${node.name ?? ""}` : `${node.id} mirror of ${original}`;
			const children = outline(node.id);
			return children.length === 0 ? label : [label, children];
		});
	const pending = () => readPendingOutbox(db, 100).map(({nodeId, aspect}) => `${nodeId} ${aspect}`);
	return {
		createTreesAt,
		setExpanded,
		cacheService,
		post,
		outline,
		pending,
	};
}

afterEach(() =>
{
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("POST /api/v1/nodes/:id/detach-mirror", () =>
{
	it("copies a mirror locally as an open item at its slot: descendant mirrors and originals-with-mirrors stay mirrors, then removes the mirror", async () =>
	{
		const {createTreesAt, post, outline, pending} = setup();

		const res = await post("/M/detach-mirror");

		const {node} = (await res.json()) as
		{
			node:
			{
				id: string;
				parent_id: string | null;
				isMirror: boolean;
				completedAt: number | null;
			};
		};

		expect(
			{
				status: res.status,
				node:
				{
					id: node.id,
					parentId: node.parent_id,
					isMirror: node.isMirror,
					completedAt: node.completedAt,
				},
				outline: outline("P"),
				pending: pending(),
				upstream: createTreesAt.mock.calls.length,
			},
		).toStrictEqual(
			{
				status: 201,
				node:
				{
					id: "copy1",
					parentId: "P",
					isMirror: false,
					completedAt: null,
				},
				outline: [
					"A a",
					["copy1 o", [["copy2 c", ["copy3 g"]], "copy4 mirror of D", "copy5 mirror of X"]],
					"B b",
				],
				// O stops listing M upstream; the copy's descendants ride in its create.
				pending: [
					"M delete",
					"O mirror",
					"copy1 create",
					"copy1 placement",
					"copy2 create",
					"copy3 create",
					"copy4 create",
					"copy4 mirror",
					"copy5 create",
					"copy5 mirror",
				],
				upstream: 0,
			},
		);
	});

	it("keeps an original's own completion when it detaches in place, and deletes it so its first mirror takes over", async () =>
	{
		const {cacheService, post, outline} = setup();

		const res = await post("/O/detach-mirror");

		// O took M's slot under P; its copy sits where O was.

		expect(
			{
				status: res.status,
				home: outline(null),
				copyCompleted: cacheService.getNode("copy1")?.completedAt !== null,
			},
		).toStrictEqual(
			{
				status: 201,
				home: [
					["P p", ["A a", ["O o", [["C c", ["G g"]], "D d", "E mirror of X"]], "B b"]],
					["copy1 o", [["copy2 c", ["copy3 g"]], "copy4 mirror of D", "copy5 mirror of X"]],
					["X x", ["DM mirror of D"]],
				],
				copyCompleted: true,
			},
		);
	});

	it("opens the copy like the detached row", async () =>
	{
		const {setExpanded, post} = setup(["M", "C"]);

		await post("/M/detach-mirror");

		expect(setExpanded.mock.calls).toStrictEqual([
			[
				{
					copy1: true,
					copy2: true,
				},
			],
		]);
	});

	it("refuses a subtree of more than 2000 items without writing", async () =>
	{
		const {createTreesAt, cacheService, post, pending} = setup();
		for (let i = 0; i < 2000; i += 1)
		{
			cacheService.insertNode(apiNode(`bulk${i}`, "G", i), "G");
		}

		const res = await post("/M/detach-mirror");

		expect(
			{
				status: res.status,
				body: await res.json(),
				created: createTreesAt.mock.calls.length,
				pending: pending(),
			},
		).toStrictEqual(
			{
				status: 400,
				body:
				{
					error: "Detaching mirror subtrees containing more than 2000 items is not supported.",
				},
				created: 0,
				pending: [],
			},
		);
	});

	it("refuses a plain node", async () =>
	{
		const {createTreesAt, post} = setup();

		const res = await post("/A/detach-mirror");

		expect(
			{
				status: res.status,
				calls: createTreesAt.mock.calls.length,
			},
		).toStrictEqual(
			{
				status: 400,
				calls: 0,
			},
		);
	});
});
