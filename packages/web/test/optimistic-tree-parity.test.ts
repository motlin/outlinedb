import {QueryClient, QueryClientProvider, QueryObserver, notifyManager} from "@tanstack/react-query";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import type {NodeResponse} from "../src/node-types.js";
import {nodeKeys} from "../src/client/node-cache.js";

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
}));

const {fetchChildren, useCreateNode, useMoveNode} = await import("../src/client/hooks/use-nodes.js");

/** The server's tree: each node's parent, completion and its ordered children. */
interface ServerNode
{
	id: string;
	parent: string | null;
	completedAt: number | null;
}

let serverNodes: Map<string, ServerNode>;
let serverChildren: Map<string | null, string[]>;
/** Requests the fake server has answered, in arrival order. */
let arrivals: string[];
/**
 * The fake server's change seq and its writes, for `GET /changes`. The seq never resets between tests: the client's
 * high-water mark lives in a module that outlives each test, and it only ever advances.
 */
let clock = 0;
let writes:
{
	at: number;
	id: string;
	parents: (string | null)[];
}[];

function recordWrite(id: string, parents: (string | null)[]): void
{
	clock += 1;
	writes.push(
		{
			at: clock,
			id,
			parents,
		},
	);
}

function addServerNode(id: string, parent: string | null, completedAt: number | null = null, index?: number): void
{
	serverNodes.set(
		id,
		{
			id,
			parent,
			completedAt,
		},
	);
	const siblings = serverChildren.get(parent) ?? [];
	siblings.splice(index ?? siblings.length, 0, id);
	serverChildren.set(parent, siblings);
}

function serverRow(id: string): NodeResponse
{
	const node = serverNodes.get(id);
	if (node === undefined)
	{
		throw new Error(`unknown node ${id}`);
	}
	const children = serverChildren.get(id) ?? [];
	return {
		id,
		parent_id: node.parent,
		name: id,
		note: null,
		priority: 0,
		data:
		{
			layoutMode: null,
		},
		createdAt: null,
		modifiedAt: null,
		completedAt: node.completedAt,
		hasChildren: children.length > 0,
		hasUncompletedChildren: children.some((child) => serverNodes.get(child)?.completedAt === null),
		isMirror: false,
	};
}

function serverList(parentId: string | null): NodeResponse[]
{
	return (serverChildren.get(parentId) ?? []).map((id, index) => (
	{
		...serverRow(id),
		priority: (index + 1) * 100,
	}));
}

function bodyOf(init: RequestInit | undefined): Record<string, unknown>
{
	return JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
}

async function answer(url: string, init: RequestInit | undefined): Promise<Response>
{
	if (url === "/api/v1/nodes" && init?.method === "POST")
	{
		const body = bodyOf(init) as
		{
			id: string;
			parent_id?: string;
			index?: number;
		};
		arrivals.push(`create ${body.id}`);
		addServerNode(body.id, body.parent_id ?? null, null, body.index);
		recordWrite(body.id, [body.parent_id ?? null]);
		return Response.json(
			{
				node: serverRow(body.id),
			},
		);
	}
	if (url === "/api/v1/nodes/children")
	{
		const {parentIds} = bodyOf(init) as
		{
			parentIds: string[];
		};
		arrivals.push(`children ${parentIds.join(",")}`);
		return Response.json(
			{
				children: Object.fromEntries(parentIds.map((id) => [id, serverList(id)])),
			},
		);
	}
	if (url.startsWith("/api/v1/nodes/changes"))
	{
		const since = new URL(url, "http://x").searchParams.get("since");
		const changed = since === null ? [] : writes.filter((write) => write.at > Number(since));
		const parentIds = [...new Set(changed.flatMap((write) => write.parents))];
		return Response.json(
			{
				latest: String(clock),
				reset: false,
				changedIds: [...new Set(changed.map((write) => write.id))],
				deletedIds: [],
				children: parentIds.map((parentId) => (
				{
					parentId,
					nodes: serverList(parentId),
				})),
			},
		);
	}
	const movePrefix = "/api/v1/nodes/";
	if (url.startsWith(movePrefix) && url.endsWith("/move"))
	{
		const id = url.slice(movePrefix.length, -"/move".length);
		const {parent_id: parentId, index} = bodyOf(init) as
		{
			parent_id: string | null;
			index?: number;
		};
		// A move takes longer to reach the server than a children read sent right after it.
		await new Promise((resolve) =>
		{
			setTimeout(resolve, 20);
		});
		arrivals.push(`move ${id}`);
		const node = serverNodes.get(id);
		if (node === undefined)
		{
			return new Response(
				null,
				{
					status: 404,
				},
			);
		}
		const oldParentId = node.parent;
		serverChildren.set(
			oldParentId,
			(serverChildren.get(oldParentId) ?? []).filter((child) => child !== id),
		);
		serverNodes.delete(id);
		addServerNode(id, parentId, node.completedAt, index);
		recordWrite(id, [oldParentId, parentId]);
		const siblingIds = [...new Set([oldParentId, parentId])].flatMap((parent) => serverChildren.get(parent) ?? []);
		return Response.json(
			{
				nodes: siblingIds.map((sibling) => serverRow(sibling)),
			},
		);
	}
	return new Response(
		null,
		{
			status: 404,
		},
	);
}

/** What a row shows of its list: who it is, where, and whether it renders as a parent. */
function visible(rows: NodeResponse[] | undefined): unknown
{
	return rows?.map((row) => [row.id, row.parent_id, row.hasChildren, row.hasUncompletedChildren]);
}

/** Every children list the client caches, next to the server's list for the same parent. */
function cacheAgainstServer(queryClient: QueryClient):
{
	cache: unknown;
	server: unknown;
}
{
	const lists = queryClient.getQueriesData<NodeResponse[]>(
		{
			queryKey: [...nodeKeys.all, "children"],
		},
	);
	const cache: Record<string, unknown> = {};
	const server: Record<string, unknown> = {};
	for (const [key, rows] of lists)
	{
		const parentId = key.at(-1) as string | null;
		cache[String(parentId)] = visible(rows);
		server[String(parentId)] = visible(serverList(parentId));
	}
	return {
		cache,
		server,
	};
}

function useHooks()
{
	return {
		create: useCreateNode(),
		move: useMoveNode(),
	};
}

function captureHooks(queryClient: QueryClient): ReturnType<typeof useHooks>
{
	const captured: ReturnType<typeof useHooks>[] = [];
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

/** A client whose cache holds the server's lists for `parentIds`, as a loaded outline would. */
function loaded(parentIds: (string | null)[]): QueryClient
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
					staleTime: 60_000,
				},
			},
		},
	);
	for (const parentId of parentIds)
	{
		queryClient.setQueryData(nodeKeys.children(parentId), serverList(parentId));
	}
	return queryClient;
}

/** An outline row showing `parentId`'s children: an active query that refetches on invalidation. */
function showChildren(queryClient: QueryClient, parentId: string | null): QueryObserver<NodeResponse[]>
{
	const observer = new QueryObserver<NodeResponse[]>(
		queryClient,
		{
			queryKey: nodeKeys.children(parentId),
			queryFn: async () => fetchChildren(parentId),
		},
	);
	observer.subscribe(() => {});
	return observer;
}

/** Every value `parentId`'s children list shows, starting now, as a rendered row would see it (batched). */
function recordList(queryClient: QueryClient, parentId: string | null): unknown[]
{
	const states: unknown[] = [];
	const observer = new QueryObserver<NodeResponse[]>(
		queryClient,
		{
			queryKey: nodeKeys.children(parentId),
			enabled: false,
		},
	);
	// useQuery re-renders through batchCalls, so it reads the list once per batch of writes.
	observer.subscribe(
		notifyManager.batchCalls(() =>
		{
			record(visible(observer.getCurrentResult().data));
		}),
	);
	function record(next: unknown): void
	{
		if (JSON.stringify(states.at(-1)) !== JSON.stringify(next))
		{
			states.push(next);
		}
	}
	return states;
}

async function settled(queryClient: QueryClient): Promise<void>
{
	await vi.waitFor(() =>
	{
		expect(queryClient.isMutating() + queryClient.isFetching()).toBe(0);
	});
}

/** Let `onMutate` (which awaits a cancel) write its optimistic state. */
async function optimistic(): Promise<void>
{
	await new Promise((resolve) =>
	{
		setTimeout(resolve, 0);
	});
}

beforeEach(() =>
{
	serverNodes = new Map();
	serverChildren = new Map();
	arrivals = [];
	writes = [];
	// Home > g > (a, b); b has a completed child c.
	addServerNode("g", null);
	addServerNode("a", "g");
	addServerNode("b", "g");
	addServerNode("c", "b", 1);
	vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => answer(url, init));
});

afterEach(() =>
{
	vi.unstubAllGlobals();
});

describe("optimistic Enter/Tab write what the server will answer", () =>
{
	it("Enter: the new empty bullet is a leaf at once", async () =>
	{
		const queryClient = loaded([null, "g"]);
		captureHooks(queryClient).create.mutate(
			{
				id: "n",
				parent_id: "g",
				name: "",
				index: 1,
			},
		);
		const atOnce = cacheAgainstServer(queryClient);
		await settled(queryClient);
		expect(atOnce.cache).toStrictEqual(cacheAgainstServer(queryClient).server);
	});

	it("Enter as the first child of an empty zoom root makes the root a parent at once", async () =>
	{
		const queryClient = loaded([null, "g"]);
		captureHooks(queryClient).create.mutate(
			{
				id: "n",
				parent_id: "a",
				name: "",
				index: 0,
			},
		);
		const atOnce = cacheAgainstServer(queryClient);
		await settled(queryClient);
		expect(atOnce.cache).toStrictEqual(cacheAgainstServer(queryClient).server);
	});

	it("Tab into a leaf whose children are not cached seeds its list and makes it a parent", async () =>
	{
		const queryClient = loaded([null, "g"]);
		captureHooks(queryClient).move.mutate(
			{
				nodeId: "b",
				parent_id: "a",
				index: 0,
			},
		);
		await optimistic();
		const atOnce = cacheAgainstServer(queryClient);
		await settled(queryClient);
		expect(atOnce.cache).toStrictEqual(cacheAgainstServer(queryClient).server);
	});

	it("Tab into a cached sibling list updates both parents' flags", async () =>
	{
		addServerNode("d", "a");
		const queryClient = loaded([null, "g", "a", "b"]);
		captureHooks(queryClient).move.mutate(
			{
				nodeId: "c",
				parent_id: "a",
				index: 1,
			},
		);
		await optimistic();
		const atOnce = cacheAgainstServer(queryClient);
		await settled(queryClient);
		expect(atOnce.cache).toStrictEqual(cacheAgainstServer(queryClient).server);
	});

	it("Shift+Tab out of a parent leaves it a leaf when it was the only child", async () =>
	{
		addServerNode("d", "a");
		const queryClient = loaded([null, "g", "a"]);
		captureHooks(queryClient).move.mutate(
			{
				nodeId: "d",
				parent_id: "g",
				index: 1,
			},
		);
		await optimistic();
		const atOnce = cacheAgainstServer(queryClient);
		await settled(queryClient);
		expect(atOnce.cache).toStrictEqual(cacheAgainstServer(queryClient).server);
	});

	it("Tab while the new parent's expand fetch is in flight never shows its list empty", async () =>
	{
		const queryClient = loaded([null, "g"]);
		const states = recordList(queryClient, "a");
		captureHooks(queryClient).move.mutate(
			{
				nodeId: "b",
				parent_id: "a",
				index: 0,
			},
		);
		showChildren(queryClient, "a");
		await settled(queryClient);
		expect(states).toStrictEqual([[["b", "a", true, false]]]);
	});

	it("Enter then Tab: the change sync after each write never puts the moved row back", async () =>
	{
		// A loaded outline has taken the server's high-water mark (any children read seeds it).
		await fetchChildren("g");
		arrivals = [];
		const queryClient = loaded([null, "g"]);
		showChildren(queryClient, "g");
		const hooks = captureHooks(queryClient);
		hooks.create.mutate(
			{
				id: "n",
				parent_id: "g",
				name: "",
				index: 1,
			},
		);
		const states = recordList(queryClient, "g");
		hooks.move.mutate(
			{
				nodeId: "n",
				parent_id: "a",
				index: 0,
			},
		);
		await settled(queryClient);
		expect(
			{
				states,
				arrivals,
			},
		).toStrictEqual(
			{
				states: [
					[
						["a", "g", true, true],
						["b", "g", true, false],
					],
				],
				// Each write's settle patches the lists from the server's changes, with no children refetch.
				arrivals: ["create n", "move n"],
			},
		);
	});
});
