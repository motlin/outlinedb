import {QueryClient, QueryClientProvider, QueryObserver} from "@tanstack/react-query";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import type {BacklinksResponse, FoundDatesResponse, NodeResponse, UpdateNodeResponse} from "../src/node-types.js";
import {nodeKeys} from "../src/client/node-cache.js";
import {undoHistory} from "../src/client/undo-history.js";

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
};

vi.mock("../src/client/stores/outline.js", () => (
{
	useOutlineStore: Object.assign(
		(selector?: (state: typeof outlineState) => unknown) => (selector ? selector(outlineState) : outlineState),
		{
			getState: () => outlineState,
		},
	),
}));

const {useUpdateNode} = await import("../src/client/hooks/use-nodes.js");

function node(
	partial: Partial<NodeResponse> &
	{
		id: string;
	},
): NodeResponse
{
	return {
		parent_id: "home",
		name: null,
		note: null,
		priority: 0,
		data:
		{
			layoutMode: null,
		},
		createdAt: null,
		modifiedAt: null,
		completedAt: null,
		...partial,
	};
}

function captureUpdate(queryClient: QueryClient): ReturnType<typeof useUpdateNode>
{
	const captured: ReturnType<typeof useUpdateNode>[] = [];
	function Probe()
	{
		captured.push(useUpdateNode());
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
	const update = captured.at(0);
	if (update === undefined)
	{
		throw new Error("hook not captured");
	}
	return update;
}

const alice = node(
	{
		id: "alice",
		name: "Alice",
		priority: 100,
	},
);
const bob = node(
	{
		id: "bob",
		name: "Bob",
		priority: 200,
	},
);
const carol = node(
	{
		id: "carol",
		parent_id: "alice",
		name: "Carol",
	},
);
const aliceMirror = node(
	{
		id: "alice-mirror",
		parent_id: "dave",
		name: "Alice",
		isMirror: true,
		originalNodeId: "alice",
	},
);
/** Bob's Backlinks: Alice links to Bob. */
const bobBacklinks: BacklinksResponse =
{
	rootId: "bob-refs",
	items: [
		{
			node: node(
				{
					id: "bob-ref",
					name: "Alice",
					isMirror: true,
					originalNodeId: "alice",
				},
			),
			sourceId: "alice",
			crumbs: [],
		},
	],
};
/** Frank's Backlinks: Carol, under Alice, links to Frank. */
const frankBacklinks: BacklinksResponse =
{
	rootId: "frank-refs",
	items: [
		{
			node: node(
				{
					id: "frank-ref",
					name: "Carol",
					isMirror: true,
					originalNodeId: "carol",
				},
			),
			sourceId: "carol",
			crumbs: [
				{
					id: "alice",
					name: "Alice",
				},
			],
		},
	],
};
/** Eve's day page: Alice carries a date on it. */
const eveFoundDates: FoundDatesResponse =
{
	items: [
		{
			node:
			{
				...alice,
				isMirror: true,
				originalNodeId: "alice",
			},
			crumbs: [],
		},
	],
};

const seededKeys = [
	nodeKeys.detail("alice"),
	nodeKeys.detail("bob"),
	nodeKeys.children(null),
	nodeKeys.children("alice"),
	nodeKeys.children("dave"),
	nodeKeys.ancestors("carol"),
	nodeKeys.ancestors("bob"),
	nodeKeys.backlinks("bob"),
	nodeKeys.backlinks("frank"),
	nodeKeys.foundDates("eve"),
	nodeKeys.home(),
];

/** A cache as the outline leaves it, every query mounted so an invalidation refetches it and counts a request. */
function seeded(): QueryClient
{
	const queryClient = new QueryClient(
		{
			defaultOptions:
			{
				mutations:
				{
					retry: false,
				},
			},
		},
	);
	const values: unknown[] = [
		alice,
		bob,
		[alice, bob],
		[carol],
		[aliceMirror],
		[alice, carol],
		[bob],
		bobBacklinks,
		frankBacklinks,
		eveFoundDates,
		{
			layoutMode: "bullets",
		},
	];
	for (const [index, queryKey] of seededKeys.entries())
	{
		queryClient.setQueryData(queryKey, values[index]);
		new QueryObserver(
			queryClient,
			{
				queryKey,
				staleTime: Number.POSITIVE_INFINITY,
				queryFn: async () =>
				{
					requests.push(`GET ${JSON.stringify(queryKey)}`);
					return Promise.resolve(queryClient.getQueryData(queryKey) ?? null);
				},
			},
		).subscribe(() => {});
	}
	return queryClient;
}

let requests: string[];
let answer: UpdateNodeResponse;

beforeEach(() =>
{
	undoHistory.clear();
	requests = [];
	vi.stubGlobal("fetch", async (url: string, init?: RequestInit) =>
	{
		requests.push(`${init?.method ?? "GET"} ${url}`);
		return Promise.resolve(Response.json(answer));
	});
});

afterEach(() =>
{
	vi.unstubAllGlobals();
});

async function save(queryClient: QueryClient, nodeId: string, name: string): Promise<void>
{
	captureUpdate(queryClient).mutate(
		{
			nodeId,
			name,
		},
	);
	await vi.waitFor(() =>
	{
		expect(
			{
				mutating: queryClient.isMutating(),
				fetching: queryClient.isFetching(),
			},
		).toStrictEqual(
			{
				mutating: 0,
				fetching: 0,
			},
		);
	});
}

const noEffects =
{
	backlinkTargets: [],
	dates: false,
};
const saved =
{
	...alice,
	name: "Alice <b>saved</b>",
	modifiedAt: 42,
};

describe("saving a node's text", () =>
{
	it("sends 1 request for plain typing and patches every cached copy, backlinks and found dates included", async () =>
	{
		const queryClient = seeded();
		answer =
		{
			node: saved,
			effects: noEffects,
		};
		await save(queryClient, "alice", "Alice saved");
		expect(
			{
				requests,
				detail: queryClient.getQueryData(nodeKeys.detail("alice")),
				children: queryClient.getQueryData(nodeKeys.children(null)),
				ancestors: queryClient.getQueryData(nodeKeys.ancestors("carol")),
				untouched: queryClient.getQueryData(nodeKeys.children("alice")),
				mirrors: queryClient.getQueryData(nodeKeys.children("dave")),
				bobBacklinks: queryClient.getQueryData(nodeKeys.backlinks("bob")),
				frankBacklinks: queryClient.getQueryData(nodeKeys.backlinks("frank")),
				foundDates: queryClient.getQueryData(nodeKeys.foundDates("eve")),
			},
		).toStrictEqual(
			{
				requests: ["POST /api/v1/nodes/alice"],
				detail: saved,
				children: [saved, bob],
				ancestors: [saved, carol],
				untouched: [carol],
				mirrors: [
					{
						...aliceMirror,
						name: "Alice <b>saved</b>",
					},
				],
				bobBacklinks:
				{
					...bobBacklinks,
					items: [
						{
							...bobBacklinks.items[0],
							node:
							{
								...bobBacklinks.items[0]?.node,
								name: "Alice <b>saved</b>",
							},
						},
					],
				},
				frankBacklinks:
				{
					...frankBacklinks,
					items: [
						{
							...frankBacklinks.items[0],
							crumbs: [
								{
									id: "alice",
									name: "Alice <b>saved</b>",
								},
							],
						},
					],
				},
				foundDates:
				{
					items: [
						{
							node:
							{
								...eveFoundDates.items[0]?.node,
								name: "Alice <b>saved</b>",
							},
							crumbs: [],
						},
					],
				},
			},
		);
	});

	it("sends 2 requests when the save adds a link: the save and the target's Backlinks", async () =>
	{
		const queryClient = seeded();
		answer =
		{
			node: saved,
			effects:
			{
				backlinkTargets: ["frank"],
				dates: false,
			},
		};
		await save(queryClient, "alice", "Alice saved");
		expect(requests).toStrictEqual([
			"POST /api/v1/nodes/alice",
			`GET ${JSON.stringify(nodeKeys.backlinks("frank"))}`,
		]);
	});

	it("sends 2 requests when the save adds a date: the save and the cached Found Dates", async () =>
	{
		const queryClient = seeded();
		answer =
		{
			node: saved,
			effects:
			{
				backlinkTargets: [],
				dates: true,
			},
		};
		await save(queryClient, "alice", "Alice saved");
		expect(requests).toStrictEqual([
			"POST /api/v1/nodes/alice",
			`GET ${JSON.stringify(nodeKeys.foundDates("eve"))}`,
		]);
	});

	it("sends 1 request for typing in a mirror and patches its original's rows", async () =>
	{
		const queryClient = seeded();
		const savedMirror =
		{
			...aliceMirror,
			name: "Alice <b>saved</b>",
			modifiedAt: 42,
		};
		answer =
		{
			node: savedMirror,
			effects: noEffects,
		};
		await save(queryClient, "alice-mirror", "Alice saved");
		expect(
			{
				requests,
				children: queryClient.getQueryData(nodeKeys.children(null)),
				mirrors: queryClient.getQueryData(nodeKeys.children("dave")),
				bobBacklinks: queryClient.getQueryData(nodeKeys.backlinks("bob")),
			},
		).toStrictEqual(
			{
				requests: ["POST /api/v1/nodes/alice-mirror"],
				children: [
					{
						...alice,
						name: "Alice <b>saved</b>",
					},
					bob,
				],
				mirrors: [savedMirror],
				bobBacklinks:
				{
					...bobBacklinks,
					items: [
						{
							...bobBacklinks.items[0],
							node:
							{
								...bobBacklinks.items[0]?.node,
								name: "Alice <b>saved</b>",
							},
						},
					],
				},
			},
		);
	});
});
