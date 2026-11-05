// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import type {Root} from "react-dom/client";
import type {NodeResponse} from "../src/node-types.js";

declare global {
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
const {placeSelectionAtTextOffsets} = await import("../src/client/caret-dom.js");
const {useOutlineStore} = await import("../src/client/stores/outline.js");
const {undoHistory} = await import("../src/client/undo-history.js");

function row(id: string, parentId: string | null, priority: number, hasChildren = false): NodeResponse {
	return {
		id,
		parent_id: parentId,
		name: id,
		note: null,
		priority,
		data: {layoutMode: null},
		completedAt: null,
		createdAt: 0,
		modifiedAt: 0,
		hasChildren,
	};
}

let server = new Map<string, NodeResponse>();
/** Requests the app made, in order: `children:<id>` loads and `move:<id>:<body>` moves. */
let calls: string[] = [];
let root: Root | undefined;
let mountedClient: InstanceType<typeof QueryClient> | undefined;

function childrenOf(parentId: string | null): NodeResponse[] {
	const siblings = [...server.values()].filter((node) => node.parent_id === parentId);
	// oxlint-disable-next-line unicorn/no-array-sort -- the test tsconfig lib has no toSorted
	return siblings.sort((a, b) => a.priority - b.priority);
}

/**
 * Wait out the mounted outline's in-flight loads and writes, such as a move's follow-up sync. Left running, they
 * would land in the next test's `calls` through the module-level children batcher and the re-stubbed `fetch`.
 */
async function drain(): Promise<void> {
	const client = mountedClient;
	const busy = (): boolean => client !== undefined && client.isFetching() + client.isMutating() > 0;
	await act(async () => {
		while (busy()) {
			// oxlint-disable-next-line no-await-in-loop -- polls until the client is idle
			await new Promise((resolve) => {
				setTimeout(resolve, 0);
			});
		}
	});
}

async function settle(): Promise<void> {
	await act(async () => {
		await new Promise((resolve) => {
			setTimeout(resolve, 50);
		});
	});
}

function bodyOf(init: RequestInit | undefined): string {
	return typeof init?.body === "string" ? init.body : "{}";
}

function answer(url: string, init: RequestInit | undefined): Response {
	if (url.endsWith("/api/v1/nodes")) {
		return Response.json({nodes: childrenOf(null)});
	}
	if (url.endsWith("/api/v1/nodes/children")) {
		const {parentIds} = JSON.parse(bodyOf(init)) as {parentIds: string[]};
		for (const id of parentIds) {
			calls.push(`children:${id}`);
		}
		return Response.json({children: Object.fromEntries(parentIds.map((id) => [id, childrenOf(id)]))});
	}
	const move = /\/api\/v1\/nodes\/([^/?]+)\/move$/u.exec(url);
	if (move?.[1] !== undefined) {
		const body = JSON.parse(bodyOf(init)) as {parent_id: string | null; index?: number};
		calls.push(`move:${move[1]}:${JSON.stringify(body)}`);
		const node = server.get(move[1]);
		if (node === undefined) {
			return Response.json({}, {status: 404});
		}
		const oldParentId = node.parent_id;
		const siblings = childrenOf(body.parent_id).filter((sibling) => sibling.id !== node.id);
		siblings.splice(body.index ?? siblings.length, 0, node);
		siblings.forEach((sibling, index) => {
			server.set(sibling.id, {...sibling, parent_id: body.parent_id, priority: index});
		});
		return Response.json({
			nodes: [...new Set([oldParentId, body.parent_id])].flatMap((parent) => childrenOf(parent)),
		});
	}
	const id = /\/api\/v1\/nodes\/([^/?]+)$/u.exec(url)?.[1];
	const node = id === undefined ? undefined : server.get(id);
	return node === undefined ? Response.json({}, {status: 404}) : Response.json({node});
}

/**
 * Mounts the outline over the server's root rows with `editingId`'s name editor open. Only the root list is cached,
 * as after a fresh load: a collapsed row's children are not.
 */
async function mountEditing(rows: NodeResponse[], editingId: string): Promise<void> {
	server = new Map(rows.map((node) => [node.id, node]));
	calls = [];
	const queryClient = new QueryClient({
		defaultOptions: {queries: {retry: false, staleTime: Number.POSITIVE_INFINITY}},
	});
	mountedClient = queryClient;
	queryClient.setQueryData(nodeKeys.children(null), childrenOf(null));
	for (const node of rows) {
		queryClient.setQueryData(nodeKeys.detail(node.id), node);
	}
	useOutlineStore.setState(useOutlineStore.getInitialState(), true);
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	act(() => {
		root?.render(
			createElement(
				QueryClientProvider,
				{client: queryClient},
				createElement(MemoryRouter, null, createElement(OutlineView)),
			),
		);
	});
	await settle();
	act(() => {
		useOutlineStore.getState().resumeEditing(editingId, 0);
	});
	await settle();
}

function editorOf(nodeId: string): HTMLElement {
	const element = document.querySelector<HTMLElement>(`.innerContentContainer.editing[data-node-id="${nodeId}"]`);
	if (element === null) {
		throw new Error(`${nodeId} is not being edited`);
	}
	return element;
}

beforeEach(() => {
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
	undoHistory.clear();
	vi.stubGlobal(
		"fetch",
		vi.fn<typeof fetch>(async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			return Promise.resolve(answer(url, init));
		}),
	);
});

afterEach(async () => {
	await drain();
	act(() => {
		root?.unmount();
	});
	root = undefined;
	mountedClient = undefined;
	document.body.replaceChildren();
	vi.unstubAllGlobals();
});

describe("moving the edited row", () => {
	it("keeps the whole selected range through a move down", async () => {
		await mountEditing([row("A", null, 0), row("Bravo", null, 1), row("C", null, 2)], "Bravo");
		act(() => {
			placeSelectionAtTextOffsets(editorOf("Bravo"), 1, 4);
		});

		act(() => {
			activeCommandRegistry().move_down.execute({items: ["Bravo"], zoomedId: null});
		});
		await settle();

		const selection = globalThis.getSelection();
		const {editingCaretOffset, editingCaretEnd} = useOutlineStore.getState();
		expect({
			order: childrenOf(null).map((node) => node.id),
			selected: selection?.toString(),
			inEditor: editorOf("Bravo").contains(selection?.anchorNode ?? null),
			held: {editingCaretOffset, editingCaretEnd},
		}).toStrictEqual({
			order: ["A", "C", "Bravo"],
			selected: "rav",
			inEditor: true,
			held: {editingCaretOffset: 1, editingCaretEnd: 4},
		});
	});

	it("loads a never-opened target's children before indenting, so the row lands after them", async () => {
		await mountEditing([row("Delta", null, 0, true), row("Bravo", null, 1), row("D1", "Delta", 0)], "Bravo");

		act(() => {
			activeCommandRegistry().indent.execute({items: ["Bravo"], zoomedId: null});
		});
		await settle();

		expect(calls.slice(0, 2)).toStrictEqual(["children:Delta", 'move:Bravo:{"parent_id":"Delta","index":1}']);
	});

	it("loads the previous sibling's never-opened children while the row is edited, so Tab moves without a round trip", async () => {
		await mountEditing([row("Delta", null, 0, true), row("Bravo", null, 1), row("D1", "Delta", 0)], "Bravo");
		const loadedWhileEditing = [...calls];

		// Only microtasks run here: no request can answer, so the row must move on the loaded children alone.
		await act(async () => {
			activeCommandRegistry().indent.execute({items: ["Bravo"], zoomedId: null});
			await Promise.resolve();
		});
		const deltaChildren = mountedClient
			?.getQueryData<NodeResponse[]>(nodeKeys.children("Delta"))
			?.map((node) => node.id);

		expect({loadedWhileEditing, deltaChildren}).toStrictEqual({
			loadedWhileEditing: ["children:Delta"],
			deltaChildren: ["D1", "Bravo"],
		});
	});

	it("loads a never-opened target's children before a move up into it, then lands first in the collapsed row", async () => {
		await mountEditing(
			[row("Delta", null, 0, true), row("Bravo", null, 1, true), row("B1", "Bravo", 0), row("D1", "Delta", 0)],
			"B1",
		);

		act(() => {
			activeCommandRegistry().move_up.execute({items: ["B1"], zoomedId: null});
		});
		await settle();

		expect(calls.slice(0, 2)).toStrictEqual(["children:Delta", 'move:B1:{"parent_id":"Delta","index":0}']);
	});
});
