import {QueryClient, QueryClientProvider, QueryObserver} from "@tanstack/react-query";
import type {QueryKey} from "@tanstack/react-query";
import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {Hono} from "hono";
import {join} from "node:path";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import type * as SharedApi from "@outlinedb/shared/api";
import type * as SharedCache from "@outlinedb/shared/cache";
import * as schema from "@outlinedb/shared/db";
import type {WorkflowyNode} from "@outlinedb/shared/types";
import type {NodeResponse} from "../src/node-types.js";
import type {AppEnv, ServerContext} from "../src/server/context.js";
import
{
	affectedKeys,
	diffEntries,
	fetchServerEntries,
	reportMismatches,
	snapshotEntries,
	verifiedKeys,
} from "../src/client/cache-verify.js";
import type {CacheMismatch, ComparableEntry} from "../src/client/cache-verify.js";
import {nodeKeys} from "../src/client/node-cache.js";
import {applyOps, whenUndoSettled} from "../src/client/undo-batch.js";
import {previewUndoOps} from "../src/client/undo-cache.js";
import {undoHistory} from "../src/client/undo-history.js";
import {fakeAdapter, resetFakeWorkflowy} from "./helpers/fake-workflowy.js";
import {httpAppFor} from "./http-app-for.js";

const outlineState =
{
	zoomedNodeId: null,
	editingId: null,
	editingCaretOffset: null,
	editingNoteId: null,
	itemSelection:
	{
		entries: [],
		pivotId: null,
		retractableIds: [],
		counter: 0,
	},
	addErrorNotification: () => "id",
	expand: (id: string) =>
	{
		onExpand(id);
	},
	startEditing()
	{
	},
	markCreatedForSearch()
	{
	},
};

vi.mock("../src/client/hooks/use-saving.js", () => (
{
	trackReplay: async <T>(promise: Promise<T>) => promise,
}));
vi.mock("../src/client/stores/outline.js", () => (
{
	useOutlineStore: Object.assign(
		(selector?: (state: typeof outlineState) => unknown) => (selector ? selector(outlineState) : outlineState),
		{
			getState: () => outlineState,
		},
	),
	activePaneView: () => (
	{
		expandedIds: new Set(),
		showCompleted: true,
		replaceExpanded()
		{
		},
	}),
}));

vi.mock("@outlinedb/shared/cache", async (importOriginal) =>
{
	const actual = await importOriginal<typeof SharedCache>();
	const {FakeWriteThroughClient} = await import("./helpers/fake-workflowy.js");
	return {
		...actual,
		WorkflowyWriteThroughClient: FakeWriteThroughClient,
	};
});

vi.mock("@outlinedb/shared/api", async (importOriginal) =>
{
	const actual = await importOriginal<typeof SharedApi>();
	const {FakeApiClient} = await import("./helpers/fake-workflowy.js");
	return {
		...actual,
		WorkflowyApiClient: FakeApiClient,
	};
});

const {CacheService} = await import("@outlinedb/shared/cache");
const
{
	fetchChildren,
	fetchNode,
	sendBlockMoves,
	undoAdapter,
	useCreateNode,
	useDeleteNode,
	useMoveNode,
	useMoveNodes,
	useToggleComplete,
	useUpdateNode,
} = await import("../src/client/hooks/use-nodes.js");

const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");

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
		...(completedAt === undefined
			? {}
			:
				{
					completed: true,
					completedAt,
				}),
	};
}

/**
 * The server's tree, behind the real nodes routes:
 *
 * - alpha: alpha1, alpha2
 * - bravo: bravo1 (its only child)
 * - charlie (a leaf)
 * - echo (a mirror of charlie)
 * - foxtrot: done1 (completed), open1
 */
function server(): Hono<AppEnv>
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
	for (const [index, id] of ["alpha", "bravo", "charlie", "echo", "foxtrot"].entries())
	{
		cacheService.insertNode(
			{
				...apiNode(id, null, index),
				...(id === "echo"
					?
						{
							name: "",
						}
					: {}),
			},
			null,
		);
	}
	cacheService.insertMirror("charlie", "echo");
	cacheService.insertNode(apiNode("alpha1", "alpha", 0), "alpha");
	cacheService.insertNode(apiNode("alpha2", "alpha", 1), "alpha");
	cacheService.insertNode(apiNode("bravo1", "bravo", 0), "bravo");
	cacheService.insertNode(apiNode("done1", "foxtrot", 0, 300), "foxtrot");
	cacheService.insertNode(apiNode("open1", "foxtrot", 1), "foxtrot");
	const adapter = fakeAdapter(cacheService);
	const ctx =
	{
		db,
		cacheService,
		apiKey: "test-key",
		config: {} as ServerContext["config"],
		internalAuth: {},
		internalAdapter: () => adapter,
	} as unknown as ServerContext;
	const app = new Hono<AppEnv>();
	app.use("*", async (c, next) =>
	{
		c.set("ctx", ctx);
		await next();
	});
	app.route("/", httpAppFor(ctx));
	return app;
}

/** Called as each write request reaches the server, after its mutation's `onMutate` wrote the cache. */
let onWrite: () => void;

/** Called as the outline store expands a row. */
let onExpand: (id: string) => void = () =>
{
};

/** Each write request the server received, as `METHOD url body`. */
let writes: string[] = [];

/** The POST routes that only read. */
const READS = new Set(["/api/v1/nodes/children", "/api/v1/nodes/verify"]);

function serve(app: Hono<AppEnv>): void
{
	vi.stubGlobal("fetch", async (url: string, init?: RequestInit) =>
	{
		const method = init?.method ?? "GET";
		if (method !== "GET" && !READS.has(url))
		{
			writes.push(`${method} ${url} ${typeof init?.body === "string" ? init.body : ""}`);
			onWrite();
		}
		return app.fetch(new Request(`http://x${url}`, init));
	});
}

function useHooks()
{
	return {
		create: useCreateNode(),
		update: useUpdateNode(),
		remove: useDeleteNode(),
		move: useMoveNode(),
		moveMany: useMoveNodes(),
		toggle: useToggleComplete(),
	};
}

type Hooks = ReturnType<typeof useHooks>;

function captureHooks(queryClient: QueryClient): Hooks
{
	const captured: Hooks[] = [];
	function Probe()
	{
		captured.push(useHooks());
		return null;
	}
	renderToStaticMarkup(
		createElement(
			QueryClientProvider,
			{
				client: queryClient,
			},
			createElement(Probe),
		),
	);
	const hooks = captured.at(0);
	if (hooks === undefined)
	{
		throw new Error("hooks not captured");
	}
	return hooks;
}

const SHOWN_LISTS: (string | null)[] = [null, "alpha", "bravo", "foxtrot"];
const SHOWN_DETAILS = ["alpha", "bravo", "bravo1", "charlie"];

/** A client showing the expanded outline: each list and detail an active query that refetches on invalidation. */
async function loadedClient(): Promise<QueryClient>
{
	const queryClient = new QueryClient(
		{
			defaultOptions:
			{
				mutations:
				{
					retry: false,
				},
				queries:
				{
					retry: false,
				},
			},
		},
	);
	const observers = [
		...SHOWN_LISTS.map(
			(parentId) =>
				new QueryObserver(
					queryClient,
					{
						queryKey: nodeKeys.children(parentId),
						queryFn: async () => fetchChildren(parentId),
					},
				),
		),
		...SHOWN_DETAILS.map(
			(nodeId) =>
				new QueryObserver(
					queryClient,
					{
						queryKey: nodeKeys.detail(nodeId),
						queryFn: async () => fetchNode(nodeId),
					},
				),
		),
	];
	for (const observer of observers)
	{
		observer.subscribe(() => {});
	}
	await settled(queryClient);
	return queryClient;
}

async function settled(queryClient: QueryClient): Promise<void>
{
	await vi.waitFor(() =>
	{
		expect(queryClient.isMutating() + queryClient.isFetching()).toBe(0);
	});
}

interface RoundTrip
{
	/** The cache right after `onMutate`, against the server once the write landed. */
	optimistic: CacheMismatch[];
	/** The cache once the mutation settled and its refetches landed, against the server. */
	settled: CacheMismatch[];
}

async function compareWithServer(
	keys: readonly QueryKey[],
	snapshot: Map<string, ComparableEntry>,
): Promise<CacheMismatch[]>
{
	return diffEntries(snapshot, await fetchServerEntries(keys));
}

async function settledMismatches(queryClient: QueryClient): Promise<CacheMismatch[]>
{
	await settled(queryClient);
	const keys = verifiedKeys(queryClient);
	return compareWithServer(keys, snapshotEntries(queryClient, keys));
}

/** Run one mutation, snapshotting every cached list and detail as its write request leaves. */
async function roundTrip(queryClient: QueryClient, run: () => void): Promise<RoundTrip>
{
	let keys: QueryKey[] = [];
	let snapshot: Map<string, ComparableEntry> | undefined;
	onWrite = () =>
	{
		if (snapshot === undefined)
		{
			keys = verifiedKeys(queryClient);
			snapshot = snapshotEntries(queryClient, keys);
		}
	};
	run();
	await settled(queryClient);
	onWrite = () =>
	{
	};
	if (snapshot === undefined)
	{
		throw new Error("the mutation sent no write");
	}
	return {
		optimistic: await compareWithServer(keys, snapshot),
		settled: await settledMismatches(queryClient),
	};
}

/** Undo the last step as the Undo command does: preview it in the cache, replay it, refetch. */
async function undoRoundTrip(queryClient: QueryClient): Promise<RoundTrip>
{
	await whenUndoSettled();
	const step = undoHistory.popUndo();
	if (step === undefined)
	{
		throw new Error("nothing to undo");
	}
	previewUndoOps(queryClient, step.ops);
	const keys = verifiedKeys(queryClient);
	const snapshot = snapshotEntries(queryClient, keys);
	await applyOps(step.ops, undoAdapter);
	await queryClient.invalidateQueries();
	return {
		optimistic: await compareWithServer(keys, snapshot),
		settled: await settledMismatches(queryClient),
	};
}

const NO_MISMATCH: RoundTrip =
{
	optimistic: [],
	settled: [],
};

/** A mutation and its undo, each round-tripped. */
async function withUndo(run: (hooks: Hooks) => void): Promise<
{
	forward: RoundTrip;
	undo: RoundTrip;
}>
{
	const queryClient = await loadedClient();
	const hooks = captureHooks(queryClient);
	const forward = await roundTrip(queryClient, () =>
	{
		run(hooks);
	});
	return {
		forward,
		undo: await undoRoundTrip(queryClient),
	};
}

const CLIENT_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

beforeEach(() =>
{
	undoHistory.clear();
	resetFakeWorkflowy();
	onWrite = () =>
	{
	};
	onExpand = () =>
	{
	};
	writes = [];
	serve(server());
});

afterEach(() =>
{
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("the optimistic cache matches the server's round trip", () =>
{
	it("creates a bullet between two siblings", async () =>
	{
		await expect(
			withUndo(({create}) =>
			{
				create.mutate(
					{
						id: CLIENT_ID,
						parent_id: "alpha",
						name: "",
						index: 1,
					},
				);
			}),
		).resolves.toStrictEqual(
			{
				forward: NO_MISMATCH,
				undo: NO_MISMATCH,
			},
		);
	});

	it("creates a bullet after the sibling the user saw when another client added a row the cache lacks", async () =>
	{
		const queryClient = await loadedClient();
		const hooks = captureHooks(queryClient);
		// Another client (the CLI, another tab) adds a first child the loaded cache never sees.
		await fetch(
			"/api/v1/nodes",
			{
				method: "POST",
				headers:
				{
					"Content-Type": "application/json",
				},
				body: JSON.stringify(
					{
						parent_id: "alpha",
						name: "outside",
						index: 0,
					},
				),
			},
		);
		const forward = await roundTrip(queryClient, () =>
		{
			hooks.create.mutate(
				{
					id: CLIENT_ID,
					parent_id: "alpha",
					name: "",
					index: 1,
				},
			);
		});
		expect(
			{
				forward,
				order: queryClient.getQueryData<NodeResponse[]>(nodeKeys.children("alpha"))?.map((row) => row.name),
			},
		).toStrictEqual(
			{
				forward: NO_MISMATCH,
				order: ["outside", "alpha1", "", "alpha2"],
			},
		);
	});

	it("creates the first child of a leaf that a mirror shows", async () =>
	{
		await expect(
			withUndo(({create}) =>
			{
				create.mutate(
					{
						id: CLIENT_ID,
						parent_id: "charlie",
						name: "first",
					},
				);
			}),
		).resolves.toStrictEqual(
			{
				forward: NO_MISMATCH,
				undo: NO_MISMATCH,
			},
		);
	});

	it("updates a node's text", async () =>
	{
		await expect(
			withUndo(({update}) =>
			{
				update.mutate(
					{
						nodeId: "alpha1",
						name: "renamed",
					},
				);
			}),
		).resolves.toStrictEqual(
			{
				forward: NO_MISMATCH,
				undo: NO_MISMATCH,
			},
		);
	});

	it("updates the text a mirror shows", async () =>
	{
		await expect(
			withUndo(({update}) =>
			{
				update.mutate(
					{
						nodeId: "charlie",
						name: "renamed",
						note: "a note",
					},
				);
			}),
		).resolves.toStrictEqual(
			{
				forward: NO_MISMATCH,
				undo: NO_MISMATCH,
			},
		);
	});

	it("indents a bullet under its previous sibling", async () =>
	{
		await expect(
			withUndo(({move}) =>
			{
				move.mutate(
					{
						nodeId: "bravo",
						parent_id: "alpha",
					},
				);
			}),
		).resolves.toStrictEqual(
			{
				forward: NO_MISMATCH,
				undo: NO_MISMATCH,
			},
		);
	});

	it("indents a bullet under a leaf that a mirror shows", async () =>
	{
		await expect(
			withUndo(({move}) =>
			{
				move.mutate(
					{
						nodeId: "bravo1",
						parent_id: "charlie",
					},
				);
			}),
		).resolves.toStrictEqual(
			{
				forward: NO_MISMATCH,
				undo: NO_MISMATCH,
			},
		);
	});

	it("outdents a bullet below its parent", async () =>
	{
		await expect(
			withUndo(({move}) =>
			{
				move.mutate(
					{
						nodeId: "alpha2",
						parent_id: null,
						index: 1,
					},
				);
			}),
		).resolves.toStrictEqual(
			{
				forward: NO_MISMATCH,
				undo: NO_MISMATCH,
			},
		);
	});

	it("moves a parent's only child out, leaving it a leaf", async () =>
	{
		await expect(
			withUndo(({move}) =>
			{
				move.mutate(
					{
						nodeId: "bravo1",
						parent_id: "alpha",
						index: 0,
					},
				);
			}),
		).resolves.toStrictEqual(
			{
				forward: NO_MISMATCH,
				undo: NO_MISMATCH,
			},
		);
	});

	it("reorders siblings", async () =>
	{
		await expect(
			withUndo(({move}) =>
			{
				move.mutate(
					{
						nodeId: "alpha",
						parent_id: null,
						index: 3,
					},
				);
			}),
		).resolves.toStrictEqual(
			{
				forward: NO_MISMATCH,
				undo: NO_MISMATCH,
			},
		);
	});

	it("completes a parent's last uncompleted child", async () =>
	{
		await expect(
			withUndo(({toggle}) =>
			{
				toggle.mutate(
					{
						nodeId: "bravo1",
						isCurrentlyCompleted: false,
					},
				);
			}),
		).resolves.toStrictEqual(
			{
				forward: NO_MISMATCH,
				undo: NO_MISMATCH,
			},
		);
	});

	it("uncompletes a child of a parent with only completed children left", async () =>
	{
		await expect(
			withUndo(({toggle}) =>
			{
				toggle.mutate(
					{
						nodeId: "done1",
						isCurrentlyCompleted: true,
					},
				);
			}),
		).resolves.toStrictEqual(
			{
				forward: NO_MISMATCH,
				undo: NO_MISMATCH,
			},
		);
	});

	it("deletes a parent's only child", async () =>
	{
		await expect(
			withUndo(({remove}) =>
			{
				remove.mutate("bravo1");
			}),
		).resolves.toStrictEqual(
			{
				forward: NO_MISMATCH,
				undo: NO_MISMATCH,
			},
		);
	});

	it("deletes a top-level bullet", async () =>
	{
		await expect(
			withUndo(({remove}) =>
			{
				remove.mutate("alpha");
			}),
		).resolves.toStrictEqual(
			{
				forward: NO_MISMATCH,
				undo: NO_MISMATCH,
			},
		);
	});

	it("moves a block of siblings to another parent", async () =>
	{
		await expect(
			withUndo(({moveMany}) =>
			{
				moveMany.mutate(
					{
						ids: ["alpha1", "alpha2"],
						parent_id: "bravo",
						index: 1,
					},
				);
			}),
		).resolves.toStrictEqual(
			{
				forward: NO_MISMATCH,
				undo: NO_MISMATCH,
			},
		);
	});

	it("moves several blocks in one request, each slot counted after the earlier blocks moved", async () =>
	{
		await expect(
			withUndo(({moveMany}) =>
			{
				moveMany.mutate(
					{
						moves: [
							{
								ids: ["charlie"],
								parent_id: "bravo",
								index: 1,
							},
							{
								ids: ["alpha"],
								parent_id: "bravo",
								index: 2,
							},
						],
					},
				);
			}),
		).resolves.toStrictEqual(
			{
				forward: NO_MISMATCH,
				undo: NO_MISMATCH,
			},
		);
	});
});

/** Which cached children lists hold each row that more than one list holds, as `row in list,list`. */
function rowsInTwoLists(queryClient: QueryClient): string[]
{
	const lists = new Map<string, string[]>();
	for (const [key, rows] of queryClient.getQueriesData<NodeResponse[]>(
		{
			queryKey: [...nodeKeys.all, "children"],
		},
	))
	{
		for (const row of rows ?? [])
		{
			lists.set(row.id, [...(lists.get(row.id) ?? []), String(key[2])]);
		}
	}
	return [...lists]
		.filter(([, parents]) => parents.length > 1)
		.map(([id, parents]) => `${id} in ${parents.join(",")}`);
}

describe("a block move (multi-select Tab)", () =>
{
	it("sends one request and expands the new parent in the same task as the splice", async () =>
	{
		const queryClient = await loadedClient();
		const {moveMany} = captureHooks(queryClient);
		const events: string[] = [];
		onExpand = (id) =>
		{
			// React renders a store change in a microtask: by then the block must already sit in the new parent.
			queueMicrotask(() =>
			{
				const ids = queryClient.getQueryData<NodeResponse[]>(nodeKeys.children(id))?.map((row) => row.id);
				events.push(`${id} renders expanded listing ${ids?.join(",")}`);
			});
		};
		moveMany.mutate(
			{
				ids: ["alpha1", "alpha2"],
				parent_id: "bravo",
				index: 1,
				expandParent: true,
			},
		);
		await settled(queryClient);
		expect(
			{
				writes,
				events,
			},
		).toStrictEqual(
			{
				writes: [
					`POST /api/v1/nodes/move ${JSON.stringify(
						{
							ids: ["alpha1", "alpha2"],
							parent_id: "bravo",
							index: 1,
						},
					)}`,
				],
				events: ["bravo renders expanded listing bravo1,alpha1,alpha2"],
			},
		);
	});

	it("sends a non-contiguous selection's blocks in one request and expands every new parent with its splice", async () =>
	{
		const queryClient = await loadedClient();
		const {moveMany} = captureHooks(queryClient);
		const events: string[] = [];
		onExpand = (id) =>
		{
			queueMicrotask(() =>
			{
				const ids = queryClient.getQueryData<NodeResponse[]>(nodeKeys.children(id))?.map((row) => row.id);
				events.push(`${id} renders expanded listing ${ids?.join(",")}`);
			});
		};
		// Per-call callbacks need a mounted listener, which a static render never subscribes: only the request is awaited.
		void sendBlockMoves(
			[
				{
					ids: ["foxtrot"],
					parentId: "charlie",
					index: 0,
					expandParent: true,
				},
				{
					ids: ["alpha2"],
					parentId: "alpha1",
					index: 0,
					expandParent: true,
				},
			],
			moveMany.mutate,
		);
		await settled(queryClient);
		expect(
			{
				writes,
				events,
				settled: await settledMismatches(queryClient),
			},
		).toStrictEqual(
			{
				writes: [
					`POST /api/v1/nodes/move ${JSON.stringify(
						{
							moves: [
								{
									ids: ["foxtrot"],
									parent_id: "charlie",
									index: 0,
								},
								{
									ids: ["alpha2"],
									parent_id: "alpha1",
									index: 0,
								},
							],
						},
					)}`,
				],
				events: ["charlie renders expanded listing foxtrot", "alpha1 renders expanded listing alpha2"],
				settled: [],
			},
		);
	});

	it("never shows a row in two lists while a second Tab overtakes the first, and settles on the server's tree", async () =>
	{
		const queryClient = await loadedClient();
		const {moveMany} = captureHooks(queryClient);
		const duplicates = new Set<string>();
		const unsubscribe = queryClient.getQueryCache().subscribe(() =>
		{
			for (const duplicate of rowsInTwoLists(queryClient))
			{
				duplicates.add(duplicate);
			}
		});
		moveMany.mutate(
			{
				ids: ["alpha1", "alpha2"],
				parent_id: "bravo",
				index: 1,
			},
		);
		moveMany.mutate(
			{
				ids: ["alpha1", "alpha2"],
				parent_id: "bravo1",
				index: 0,
			},
		);
		await settled(queryClient);
		unsubscribe();
		expect(
			{
				duplicates: [...duplicates],
				bravo1: queryClient.getQueryData<NodeResponse[]>(nodeKeys.children("bravo1"))?.map((row) => row.id),
				settled: await settledMismatches(queryClient),
			},
		).toStrictEqual(
			{
				duplicates: [],
				bravo1: ["alpha1", "alpha2"],
				settled: [],
			},
		);
	});
});

describe("the dev-only runtime check", () =>
{
	it("scopes a write to its parents' lists, the lists holding its rows, and their details", async () =>
	{
		const queryClient = await loadedClient();
		expect(affectedKeys(queryClient, ["bravo1"], ["bravo"]).map((key) => JSON.stringify(key))).toStrictEqual(
			[
				nodeKeys.children("bravo"),
				nodeKeys.children(null),
				nodeKeys.detail("bravo1"),
				nodeKeys.detail("bravo"),
			].map((key) => JSON.stringify(key)),
		);
	});

	it("reads the server's side of every key in one request", async () =>
	{
		const queryClient = await loadedClient();
		const keys = [...verifiedKeys(queryClient), nodeKeys.children("gone"), nodeKeys.detail("gone")];
		const requests: string[] = [];
		const served = globalThis.fetch;
		vi.stubGlobal("fetch", async (url: string, init?: RequestInit) =>
		{
			requests.push(`${init?.method ?? "GET"} ${url}`);
			return served(url, init);
		});
		const entries = await fetchServerEntries(keys);
		expect(
			{
				requests,
				keys: [...entries.keys()],
				bravo: entries.get(JSON.stringify(nodeKeys.children("bravo"))),
			},
		).toStrictEqual(
			{
				requests: ["POST /api/v1/nodes/verify"],
				keys: [
					...SHOWN_LISTS.map((parentId) => nodeKeys.children(parentId)),
					...SHOWN_DETAILS.map((nodeId) => nodeKeys.detail(nodeId)),
				].map((key) => JSON.stringify(key)),
				bravo: [
					{
						id: "bravo1",
						parent_id: "bravo",
						name: "bravo1",
						note: "",
						completed: false,
						hasChildren: false,
						hasUncompletedChildren: false,
						isMirror: false,
						originalNodeId: null,
					},
				],
			},
		);
	});

	it("reports each cached entry that differs from the server", async () =>
	{
		const queryClient = await loadedClient();
		queryClient.setQueryData<NodeResponse[]>(nodeKeys.children("bravo"), (rows) =>
			rows?.map((row) => (
			{
				...row,
				name: "stale",
			})),
		);
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const keys = affectedKeys(queryClient, [], ["bravo"]);
		await reportMismatches("move", keys, snapshotEntries(queryClient, keys));
		expect(errors.mock.calls).toStrictEqual([
			[
				`[cache-verify] move: cache differs from the server for ${JSON.stringify(nodeKeys.children("bravo"))}`,
				['bravo1.name: "stale" -> "bravo1"'],
			],
		]);
	});

	it("stays quiet when a newer mutation started before the server answered", async () =>
	{
		const queryClient = await loadedClient();
		queryClient.setQueryData(nodeKeys.children("bravo"), []);
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const keys = affectedKeys(queryClient, [], ["bravo"]);
		await reportMismatches("move", keys, snapshotEntries(queryClient, keys), () => true);
		expect(errors.mock.calls).toStrictEqual([]);
	});
});
