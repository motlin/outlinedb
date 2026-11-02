// @vitest-environment happy-dom
import {afterEach, beforeAll, describe, expect, it, vi} from "vite-plus/test";
import type {Root} from "react-dom/client";

declare global
{
	// React reads this to know act() wraps every update.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

// A fresh `mutate` on every render: the editors must not rebuild their savers (and re-run editing-start) per render.
const saves: unknown[] = [];
vi.mock("../src/client/hooks/use-nodes.js", () =>
{
	const mutation = () => (
	{
		mutate: (update: unknown) =>
		{
			saves.push(update);
		},
	});
	return {
		useCreateNode: mutation,
		useDeleteNode: mutation,
		useMoveNode: mutation,
		useUpdateNode: mutation,
	};
});
vi.mock("../src/client/hooks/use-commit-search.js", () => (
{
	usePaneTagSearch: () => () =>
	{
	},
}));

const {act, createElement} = await import("react");
const {createRoot} = await import("react-dom/client");
const {QueryClient, QueryClientProvider} = await import("@tanstack/react-query");
const {editableText} = await import("../src/client/components/editable-text.js");
const {EditableNote} = await import("../src/client/components/editable-note.js");
const {caretTextOffset, placeCaretAtTextOffset} = await import("../src/client/caret-dom.js");

let root: Root | undefined;
const client = new QueryClient();

beforeAll(() =>
{
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() =>
{
	act(() =>
	{
		root?.unmount();
	});
	root = undefined;
	saves.length = 0;
	document.body.innerHTML = "";
	vi.restoreAllMocks();
});

function render(element: ReturnType<typeof createElement>): HTMLElement
{
	const container = document.createElement("div");
	document.body.append(container);
	root ??= createRoot(container);
	act(() =>
	{
		root?.render(
			createElement(
				QueryClientProvider,
				{
					client,
				},
				element,
			),
		);
	});
	return document.body;
}

const nameEditor = () =>
	createElement(
		editableText,
		{
			nodeId: "alice",
			initialValue: "Hello",
			parentId: null,
			priority: 0,
			isEditing: true,
		},
	);

describe("editors with an unstable mutate", () =>
{
	it("runs the name editor's editing-start effect once, keeping the caret across re-renders", () =>
	{
		const focus = vi.spyOn(HTMLElement.prototype, "focus");
		const body = render(nameEditor());
		const editor = body.querySelector<HTMLElement>(".innerContentContainer.editing");
		if (editor === null)
		{
			throw new Error("editor did not render");
		}
		placeCaretAtTextOffset(editor, 2);
		render(nameEditor());
		render(nameEditor());
		expect(
			{
				focusCalls: focus.mock.calls.length,
				caret: caretTextOffset(editor),
				saves,
			},
		).toStrictEqual(
			{
				focusCalls: 1,
				caret: 2,
				saves: [],
			},
		);
	});

	it("keeps the note's pending save pending across re-renders", () =>
	{
		const note = () =>
			createElement(
				EditableNote,
				{
					nodeId: "alice",
					initialValue: "Hi",
					isFocused: true,
				},
			);
		const body = render(note());
		const editor = body.querySelector<HTMLElement>(".notes .content");
		if (editor === null)
		{
			throw new Error("note editor did not render");
		}
		editor.textContent = "Hi there";
		placeCaretAtTextOffset(editor, 8);
		act(() =>
		{
			editor.dispatchEvent(
				new InputEvent(
					"input",
					{
						bubbles: true,
						inputType: "insertText",
						data: "e",
					},
				),
			);
		});
		render(note());
		expect(saves).toStrictEqual([]);
	});
});
