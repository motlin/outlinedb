// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import type {Root} from "react-dom/client";
import type {NodeResponse} from "../src/node-types.js";
import {act, createElement} from "react";
import {createRoot} from "react-dom/client";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {MemoryRouter} from "react-router-dom";
import {OutlineView} from "../src/client/app.js";
import {activeCommandRegistry} from "../src/client/hooks/use-global-keymap.js";
import {nodeKeys} from "../src/client/node-cache.js";
import {useOutlineStore} from "../src/client/stores/outline.js";
import {undoHistory} from "../src/client/undo-history.js";
import type {ViewState} from "../src/client/undo-history.js";
import {activeNoteContent, selectionTextOffsets} from "../src/client/caret-dom.js";

declare global {
	// React reads this to know act() wraps every update.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

describe("undo caret after command", () => {
	function row(id: string, priority: number): NodeResponse {
		return {
			id,
			parent_id: null,
			name: `${id} text`,
			note: null,
			priority,
			data: {layoutMode: null},
			completedAt: null,
			createdAt: 0,
			modifiedAt: 0,
			hasChildren: false,
		};
	}

	const ROWS = [row("A", 0), row("B", 1), row("C", 2)];
	let root: Root | undefined;

	async function settle(): Promise<void> {
		await act(async () => {
			await new Promise((resolve) => {
				setTimeout(resolve, 50);
			});
		});
	}

	/** A server that accepts every write; the assertions read the editor state the undo restores, not the rows. */
	function answer(url: string, init: RequestInit | undefined): Response {
		if (url.endsWith("/api/v1/nodes")) {
			return init?.method === "POST"
				? Response.json({node: {...row("B2", 2), name: "B text"}})
				: Response.json({nodes: ROWS});
		}
		if (url.endsWith("/api/v1/nodes/children")) {
			return Response.json({children: {}});
		}
		const id = /\/api\/v1\/nodes\/([^/?]+)/u.exec(url)?.[1];
		if (id === undefined) {
			return Response.json({}, {status: 404});
		}
		return Response.json({node: ROWS.find((candidate) => candidate.id === id) ?? row(id, 0)});
	}

	/** Mounts the outline over A, B and C with B's editor open and its caret at offset 3. */
	async function mountEditingB(): Promise<void> {
		const queryClient = new QueryClient({
			defaultOptions: {queries: {retry: false, staleTime: Number.POSITIVE_INFINITY}},
		});
		queryClient.setQueryData(nodeKeys.children(null), ROWS);
		for (const node of ROWS) {
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
			useOutlineStore.getState().resumeEditing("B", 3);
		});
		await settle();
	}

	function edited(): {editingId: string | null; offset: number | null} {
		const {editingId, editingCaretOffset} = useOutlineStore.getState();
		return {editingId, offset: editingCaretOffset};
	}

	async function run(command: "complete" | "delete" | "duplicate"): Promise<void> {
		act(() => {
			activeCommandRegistry()[command].execute({items: ["B"], zoomedId: null});
		});
		await settle();
	}

	async function undo(): Promise<void> {
		act(() => {
			activeCommandRegistry().undo.execute({items: [], zoomedId: null});
		});
		await settle();
		await settle();
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

	afterEach(() => {
		act(() => {
			root?.unmount();
		});
		root = undefined;
		document.body.replaceChildren();
		vi.unstubAllGlobals();
	});

	describe("⌘Z after a command that moves the caret", () => {
		it("returns the caret to the completed row at its old offset", async () => {
			await mountEditingB();
			await run("complete");
			expect(edited().editingId).not.toBe("B");

			await undo();

			expect(edited()).toStrictEqual({editingId: "B", offset: 3});
		});

		it("returns the caret to the restored row after a delete", async () => {
			await mountEditingB();
			await run("delete");
			expect(edited().editingId).not.toBe("B");

			await undo();

			expect(edited()).toStrictEqual({editingId: "B", offset: 3});
		});

		it("returns the caret to the duplicated row", async () => {
			await mountEditingB();
			await run("duplicate");

			await undo();

			expect(edited()).toStrictEqual({editingId: "B", offset: 3});
		});
	});
});

describe("undo edited note", () => {
	function row(id: string, name: string, priority: number, note: string | null = null): NodeResponse {
		return {
			id,
			parent_id: null,
			name,
			note,
			priority,
			data: {layoutMode: null},
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

	async function settle(): Promise<void> {
		await act(async () => {
			await new Promise((resolve) => {
				setTimeout(resolve, 50);
			});
		});
	}

	function answer(url: string, init: RequestInit | undefined): Response {
		if (url.endsWith("/api/v1/nodes")) {
			return Response.json({nodes: [...server.values()]});
		}
		if (url.endsWith("/api/v1/nodes/children")) {
			return Response.json({children: {}});
		}
		const id = /\/api\/v1\/nodes\/([^/?]+)$/u.exec(url)?.[1];
		const node = id === undefined ? undefined : server.get(id);
		if (node === undefined) {
			return Response.json({}, {status: 404});
		}
		if (init?.method === "POST" && typeof init.body === "string") {
			const body = JSON.parse(init.body) as {name?: string; note?: string | null};
			const updated = {
				...node,
				...(body.name === undefined ? {} : {name: body.name}),
				...(body.note === undefined ? {} : {note: body.note}),
			};
			server.set(updated.id, updated);
			return Response.json(updated);
		}
		return Response.json(node);
	}

	/** Mounts the outline over `rows` with `noteId`'s note focused. */
	async function mountNote(rows: NodeResponse[], noteId: string): Promise<void> {
		server = new Map(rows.map((node) => [node.id, node]));
		queryClient = new QueryClient({defaultOptions: {queries: {retry: false, staleTime: Number.POSITIVE_INFINITY}}});
		queryClient.setQueryData(nodeKeys.children(null), rows);
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
			useOutlineStore.getState().focusNote(noteId, 2);
		});
		await settle();
	}

	function noteElement(): HTMLElement {
		const element = document.querySelector<HTMLElement>(".notes .content");
		if (element === null) {
			throw new Error("no note editor");
		}
		return element;
	}

	/** Types into the focused note the way the browser does: set the DOM, fire input. */
	async function typeNote(text: string): Promise<void> {
		const element = noteElement();
		element.textContent = text;
		act(() => {
			element.dispatchEvent(new Event("input", {bubbles: true}));
		});
		await settle();
		await act(async () => {
			await new Promise((resolve) => {
				setTimeout(resolve, 600);
			});
		});
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

	afterEach(() => {
		act(() => {
			root?.unmount();
		});
		root = undefined;
		document.body.replaceChildren();
		vi.unstubAllGlobals();
	});

	describe("⌘Z while a note is focused", () => {
		it("re-renders the note with the undone text so the next keystroke cannot re-save the undone text", async () => {
			await mountNote([row("alice", "Alice", 0, "note text")], "alice");
			await typeNote("noQte text");
			expect(server.get("alice")?.note).toBe("noQte text");

			act(() => {
				activeCommandRegistry().undo.execute({items: [], zoomedId: null});
			});
			await settle();
			await settle();

			expect(server.get("alice")?.note).toBe("note text");
			expect(noteElement().textContent).toBe("note text");

			await typeNote(`${noteElement().textContent}Z`);
			expect(server.get("alice")?.note).toBe("note textZ");
		});

		it("puts the caret back at the offset saved with the step", async () => {
			await mountNote([row("alice", "Alice", 0, "note text")], "alice");
			undoHistory.push({
				ops: [{kind: "edit", nodeId: "alice", field: "note", before: "note text", after: "noQte text"}],
				before: {
					zoomedNodeId: null,
					editing: {nodeId: "alice", field: "note", start: 3, end: 3},
					selectedIds: [],
				},
				after: {
					zoomedNodeId: null,
					editing: {nodeId: "alice", field: "note", start: 10, end: 10},
					selectedIds: [],
				},
			});

			act(() => {
				activeCommandRegistry().undo.execute({items: [], zoomedId: null});
			});
			await settle();
			await settle();

			const content = activeNoteContent();
			expect(content === null ? null : selectionTextOffsets(content)).toStrictEqual({start: 3, end: 3});
		});
	});
});

describe("undo edited row", () => {
	function row(id: string, name: string, priority: number): NodeResponse {
		return {
			id,
			parent_id: null,
			name,
			note: null,
			priority,
			data: {layoutMode: null},
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

	async function settle(): Promise<void> {
		await act(async () => {
			await new Promise((resolve) => {
				setTimeout(resolve, 50);
			});
		});
	}

	function answer(url: string, init: RequestInit | undefined): Response {
		if (url.endsWith("/api/v1/nodes")) {
			return Response.json({nodes: [...server.values()]});
		}
		if (url.endsWith("/api/v1/nodes/children")) {
			return Response.json({children: {}});
		}
		const id = /\/api\/v1\/nodes\/([^/?]+)$/u.exec(url)?.[1];
		const node = id === undefined ? undefined : server.get(id);
		if (node === undefined) {
			return Response.json({}, {status: 404});
		}
		if (init?.method === "POST" && typeof init.body === "string") {
			const {name} = JSON.parse(init.body) as {name?: string};
			const updated = name === undefined ? node : {...node, name};
			server.set(updated.id, updated);
			return Response.json(updated);
		}
		return Response.json(node);
	}

	/** Mounts the outline over `rows` with `editingId`'s name editor open and its caret at `caret`. */
	async function mountEditing(rows: NodeResponse[], editingId: string, caret: number): Promise<void> {
		server = new Map(rows.map((node) => [node.id, node]));
		queryClient = new QueryClient({defaultOptions: {queries: {retry: false, staleTime: Number.POSITIVE_INFINITY}}});
		queryClient.setQueryData(nodeKeys.children(null), rows);
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
			useOutlineStore.getState().resumeEditing(editingId, caret);
		});
		await settle();
	}

	function editing(nodeId: string, offset: number, end = offset): ViewState {
		return {zoomedNodeId: null, editing: {nodeId, field: "name", start: offset, end}, selectedIds: []};
	}

	/** The edited row's name editor: its text, whether it has focus, and the caret offset in it. */
	function editor(nodeId: string): {text: string | null; focused: boolean; caret: number | null} {
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

	async function undo(): Promise<void> {
		act(() => {
			activeCommandRegistry().undo.execute({items: [], zoomedId: null});
		});
		await settle();
		await settle();
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

	afterEach(() => {
		act(() => {
			root?.unmount();
		});
		root = undefined;
		document.body.replaceChildren();
		vi.unstubAllGlobals();
	});

	describe("⌘Z on the row being edited", () => {
		it("restores the whole selection range saved with the step, not just a caret", async () => {
			await mountEditing([row("alice", "Alice q", 0)], "alice", 7);
			undoHistory.push({
				ops: [{kind: "edit", nodeId: "alice", field: "name", before: "Alice", after: "Alice q"}],
				before: editing("alice", 1, 4),
				after: editing("alice", 7),
			});

			await undo();

			const selection = globalThis.getSelection();
			expect({
				text: selection?.toString(),
				anchor: selection?.anchorOffset,
				focus: selection?.focusOffset,
			}).toStrictEqual({text: "lic", anchor: 1, focus: 4});
		});

		it("shows the undone text in the editor and keeps the caret in the row", async () => {
			await mountEditing([row("alice", "Alice q", 0)], "alice", 7);
			undoHistory.push({
				ops: [{kind: "edit", nodeId: "alice", field: "name", before: "Alice", after: "Alice q"}],
				before: editing("alice", 5),
				after: editing("alice", 7),
			});

			await undo();

			expect(editor("alice")).toStrictEqual({text: "Alice", focused: true, caret: 5});
		});

		it("after Enter and typing, the first ⌘Z empties the new row and keeps the caret in it", async () => {
			await mountEditing([row("alice", "Alice", 0), row("yank", "Yank", 1)], "yank", 4);
			undoHistory.push({
				ops: [{kind: "edit", nodeId: "yank", field: "name", before: "", after: "Yank"}],
				before: editing("yank", 4),
				after: editing("yank", 4),
			});

			await undo();

			expect(editor("yank")).toStrictEqual({text: "", focused: true, caret: 0});
		});
	});
});
