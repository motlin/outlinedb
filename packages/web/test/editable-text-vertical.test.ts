// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {act, createElement} from "react";
import {createRoot} from "react-dom/client";
import type {Root} from "react-dom/client";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {editableText} from "../src/client/components/editable-text.js";
import {nodeKeys} from "../src/client/node-cache.js";
import {useOutlineStore} from "../src/client/stores/outline.js";
import type {NodeResponse} from "../src/node-types.js";

declare global
{
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let root: Root | undefined;

beforeEach(() =>
{
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
	useOutlineStore.setState(useOutlineStore.getInitialState(), true);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Promise.resolve(Response.json({}))),
	);
});

afterEach(() =>
{
	act(() =>
	{
		root?.unmount();
	});
	root = undefined;
	vi.unstubAllGlobals();
});

function row(id: string, name: string): NodeResponse
{
	return {
		id,
		parent_id: "zoom",
		name,
		note: null,
		priority: 0,
		data:
		{
			layoutMode: null,
		},
		createdAt: null,
		modifiedAt: null,
		completedAt: null,
	};
}

/** Mounts row A's editor under a zoom root whose children are A and B, editing `editingId`. */
function mountEditing(editingId: string): HTMLElement
{
	const queryClient = new QueryClient();
	queryClient.setQueryData(nodeKeys.children("zoom"), [row("A", "Alpha"), row("B", "Bravo")]);
	useOutlineStore.setState(
		{
			zoomedNodeId: "zoom",
			expandedIds: new Set(),
			showCompleted: true,
			editingId,
			editingCaretOffset: 3,
		},
	);
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	const name = editingId === "A" ? "Alpha" : "Bravo";
	act(() =>
	{
		root?.render(
			createElement(
				QueryClientProvider,
				{
					client: queryClient,
				},
				createElement(
					editableText,
					{
						nodeId: editingId,
						initialValue: name,
						parentId: "zoom",
						priority: 0,
						isEditing: true,
					},
				),
			),
		);
	});
	const editor = container.querySelector<HTMLElement>("[contenteditable]");
	if (!editor)
	{
		throw new Error("no editor mounted");
	}
	return editor;
}

function arrowDown(editor: HTMLElement): KeyboardEvent
{
	const event = new KeyboardEvent(
		"keydown",
		{
			key: "ArrowDown",
			bubbles: true,
			cancelable: true,
		},
	);
	act(() =>
	{
		editor.dispatchEvent(event);
	});
	return event;
}

describe("Down at a row's last line", () =>
{
	it("continues in the next row at offset 0, not x-preserving or select-all", () =>
	{
		arrowDown(mountEditing("A"));
		const {editingId, editingCaretOffset} = useOutlineStore.getState();
		expect(
			{
				editingId,
				editingCaretOffset,
			},
		).toStrictEqual(
			{
				editingId: "B",
				editingCaretOffset: 0,
			},
		);
	});

	it("is left native on the last row", () =>
	{
		const event = arrowDown(mountEditing("B"));
		expect(
			{
				defaultPrevented: event.defaultPrevented,
				editingId: useOutlineStore.getState().editingId,
			},
		).toStrictEqual(
			{
				defaultPrevented: false,
				editingId: "B",
			},
		);
	});
});
