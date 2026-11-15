import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {Hono} from "hono";
import {join} from "node:path";
import * as schema from "@outlinedb/shared/db";
import type {WorkflowyInternalAdapter} from "@outlinedb/shared/internal";
import type {WorkflowyNode} from "@outlinedb/shared/types";
import type {AppEnv, ServerContext} from "../src/server/context.js";
import {httpAppFor} from "./http-app-for.js";

const
{
	CacheService,
	collectItemRelationships,
	emptyItemRelationships,
	provisionLocalAccount,
	readPendingOutbox,
	storeInternalMetadata,
} = await import("@outlinedb/shared/cache");

const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");
const NOT_CONFIGURED =
	"Workflowy internal API is not configured (set WORKFLOWY_USERNAME and WORKFLOWY_PASSWORD, or run './bin/run.js internal login')";
const WRITE_CLIENT_REQUIRED = "WORKFLOWY_API_KEY environment variable is required";
/** When a test's request writes: after the seed, so no write replaces a version from its own millisecond. */
const WRITE_MS = 1_700_000_000_000;

function apiNode(id: string, layoutMode?: string): WorkflowyNode
{
	return {
		id,
		name: id.toUpperCase(),
		note: null,
		parent_id: null,
		priority: 0,
		createdAt: 100,
		modifiedAt: 200,
		...(layoutMode === undefined
			? {}
			:
				{
					data:
					{
						layoutMode,
					},
				}),
	};
}

function dto(
	id: string,
	layoutMode: string | null,
	numberedStart: number | null,
	defaultToBottom = false,
	table: unknown = null,
)
{
	return {
		id,
		parent_id: null,
		name: id.toUpperCase(),
		note: null,
		priority: 0,
		data:
		{
			layoutMode,
		},
		numberedStart,
		createdAt: 100,
		modifiedAt: 200,
		completedAt: null,
		hasChildren: false,
		hasUncompletedChildren: false,
		hasMirrors: false,
		isMirror: false,
		originalNodeId: null,
		attachment: null,
		defaultToBottom,
		calendar: null,
		table,
	};
}

interface FakeAdapter
{
	setNodeMetaValues: ReturnType<typeof vi.fn<WorkflowyInternalAdapter["setNodeMetaValues"]>>;
	syncBacklinks: ReturnType<typeof vi.fn<WorkflowyInternalAdapter["syncBacklinks"]>>;
	getRootMeta: ReturnType<typeof vi.fn<WorkflowyInternalAdapter["getRootMeta"]>>;
}

/**
 * Home holds `n1`, seeded with `n1` overrides so a test never rewrites it before the request: a second
 * write of one row in the seed's millisecond is a SameMillisecondOverwriteError. The fake adapter writes
 * metadata changes to the cache as the real one does.
 */
function setup(
	configured: boolean,
	rootLayoutMode?: string,
	mode: "mirror" | "standalone" = "mirror",
	n1: Partial<WorkflowyNode> = {},
)
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
	if (mode === "standalone")
	{
		provisionLocalAccount(
			db,
			{
				userId: "user-a",
				email: "a@example.com",
				joinedAt: new Date(0),
			},
		);
	}
	const cacheService = new CacheService(db);
	cacheService.insertNode(
		{
			...apiNode("n1"),
			...n1,
		},
		null,
	);
	const writeMetadata = (id: string, metadata: Record<string, unknown>) =>
	{
		const layoutMode = cacheService.getNode(id)?.layoutMode;
		storeInternalMetadata(
			db,
			new Map([
				[
					id,
					layoutMode == null
						? metadata
						:
							{
								...metadata,
								layoutMode,
							},
				],
			]),
		);
	};
	const adapter: FakeAdapter =
	{
		setNodeMetaValues: vi.fn<WorkflowyInternalAdapter["setNodeMetaValues"]>(async (id, changes) =>
		{
			if (id !== "home")
			{
				const metadata: Record<string, unknown> = {};
				for (const {path, value} of changes)
				{
					if (path[0] === "layoutMode")
					{
						cacheService.insertNode(apiNode(id, typeof value === "string" ? value : undefined), null);
					}
					else if (value !== undefined)
					{
						metadata[path[0]] = value;
					}
				}
				writeMetadata(id, metadata);
			}
			return Promise.resolve();
		}),
		getRootMeta: vi.fn<WorkflowyInternalAdapter["getRootMeta"]>(async () => Promise.resolve(rootLayoutMode)),
		syncBacklinks: vi.fn<WorkflowyInternalAdapter["syncBacklinks"]>(async () =>
			Promise.resolve(
				{
					created: [],
					referencesRoots: [],
					deleted: [],
				},
			),
		),
	};
	const ctx =
	{
		db,
		cacheService,
		mode,
		apiKey: mode === "standalone" ? undefined : "test-key",
		config: {} as ServerContext["config"],
		internalAuth: configured ? {} : undefined,
		internalAdapter: () => (configured ? (adapter as unknown as WorkflowyInternalAdapter) : undefined),
	} as unknown as ServerContext;
	const app = new Hono<AppEnv>();
	app.use("*", async (c, next) =>
	{
		c.set("ctx", ctx);
		await next();
	});
	app.route("/", httpAppFor(ctx));
	const request = async (method: string, path: string, body?: unknown) =>
	{
		const res = await app.fetch(
			new Request(
				`http://x/api/v1${path}`,
				{
					method,
					headers:
					{
						"content-type": "application/json",
					},
					...(body === undefined
						? {}
						:
							{
								body: JSON.stringify(body),
							}),
				},
			),
		);
		return {
			status: res.status,
			body: res.status === 204 ? null : await res.json(),
		};
	};
	/** Every pending outbox row as `id:aspect`, sorted. */
	const pending = () =>
		readPendingOutbox(db, 1000)
			.map(({nodeId, aspect}) => `${nodeId}:${aspect}`)
			// oxlint-disable-next-line unicorn/no-array-sort -- the test tsconfig lib has no toSorted
			.sort();
	return {
		adapter,
		request,
		writeMetadata,
		cacheService,
		pending,
	};
}

/** Pin the clock before the seed; a test moves it to {@link WRITE_MS} before its request. */
function useWriteClock(): void
{
	beforeEach(() =>
	{
		vi.useFakeTimers(
			{
				toFake: ["Date"],
				now: WRITE_MS - 1000,
			},
		);
	});

	afterEach(() =>
	{
		vi.useRealTimers();
	});
}

/** The adapter's node-write members: a mirror-mode node write must call none of them. */
function nodeWriteCalls(adapter: FakeAdapter)
{
	return {
		setNodeMetaValues: adapter.setNodeMetaValues.mock.calls,
		syncBacklinks: adapter.syncBacklinks.mock.calls,
	};
}

const NO_UPSTREAM_CALLS =
{
	setNodeMetaValues: [],
	syncBacklinks: [],
};

describe("DELETE /api/v1/nodes/:id backlinks in mirror mode", () =>
{
	it("deletes the subtree and the backlink items of its sources locally, and records each delete for the drain", async () =>
	{
		const {adapter, request, cacheService, pending} = setup(
			true,
			undefined,
			"mirror",
			{
				name: "link removed",
			},
		);
		cacheService.insertNode(
			{
				...apiNode("c1"),
				parent_id: "n1",
				name: "plain",
			},
			"n1",
		);
		cacheService.insertNode(apiNode("target"), null);
		cacheService.insertNode(
			{
				...apiNode("refs"),
				parent_id: "target",
				name: "",
			},
			"target",
		);
		cacheService.insertNode(
			{
				...apiNode("item"),
				parent_id: "refs",
				name: "",
			},
			"refs",
		);
		const relationships = emptyItemRelationships();
		collectItemRelationships(
			relationships,
			"refs",
			{
				isReferencesRoot: true,
			},
		);
		collectItemRelationships(
			relationships,
			"item",
			{
				mirror:
				{
					originalId: "n1",
					isMirrorRoot: true,
				},
				backlink:
				{
					sourceID: "n1",
					targetID: "target",
				},
			},
		);
		cacheService.recordRelationships(relationships);

		const {status} = await request("DELETE", "/nodes/n1");

		expect(
			{
				status,
				live: ["n1", "c1", "item", "refs"].filter((id) => cacheService.getNode(id) !== undefined),
				pending: pending(),
				calls: nodeWriteCalls(adapter),
			},
		).toStrictEqual(
			{
				status: 204,
				// Upstream keeps a references root even when it empties.
				live: ["refs"],
				pending: ["c1:delete", "item:delete", "n1:delete"],
				calls: NO_UPSTREAM_CALLS,
			},
		);
	});
});

describe("PATCH /api/v1/nodes/home", () =>
{
	it("sets Home's layout to board through the root metadata", async () =>
	{
		const {adapter, request} = setup(true);

		const res = await request(
			"PATCH",
			"/nodes/home",
			{
				layoutMode: "board",
			},
		);

		expect(
			{
				res,
				calls: adapter.setNodeMetaValues.mock.calls,
			},
		).toStrictEqual(
			{
				res:
				{
					status: 200,
					body:
					{
						layoutMode: "board",
					},
				},
				calls: [
					[
						"home",
						[
							{
								path: ["layoutMode"],
								value: "board",
							},
						],
					],
				],
			},
		);
	});

	it("removes the layoutMode key for bullets", async () =>
	{
		const {adapter, request} = setup(true);

		const res = await request(
			"PATCH",
			"/nodes/home",
			{
				layoutMode: "bullets",
			},
		);

		expect(
			{
				res,
				calls: adapter.setNodeMetaValues.mock.calls,
			},
		).toStrictEqual(
			{
				res:
				{
					status: 200,
					body:
					{
						layoutMode: "bullets",
					},
				},
				calls: [
					[
						"home",
						[
							{
								path: ["layoutMode"],
								value: undefined,
							},
						],
					],
				],
			},
		);
	});

	it.each([
		[
			{
				layoutMode: "table",
			},
			"Home accepts only layoutMode",
		],
		[
			{
				layoutMode: "board",
				numberedStart: 2,
			},
			"Home accepts only layoutMode",
		],
		[
			{
				name: "x",
			},
			"Home accepts only layoutMode",
		],
		[{}, "Home accepts only layoutMode"],
	])("rejects %j", async (body, error) =>
	{
		const {adapter, request} = setup(true);

		const res = await request("PATCH", "/nodes/home", body);

		expect(
			{
				res,
				calls: adapter.setNodeMetaValues.mock.calls,
			},
		).toStrictEqual(
			{
				res:
				{
					status: 400,
					body:
					{
						error,
					},
				},
				calls: [],
			},
		);
	});

	it("answers 503 without the internal API", async () =>
	{
		const {request} = setup(false);

		await expect(
			request(
				"PATCH",
				"/nodes/home",
				{
					layoutMode: "board",
				},
			),
		).resolves.toStrictEqual(
			{
				status: 503,
				body:
				{
					error: NOT_CONFIGURED,
				},
			},
		);
	});
});

describe("GET /api/v1/home", () =>
{
	it("returns Home's layoutMode", async () =>
	{
		const {request} = setup(true, "board");

		await expect(request("GET", "/home")).resolves.toStrictEqual(
			{
				status: 200,
				body:
				{
					layoutMode: "board",
				},
			},
		);
	});

	it("defaults to bullets when the root has no layoutMode", async () =>
	{
		const {request} = setup(true);

		await expect(request("GET", "/home")).resolves.toStrictEqual(
			{
				status: 200,
				body:
				{
					layoutMode: "bullets",
				},
			},
		);
	});

	it("answers 503 without the internal API", async () =>
	{
		const {request} = setup(false);

		await expect(request("GET", "/home")).resolves.toStrictEqual(
			{
				status: 503,
				body:
				{
					error: NOT_CONFIGURED,
				},
			},
		);
	});
});

describe("PATCH /api/v1/nodes/:id metadata in mirror mode", () =>
{
	useWriteClock();

	it("sets layoutMode and numberedStart locally and records the metadata for the drain", async () =>
	{
		const {adapter, request, pending} = setup(true);
		vi.setSystemTime(WRITE_MS);

		const res = await request(
			"PATCH",
			"/nodes/n1",
			{
				layoutMode: "numbered",
				numberedStart: 5,
			},
		);

		expect(
			{
				res,
				pending: pending(),
				calls: nodeWriteCalls(adapter),
			},
		).toStrictEqual(
			{
				res:
				{
					status: 200,
					body:
					{
						node:
						{
							...dto("n1", "numbered", 5),
							modifiedAt: WRITE_MS / 1000,
						},
						effects:
						{
							backlinkTargets: [],
							dates: false,
						},
					},
				},
				pending: ["n1:metadata"],
				calls: NO_UPSTREAM_CALLS,
			},
		);
	});

	it("removes numbered_start for a null numberedStart and the layoutMode key for bullets", async () =>
	{
		const {request, writeMetadata} = setup(
			true,
			undefined,
			"mirror",
			{
				data:
				{
					layoutMode: "numbered",
				},
			},
		);
		writeMetadata(
			"n1",
			{
				numbered_start: 5,
			},
		);
		vi.setSystemTime(WRITE_MS);

		const res = await request(
			"PATCH",
			"/nodes/n1",
			{
				layoutMode: "bullets",
				numberedStart: null,
			},
		);

		expect(res).toStrictEqual(
			{
				status: 200,
				body:
				{
					node:
					{
						...dto("n1", null, null),
						modifiedAt: WRITE_MS / 1000,
					},
					effects:
					{
						backlinkTargets: [],
						dates: false,
					},
				},
			},
		);
	});

	it("writes the name and the metadata in one local write", async () =>
	{
		const {adapter, request, pending} = setup(true);
		vi.setSystemTime(WRITE_MS);

		const res = await request(
			"POST",
			"/nodes/n1",
			{
				name: "Buy milk",
				numberedStart: 3,
			},
		);

		expect(
			{
				res,
				pending: pending(),
				calls: nodeWriteCalls(adapter),
			},
		).toStrictEqual(
			{
				res:
				{
					status: 200,
					body:
					{
						node:
						{
							...dto("n1", null, 3),
							name: "Buy milk",
							modifiedAt: WRITE_MS / 1000,
						},
						effects:
						{
							backlinkTargets: [],
							dates: false,
						},
					},
				},
				pending: ["n1:metadata", "n1:name"],
				calls: NO_UPSTREAM_CALLS,
			},
		);
	});

	it("reports no effects for a plain text edit", async () =>
	{
		const {request} = setup(true);
		vi.setSystemTime(WRITE_MS);

		const {body} = await request(
			"PATCH",
			"/nodes/n1",
			{
				name: "plain",
			},
		);

		expect(body).toStrictEqual(
			{
				node:
				{
					...dto("n1", null, null),
					name: "plain",
					modifiedAt: WRITE_MS / 1000,
				},
				effects:
				{
					backlinkTargets: [],
					dates: false,
				},
			},
		);
	});

	it("reports the targets of the links an edit adds or removes, plus the kept link whose missing backlink the local sync creates", async () =>
	{
		const kept = "11111111-2222-3333-4444-0123456789ab";
		const removed = "11111111-2222-3333-4444-aaaaaaaaaaaa";
		const added = "11111111-2222-3333-4444-bbbbbbbbbbbb";
		const link = (id: string) => `<a href="https://workflowy.com/#/${id.slice(-12)}">t</a>`;
		const {adapter, request, cacheService} = setup(
			true,
			undefined,
			"mirror",
			{
				name: `${link(kept)} ${link(removed)}`,
			},
		);
		for (const id of [kept, removed, added])
		{
			cacheService.insertNode(apiNode(id), null);
		}
		vi.setSystemTime(WRITE_MS);

		const {body} = await request(
			"PATCH",
			"/nodes/n1",
			{
				name: `${link(kept)} ${link(added)}`,
			},
		);

		expect(
			{
				effects: (
					body as
					{
						effects: unknown;
					}
				).effects,
				calls: nodeWriteCalls(adapter),
			},
		).toStrictEqual(
			{
				effects:
				{
					backlinkTargets: [removed, added, kept],
					dates: false,
				},
				calls: NO_UPSTREAM_CALLS,
			},
		);
	});

	it("reports a date change when an edit adds a <time>", async () =>
	{
		const {request} = setup(true);
		vi.setSystemTime(WRITE_MS);

		const {body} = await request(
			"PATCH",
			"/nodes/n1",
			{
				note: 'on <time startYear="2026" startMonth="10" startDay="22">Oct 22</time>',
			},
		);

		expect(
			(
				body as
				{
					effects: unknown;
				}
			).effects,
		).toStrictEqual(
			{
				backlinkTargets: [],
				dates: true,
			},
		);
	});

	it("rejects a numberedStart that is not an integer or null", async () =>
	{
		const {pending, request} = setup(true);

		const res = await request(
			"PATCH",
			"/nodes/n1",
			{
				numberedStart: "5",
			},
		);

		expect(
			{
				res,
				pending: pending(),
			},
		).toStrictEqual(
			{
				res:
				{
					status: 400,
					body:
					{
						error: "Invalid request body",
					},
				},
				pending: [],
			},
		);
	});

	it("answers 500 without the internal API to drain through", async () =>
	{
		const {request} = setup(false);

		await expect(
			request(
				"PATCH",
				"/nodes/n1",
				{
					layoutMode: "board",
				},
			),
		).resolves.toStrictEqual(
			{
				status: 500,
				body:
				{
					error: WRITE_CLIENT_REQUIRED,
				},
			},
		);
	});
});

describe("node DTO numberedStart", () =>
{
	it("comes from the cached internal metadata", async () =>
	{
		const {request, writeMetadata} = setup(false);
		writeMetadata(
			"n1",
			{
				numbered_start: 5,
			},
		);

		await expect(request("GET", "/nodes/n1")).resolves.toStrictEqual(
			{
				status: 200,
				body:
				{
					node: dto("n1", null, 5),
				},
			},
		);
	});

	it("is null without cached metadata", async () =>
	{
		const {request} = setup(false);

		await expect(request("GET", "/nodes?parent_id=None")).resolves.toStrictEqual(
			{
				status: 200,
				body:
				{
					nodes: [dto("n1", null, null)],
				},
			},
		);
	});
});

describe("node DTO defaultToBottom", () =>
{
	it("comes from the cached internal metadata's priority.defaultToBottom", async () =>
	{
		const {request, writeMetadata} = setup(false);
		writeMetadata(
			"n1",
			{
				priority:
				{
					defaultToBottom: true,
				},
			},
		);

		await expect(request("GET", "/nodes/n1")).resolves.toStrictEqual(
			{
				status: 200,
				body:
				{
					node: dto("n1", null, null, true),
				},
			},
		);
	});

	it("is false without cached metadata", async () =>
	{
		const {request} = setup(false);

		await expect(request("GET", "/nodes/n1")).resolves.toStrictEqual(
			{
				status: 200,
				body:
				{
					node: dto("n1", null, null),
				},
			},
		);
	});
});

describe("PATCH /api/v1/nodes/:id tableSet", () =>
{
	useWriteClock();

	it("writes table paths locally, records the metadata and returns them on the node", async () =>
	{
		const {adapter, pending, request} = setup(true);
		vi.setSystemTime(WRITE_MS);

		const res = await request(
			"PATCH",
			"/nodes/n1",
			{
				tableSet: [
					{
						path: ["table", "sizes", "c1"],
						value: 200,
					},
				],
			},
		);

		expect(
			{
				status: res.status,
				table: (
					res.body as
					{
						node:
						{
							table: unknown;
						};
					}
				).node.table,
				pending: pending(),
				calls: nodeWriteCalls(adapter),
			},
		).toStrictEqual(
			{
				status: 200,
				table:
				{
					sizes:
					{
						c1: 200,
					},
				},
				pending: ["n1:metadata"],
				calls: NO_UPSTREAM_CALLS,
			},
		);
	});

	it("rejects paths outside table", async () =>
	{
		const {adapter, request} = setup(true);

		const res = await request(
			"PATCH",
			"/nodes/n1",
			{
				tableSet: [
					{
						path: ["layoutMode"],
						value: "x",
					},
				],
			},
		);

		expect(
			{
				status: res.status,
				calls: adapter.setNodeMetaValues.mock.calls,
			},
		).toStrictEqual(
			{
				status: 400,
				calls: [],
			},
		);
	});

	it("GET returns the cached table metadata", async () =>
	{
		const {request, writeMetadata} = setup(true);
		writeMetadata(
			"n1",
			{
				table:
				{
					sizes:
					{
						c1: 200,
					},
				},
			},
		);

		const res = await request("GET", "/nodes/n1");

		expect(res.body).toStrictEqual(
			{
				node: dto(
					"n1",
					null,
					null,
					false,
					{
						sizes:
						{
							c1: 200,
						},
					},
				),
			},
		);
	});
});

describe("node metadata in a standalone context", () =>
{
	beforeEach(() =>
	{
		vi.useFakeTimers(
			{
				toFake: ["Date"],
				now: 1_699_999_999_000,
			},
		);
	});

	afterEach(() =>
	{
		vi.useRealTimers();
	});

	it("writes layoutMode, numberedStart and tableSet to the local tables with no adapter", async () =>
	{
		const {adapter, request} = setup(false, undefined, "standalone");
		// A write may not replace a version from its own millisecond.
		vi.setSystemTime(1_700_000_000_000);

		const res = await request(
			"PATCH",
			"/nodes/n1",
			{
				layoutMode: "numbered",
				numberedStart: 5,
				tableSet: [
					{
						path: ["table", "sizes", "c1"],
						value: 200,
					},
				],
			},
		);

		expect(
			{
				res,
				get: await request("GET", "/nodes/n1"),
				calls: adapter.setNodeMetaValues.mock.calls,
			},
		).toStrictEqual(
			{
				res:
				{
					status: 200,
					body:
					{
						node:
						{
							...dto(
								"n1",
								"numbered",
								5,
								false,
								{
									sizes:
									{
										c1: 200,
									},
								},
							),
							modifiedAt: 1_700_000_000,
						},
						effects:
						{
							backlinkTargets: [],
							dates: false,
						},
					},
				},
				get:
				{
					status: 200,
					body:
					{
						node:
						{
							...dto(
								"n1",
								"numbered",
								5,
								false,
								{
									sizes:
									{
										c1: 200,
									},
								},
							),
							modifiedAt: 1_700_000_000,
						},
					},
				},
				calls: [],
			},
		);
	});

	it("sets and reads Home's layout from the root preferences", async () =>
	{
		const {request} = setup(false, undefined, "standalone");

		const before = await request("GET", "/home");
		const set = await request(
			"PATCH",
			"/nodes/home",
			{
				layoutMode: "board",
			},
		);

		expect(
			{
				before,
				set,
				after: await request("GET", "/home"),
			},
		).toStrictEqual(
			{
				before:
				{
					status: 200,
					body:
					{
						layoutMode: "bullets",
					},
				},
				set:
				{
					status: 200,
					body:
					{
						layoutMode: "board",
					},
				},
				after:
				{
					status: 200,
					body:
					{
						layoutMode: "board",
					},
				},
			},
		);
	});
});
