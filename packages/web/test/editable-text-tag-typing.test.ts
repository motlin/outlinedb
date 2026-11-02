// @vitest-environment happy-dom
import {afterEach, beforeAll, describe, expect, it, vi} from "vite-plus/test";
import type {Root} from "react-dom/client";

declare global
{
	// React reads this to know act() wraps every update.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

vi.mock("../src/client/hooks/use-nodes.js", async () =>
{
	const {noopMutation} = await import("./helpers/stable-mutation.js");
	return {
		useCreateNode: () => noopMutation,
		useDeleteNode: () => noopMutation,
		useMoveNode: () => noopMutation,
		useUpdateNode: () => noopMutation,
	};
});
vi.mock("../src/client/hooks/use-commit-search.js", () => (
{
	usePaneTagSearch: () => () =>
	{
	},
}));
vi.mock("../src/client/hooks/use-tag-colors.js", () => (
{
	useRemoveTagColor: () => (
	{
		mutate: () =>
		{
		},
	}),
	useSetTagColor: () => (
	{
		mutate: () =>
		{
		},
	}),
	useTagColors: () => (
	{
		"@ellen": "red",
	}),
}));

const {act, createElement} = await import("react");
const {createRoot} = await import("react-dom/client");
const {QueryClient, QueryClientProvider} = await import("@tanstack/react-query");
const {editableText} = await import("../src/client/components/editable-text.js");
const {EditableNote} = await import("../src/client/components/editable-note.js");
const {caretTextOffset, placeCaretAtTextOffset} = await import("../src/client/caret-dom.js");

let root: Root | undefined;

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
	document.body.innerHTML = "";
});

function mountEditor(initialValue: string): HTMLElement
{
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	act(() =>
	{
		root?.render(
			createElement(
				QueryClientProvider,
				{
					client: new QueryClient(),
				},
				createElement(
					editableText,
					{
						nodeId: "alice",
						initialValue,
						parentId: null,
						priority: 0,
						isEditing: true,
					},
				),
			),
		);
	});
	const editor = container.querySelector<HTMLElement>(".innerContentContainer.editing");
	if (editor === null)
	{
		throw new Error("editor did not render");
	}
	return editor;
}

function mountNote(initialValue: string): HTMLElement
{
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	act(() =>
	{
		root?.render(
			createElement(
				QueryClientProvider,
				{
					client: new QueryClient(),
				},
				createElement(
					EditableNote,
					{
						nodeId: "alice",
						initialValue,
						isFocused: true,
					},
				),
			),
		);
	});
	const editor = container.querySelector<HTMLElement>(".notes .content");
	if (editor === null)
	{
		throw new Error("note editor did not render");
	}
	return editor;
}

/** Simulate the browser inserting `data` at the caret: the DOM text changes, then `input` fires. */
function typeText(editor: HTMLElement, text: string, data: string): void
{
	editor.textContent = text;
	placeCaretAtTextOffset(editor, text.length);
	act(() =>
	{
		editor.dispatchEvent(
			new InputEvent(
				"input",
				{
					bubbles: true,
					inputType: "insertText",
					data,
				},
			),
		);
	});
}

function tagsIn(editor: HTMLElement):
{
	val: string | undefined;
	text: string;
}[]
{
	return [...editor.querySelectorAll<HTMLElement>(".contentTag")].map((tag) => (
	{
		val: tag.dataset.val,
		text: tag.textContent,
	}));
}

describe("EditableText typed tag styling", () =>
{
	it("renders stored tags as contentTag spans while editing", () =>
	{
		const editor = mountEditor("Hi @Ellen there");
		expect(tagsIn(editor)).toStrictEqual([
			{
				val: "@ellen",
				text: "@Ellen",
			},
		]);
	});

	it("styles a typed mention on every keystroke while it is typed, like upstream", () =>
	{
		const editor = mountEditor("Hi");
		typeText(editor, "Hi @", "@");
		expect(tagsIn(editor)).toStrictEqual([]);
		typeText(editor, "Hi @E", "E");
		expect(
			{
				tags: tagsIn(editor),
				text: editor.textContent,
				caret: caretTextOffset(editor),
			},
		).toStrictEqual(
			{
				tags: [
					{
						val: "@e",
						text: "@E",
					},
				],
				text: "Hi @E",
				caret: 5,
			},
		);
		typeText(editor, "Hi @Ellen", "n");
		expect(
			{
				tags: tagsIn(editor),
				text: editor.textContent,
				caret: caretTextOffset(editor),
			},
		).toStrictEqual(
			{
				tags: [
					{
						val: "@ellen",
						text: "@Ellen",
					},
				],
				text: "Hi @Ellen",
				caret: 9,
			},
		);
		typeText(editor, "Hi @Ellen ", " ");
		expect(
			{
				tags: tagsIn(editor),
				text: editor.textContent,
				caret: caretTextOffset(editor),
			},
		).toStrictEqual(
			{
				tags: [
					{
						val: "@ellen",
						text: "@Ellen",
					},
				],
				text: "Hi @Ellen ",
				caret: 10,
			},
		);
	});
});

describe("EditableNote typed tag styling", () =>
{
	it("renders stored tags as contentTag spans while focused", () =>
	{
		const editor = mountNote("Hi #work there");
		expect(tagsIn(editor)).toStrictEqual([
			{
				val: "#work",
				text: "#work",
			},
		]);
	});

	it("styles a typed tag on every keystroke while it is typed, like upstream", () =>
	{
		const editor = mountNote("Hi");
		typeText(editor, "Hi\n#", "#");
		expect(tagsIn(editor)).toStrictEqual([]);
		typeText(editor, "Hi\n#w", "w");
		expect(
			{
				tags: tagsIn(editor),
				text: editor.textContent,
				caret: caretTextOffset(editor),
			},
		).toStrictEqual(
			{
				tags: [
					{
						val: "#w",
						text: "#w",
					},
				],
				text: "Hi\n#w",
				caret: 5,
			},
		);
		typeText(editor, "Hi\n#work ", " ");
		expect(
			{
				tags: tagsIn(editor),
				text: editor.textContent,
				caret: caretTextOffset(editor),
			},
		).toStrictEqual(
			{
				tags: [
					{
						val: "#work",
						text: "#work",
					},
				],
				text: "Hi\n#work ",
				caret: 9,
			},
		);
	});
});
