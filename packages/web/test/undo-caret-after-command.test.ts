// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import type {Root} from "react-dom/client";
import type {NodeResponse} from "../src/node-types.js";

declare global
{
	// React reads this to know act() wraps every update.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const {act, createElement} = await import("react");
const {createRoot} = await import("react-dom/client");
const {QueryClient, QueryClientProvider} = await import("@tanstack/react-query");
const {MemoryRouter} = await import("react-router-dom");
const {OutlineView} = await import("../src/client/app.js");
const {activeCommandRegistry} = await import("../src/client/hooks/use-global-keymap.js");
const {nodeKeys} = await import("../src/client/node-cache.js");
const {useOutlineStore} = await import("../src/client/stores/outline.js");
const {undoHistory} = await import("../src/client/undo-history.js");

function row(id: string, priority: number): NodeResponse
{
	return {
		id,
		parent_id: null,
		name: `${id} text`,
		note: null,
		priority,
		data:
		{
			layoutMode: null,
		},
		completedAt: null,
		createdAt: 0,
		modifiedAt: 0,
		hasChildren: false,
	};
}

const ROWS = [row("A", 0), row("B", 1), row("C", 2)];
let root: Root | undefined;

async function settle(): Promise<void>
{
	await act(async () =>
	{
		await new Promise((resolve) =>
		{
			setTimeout(resolve, 50);
		});
	});
}

/** A server that accepts every write; the assertions read the editor state the undo restores, not the rows. */
function answer(url: string, init: RequestInit | undefined): Response
{
	if (url.endsWith("/api/v1/nodes"))
	{
		return init?.method === "POST"
			? Response.json(
					{
						node:
						{
							...row("B2", 2),
							name: "B text",
						},
					},
				)
			: Response.json(
					{
						nodes: ROWS,
					},
				);
	}
	if (url.endsWith("/api/v1/nodes/children"))
	{
		return Response.json(
			{
				children: {},
			},
		);
	}
	const id = /\/api\/v1\/nodes\/([^/?]+)/u.exec(url)?.[1];
	if (id === undefined)
	{
		return Response.json(
			{},
			{
				status: 404,
			},
		);
	}
	return Response.json(
		{
			node: ROWS.find((candidate) => candidate.id === id) ?? row(id, 0),
		},
	);
}

/** Mounts the outline over A, B and C with B's editor open and its caret at offset 3. */
async function mountEditingB(): Promise<void>
{
	const queryClient = new QueryClient(
		{
			defaultOptions:
			{
				queries:
				{
					retry: false,
					staleTime: Number.POSITIVE_INFINITY,
				},
			},
		},
	);
	queryClient.setQueryData(nodeKeys.children(null), ROWS);
	for (const node of ROWS)
	{
		queryClient.setQueryData(nodeKeys.detail(node.id), node);
	}
	useOutlineStore.setState(useOutlineStore.getInitialState(), true);
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	act(() =>
	{
		root?.render(
			createElement(
				QueryClientProvider,
				{
					client: queryClient,
				},
				createElement(MemoryRouter, null, createElement(OutlineView)),
			),
		);
	});
	await settle();
	act(() =>
	{
		useOutlineStore.getState().resumeEditing("B", 3);
	});
	await settle();
}

function edited():
{
	editingId: string | null;
	offset: number | null;
}
{
	const {editingId, editingCaretOffset} = useOutlineStore.getState();
	return {
		editingId,
		offset: editingCaretOffset,
	};
}

async function run(command: "complete" | "delete" | "duplicate"): Promise<void>
{
	act(() =>
	{
		activeCommandRegistry()[command].execute(
			{
				items: ["B"],
				zoomedId: null,
			},
		);
	});
	await settle();
}

async function undo(): Promise<void>
{
	act(() =>
	{
		activeCommandRegistry().undo.execute(
			{
				items: [],
				zoomedId: null,
			},
		);
	});
	await settle();
	await settle();
}

beforeEach(() =>
{
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
	undoHistory.clear();
	vi.stubGlobal(
		"fetch",
		vi.fn<typeof fetch>(async (input, init) =>
		{
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			return Promise.resolve(answer(url, init));
		}),
	);
});

afterEach(() =>
{
	act(() =>
	{
		root?.unmount();
	});
	root = undefined;
	document.body.replaceChildren();
	vi.unstubAllGlobals();
});

describe("⌘Z after a command that moves the caret", () =>
{
	it("returns the caret to the completed row at its old offset", async () =>
	{
		await mountEditingB();
		await run("complete");
		expect(edited().editingId).not.toBe("B");

		await undo();

		expect(edited()).toStrictEqual(
			{
				editingId: "B",
				offset: 3,
			},
		);
	});

	it("returns the caret to the restored row after a delete", async () =>
	{
		await mountEditingB();
		await run("delete");
		expect(edited().editingId).not.toBe("B");

		await undo();

		expect(edited()).toStrictEqual(
			{
				editingId: "B",
				offset: 3,
			},
		);
	});

	it("returns the caret to the duplicated row", async () =>
	{
		await mountEditingB();
		await run("duplicate");

		await undo();

		expect(edited()).toStrictEqual(
			{
				editingId: "B",
				offset: 3,
			},
		);
	});
});
