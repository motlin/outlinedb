import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import type {NodeResponse} from "../src/node-types.js";
import {nodeKeys, renderedCopyIds} from "../src/client/node-cache.js";
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

const {useToggleComplete} = await import("../src/client/hooks/use-nodes.js");

function node(
	partial: Partial<NodeResponse> &
	{
		id: string;
	},
): NodeResponse
{
	return {
		parent_id: "p",
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
		hasChildren: true,
		hasUncompletedChildren: true,
		...partial,
	};
}

/** O under A; M1 (a mirror of O) alone under B; M2 (a mirror of O) alone under C. */
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
	queryClient.setQueryData(nodeKeys.children("A"), [
		node(
			{
				id: "O",
				parent_id: "A",
			},
		),
	]);
	queryClient.setQueryData(nodeKeys.children("B"), [
		node(
			{
				id: "M1",
				parent_id: "B",
				isMirror: true,
				originalNodeId: "O",
			},
		),
	]);
	queryClient.setQueryData(nodeKeys.children("C"), [
		node(
			{
				id: "M2",
				parent_id: "C",
				isMirror: true,
				originalNodeId: "O",
			},
		),
	]);
	for (const parent of ["A", "B", "C"])
	{
		queryClient.setQueryData(
			nodeKeys.detail(parent),
			node(
				{
					id: parent,
					parent_id: null,
				},
			),
		);
	}
	return queryClient;
}

function captureToggle(queryClient: QueryClient)
{
	const captured: ReturnType<typeof useToggleComplete>[] = [];
	function Probe()
	{
		captured.push(useToggleComplete());
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
	const hook = captured.at(0);
	if (hook === undefined)
	{
		throw new Error("hook not captured");
	}
	return hook;
}

/** Each rendered copy's completion and each parent's uncompleted-children flag. */
function snapshot(queryClient: QueryClient)
{
	const row = (parent: string, id: string) =>
		queryClient.getQueryData<NodeResponse[]>(nodeKeys.children(parent))?.find((n) => n.id === id)?.completedAt !==
		null;
	const flag = (parent: string) =>
		queryClient.getQueryData<NodeResponse>(nodeKeys.detail(parent))?.hasUncompletedChildren;
	return {
		done:
		{
			O: row("A", "O"),
			M1: row("B", "M1"),
			M2: row("C", "M2"),
		},
		uncompletedChildren:
		{
			A: flag("A"),
			B: flag("B"),
			C: flag("C"),
		},
	};
}

beforeEach(() =>
{
	undoHistory.clear();
});

afterEach(() =>
{
	vi.unstubAllGlobals();
});

describe("toggling completion on a mirror", () =>
{
	it("completes the original and every rendered mirror at once, with their parents' flags", async () =>
	{
		vi.stubGlobal("fetch", async () => new Promise<Response>(() => {}));
		const queryClient = seeded();

		captureToggle(queryClient).mutate(
			{
				nodeId: "M1",
				isCurrentlyCompleted: false,
			},
		);

		await vi.waitFor(() =>
		{
			expect(snapshot(queryClient)).toStrictEqual(
				{
					done:
					{
						O: true,
						M1: true,
						M2: true,
					},
					uncompletedChildren:
					{
						A: false,
						B: false,
						C: false,
					},
				},
			);
		});
	});

	it("completes every copy when the original itself is toggled", async () =>
	{
		vi.stubGlobal("fetch", async () => new Promise<Response>(() => {}));
		const queryClient = seeded();

		captureToggle(queryClient).mutate(
			{
				nodeId: "O",
				isCurrentlyCompleted: false,
			},
		);

		await vi.waitFor(() =>
		{
			expect(snapshot(queryClient).done).toStrictEqual(
				{
					O: true,
					M1: true,
					M2: true,
				},
			);
		});
	});

	it("restores the original, the mirrors and their parents when the write fails", async () =>
	{
		vi.stubGlobal("fetch", async () =>
			Promise.resolve(
				Response.json(
					{
						error: "boom",
					},
					{
						status: 500,
					},
				),
			),
		);
		const queryClient = seeded();
		const before = snapshot(queryClient);

		const hook = captureToggle(queryClient);
		hook.mutate(
			{
				nodeId: "M1",
				isCurrentlyCompleted: false,
			},
		);

		await vi.waitFor(() =>
		{
			expect(queryClient.isMutating()).toBe(0);
		});
		expect(snapshot(queryClient)).toStrictEqual(before);
	});
});

describe("renderedCopyIds", () =>
{
	it("adds the original and every cached mirror of each id, once, keeping plain ids", () =>
	{
		const queryClient = seeded();

		expect(new Set(renderedCopyIds(queryClient, ["M1", "A"]))).toStrictEqual(new Set(["A", "M1", "M2", "O"]));
	});
});
