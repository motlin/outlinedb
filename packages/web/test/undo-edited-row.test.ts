// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import type {Root} from "react-dom/client";
import type {NodeResponse} from "../src/node-types.js";
import type {ViewState} from "../src/client/undo-history.js";

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

function row(id: string, name: string, priority: number): NodeResponse
{
	return {
		id,
		parent_id: null,
		name,
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

/** The server's rows; name updates land here, so the refetch after the undo agrees with the preview. */
let server = new Map<string, NodeResponse>();
let queryClient = new QueryClient();
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

function answer(url: string, init: RequestInit | undefined): Response
{
	if (url.endsWith("/api/v1/nodes"))
	{
		return Response.json(
			{
				nodes: [...server.values()],
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
	const id = /\/api\/v1\/nodes\/([^/?]+)$/u.exec(url)?.[1];
	const node = id === undefined ? undefined : server.get(id);
	if (node === undefined)
	{
		return Response.json(
			{},
			{
				status: 404,
			},
		);
	}
	if (init?.method === "POST" && typeof init.body === "string")
	{
		const {name} = JSON.parse(init.body) as
		{
			name?: string;
		};
		const updated =
			name === undefined
				? node
				:
					{
						...node,
						name,
					};
		server.set(updated.id, updated);
		return Response.json(updated);
	}
	return Response.json(node);
}

/** Mounts the outline over `rows` with `editingId`'s name editor open and its caret at `caret`. */
async function mountEditing(rows: NodeResponse[], editingId: string, caret: number): Promise<void>
{
	server = new Map(rows.map((node) => [node.id, node]));
	queryClient = new QueryClient(
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
	queryClient.setQueryData(nodeKeys.children(null), rows);
	for (const node of rows)
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
		useOutlineStore.getState().resumeEditing(editingId, caret);
	});
	await settle();
}

function editing(nodeId: string, offset: number, end = offset): ViewState
{
	return {
		zoomedNodeId: null,
		editing:
		{
			nodeId,
			field: "name",
			start: offset,
			end,
		},
		selectedIds: [],
	};
}

/** The edited row's name editor: its text, whether it has focus, and the caret offset in it. */
function editor(nodeId: string):
{
	text: string | null;
	focused: boolean;
	caret: number | null;
}
{
	const element = document.querySelector<HTMLElement>(`.innerContentContainer.editing[data-node-id="${nodeId}"]`);
	const focusNode = globalThis.getSelection()?.focusNode ?? null;
	return {
		text: element?.textContent ?? null,
		focused: element !== null && document.activeElement === element,
		caret:
			element !== null && focusNode !== null && element.contains(focusNode)
				? (globalThis.getSelection()?.focusOffset ?? null)
				: null,
	};
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

describe("⌘Z on the row being edited", () =>
{
	it("restores the whole selection range saved with the step, not just a caret", async () =>
	{
		await mountEditing([row("alice", "Alice q", 0)], "alice", 7);
		undoHistory.push(
			{
				ops: [
					{
						kind: "edit",
						nodeId: "alice",
						field: "name",
						before: "Alice",
						after: "Alice q",
					},
				],
				before: editing("alice", 1, 4),
				after: editing("alice", 7),
			},
		);

		await undo();

		const selection = globalThis.getSelection();
		expect(
			{
				text: selection?.toString(),
				anchor: selection?.anchorOffset,
				focus: selection?.focusOffset,
			},
		).toStrictEqual(
			{
				text: "lic",
				anchor: 1,
				focus: 4,
			},
		);
	});

	it("shows the undone text in the editor and keeps the caret in the row", async () =>
	{
		await mountEditing([row("alice", "Alice q", 0)], "alice", 7);
		undoHistory.push(
			{
				ops: [
					{
						kind: "edit",
						nodeId: "alice",
						field: "name",
						before: "Alice",
						after: "Alice q",
					},
				],
				before: editing("alice", 5),
				after: editing("alice", 7),
			},
		);

		await undo();

		expect(editor("alice")).toStrictEqual(
			{
				text: "Alice",
				focused: true,
				caret: 5,
			},
		);
	});

	it("after Enter and typing, the first ⌘Z empties the new row and keeps the caret in it", async () =>
	{
		await mountEditing([row("alice", "Alice", 0), row("yank", "Yank", 1)], "yank", 4);
		undoHistory.push(
			{
				ops: [
					{
						kind: "edit",
						nodeId: "yank",
						field: "name",
						before: "",
						after: "Yank",
					},
				],
				before: editing("yank", 4),
				after: editing("yank", 4),
			},
		);

		await undo();

		expect(editor("yank")).toStrictEqual(
			{
				text: "",
				focused: true,
				caret: 0,
			},
		);
	});
});
