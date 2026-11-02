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
const {activeNoteContent, selectionTextOffsets} = await import("../src/client/caret-dom.js");
const {useOutlineStore} = await import("../src/client/stores/outline.js");
const {undoHistory} = await import("../src/client/undo-history.js");

function row(id: string, name: string, priority: number, note: string | null = null): NodeResponse
{
	return {
		id,
		parent_id: null,
		name,
		note,
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
		const body = JSON.parse(init.body) as
		{
			name?: string;
			note?: string | null;
		};
		const updated =
		{
			...node,
			...(body.name === undefined
				? {}
				:
					{
						name: body.name,
					}),
			...(body.note === undefined
				? {}
				:
					{
						note: body.note,
					}),
		};
		server.set(updated.id, updated);
		return Response.json(updated);
	}
	return Response.json(node);
}

/** Mounts the outline over `rows` with `noteId`'s note focused. */
async function mountNote(rows: NodeResponse[], noteId: string): Promise<void>
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
		useOutlineStore.getState().focusNote(noteId, 2);
	});
	await settle();
}

function noteElement(): HTMLElement
{
	const element = document.querySelector<HTMLElement>(".notes .content");
	if (element === null)
	{
		throw new Error("no note editor");
	}
	return element;
}

/** Types into the focused note the way the browser does: set the DOM, fire input. */
async function typeNote(text: string): Promise<void>
{
	const element = noteElement();
	element.textContent = text;
	act(() =>
	{
		element.dispatchEvent(
			new Event(
				"input",
				{
					bubbles: true,
				},
			),
		);
	});
	await settle();
	await act(async () =>
	{
		await new Promise((resolve) =>
		{
			setTimeout(resolve, 600);
		});
	});
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

describe("⌘Z while a note is focused", () =>
{
	it("re-renders the note with the undone text so the next keystroke cannot re-save the undone text", async () =>
	{
		await mountNote([row("alice", "Alice", 0, "note text")], "alice");
		await typeNote("noQte text");
		expect(server.get("alice")?.note).toBe("noQte text");

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

		expect(server.get("alice")?.note).toBe("note text");
		expect(noteElement().textContent).toBe("note text");

		await typeNote(`${noteElement().textContent}Z`);
		expect(server.get("alice")?.note).toBe("note textZ");
	});

	it("puts the caret back at the offset saved with the step", async () =>
	{
		await mountNote([row("alice", "Alice", 0, "note text")], "alice");
		undoHistory.push(
			{
				ops: [
					{
						kind: "edit",
						nodeId: "alice",
						field: "note",
						before: "note text",
						after: "noQte text",
					},
				],
				before:
				{
					zoomedNodeId: null,
					editing:
					{
						nodeId: "alice",
						field: "note",
						start: 3,
						end: 3,
					},
					selectedIds: [],
				},
				after:
				{
					zoomedNodeId: null,
					editing:
					{
						nodeId: "alice",
						field: "note",
						start: 10,
						end: 10,
					},
					selectedIds: [],
				},
			},
		);

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

		const content = activeNoteContent();
		expect(content === null ? null : selectionTextOffsets(content)).toStrictEqual(
			{
				start: 3,
				end: 3,
			},
		);
	});
});
