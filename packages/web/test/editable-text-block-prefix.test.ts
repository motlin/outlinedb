// @vitest-environment happy-dom
import {afterEach, beforeAll, describe, expect, it, vi} from "vite-plus/test";
import type {Root} from "react-dom/client";
import type {NodeResponse} from "../src/node-types.js";

declare global
{
	// React reads this to know act() wraps every update.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const calls:
{
	kind: string;
	args: unknown;
}[] = [];
const record = (kind: string) => (
{
	mutate: (args: unknown): void =>
	{
		calls.push(
			{
				kind,
				args,
			},
		);
	},
});
const updateMutation = record("update");
const createMutation = record("create");
const noop =
{
	mutate: (): void =>
	{
	},
};

vi.mock("../src/client/hooks/use-nodes.js", () => (
{
	useCreateNode: () => createMutation,
	useDeleteNode: () => noop,
	useMoveNode: () => noop,
	useUpdateNode: () => updateMutation,
	toggleComplete: (_queryClient: unknown, args: unknown) =>
	{
		calls.push(
			{
				kind: "toggle",
				args,
			},
		);
	},
}));
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
	useTagColors: () => ({}),
}));

const {act, createElement} = await import("react");
const {createRoot} = await import("react-dom/client");
const {QueryClient, QueryClientProvider} = await import("@tanstack/react-query");
const {editableText} = await import("../src/client/components/editable-text.js");
const {EditableNote} = await import("../src/client/components/editable-note.js");
const {caretTextOffset, placeCaretAtTextOffset} = await import("../src/client/caret-dom.js");
const {nodeKeys} = await import("../src/client/node-cache.js");

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
	calls.length = 0;
});

function row(
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
		...partial,
	};
}

function mount(node: React.ReactElement, siblings: NodeResponse[]): HTMLElement
{
	const queryClient = new QueryClient();
	queryClient.setQueryData(nodeKeys.children("p"), siblings);
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
				node,
			),
		);
	});
	const editor = container.querySelector<HTMLElement>(".innerContentContainer.editing, .notes .content");
	if (editor === null)
	{
		throw new Error("editor did not render");
	}
	return editor;
}

function mountRow(siblings: NodeResponse[], initialValue: string): HTMLElement
{
	return mount(
		createElement(
			editableText,
			{
				nodeId: "alice",
				initialValue,
				parentId: "p",
				priority: 100,
				isEditing: true,
			},
		),
		siblings,
	);
}

/** Simulate the browser inserting `data` at the caret: the DOM text changes, then `input` fires. */
function typeText(editor: HTMLElement, text: string, data: string, caret = text.length): void
{
	editor.textContent = text;
	placeCaretAtTextOffset(editor, caret);
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

describe("EditableText block prefixes", () =>
{
	it("turns [x] typed at the start into a completed to-do and keeps the caret at 0", () =>
	{
		const editor = mountRow(
			[
				row(
					{
						id: "alice",
						name: "task",
						priority: 100,
					},
				),
			],
			"task",
		);
		typeText(editor, "[x] task", " ", 4);
		expect(
			{
				calls,
				text: editor.textContent,
				caret: caretTextOffset(editor),
			},
		).toStrictEqual(
			{
				calls: [
					{
						kind: "update",
						args:
						{
							nodeId: "alice",
							name: "task",
							layoutMode: "todo",
						},
					},
					{
						kind: "toggle",
						args:
						{
							nodeId: "alice",
							isCurrentlyCompleted: false,
						},
					},
				],
				text: "task",
				caret: 0,
			},
		);
	});

	it("turns 3. into a numbered list starting at 3", () =>
	{
		const editor = mountRow(
			[
				row(
					{
						id: "alice",
						priority: 100,
					},
				),
			],
			"",
		);
		typeText(editor, "3. ", " ");
		expect(
			{
				calls,
				text: editor.textContent,
			},
		).toStrictEqual(
			{
				calls: [
					{
						kind: "update",
						args:
						{
							nodeId: "alice",
							name: "",
							layoutMode: "numbered",
							numberedStart: 3,
						},
					},
				],
				text: "",
			},
		);
	});

	it("creates a divider above the row for - - - typed before text", () =>
	{
		const editor = mountRow(
			[
				row(
					{
						id: "first",
						priority: 50,
					},
				),
				row(
					{
						id: "alice",
						name: "abc",
						priority: 100,
					},
				),
			],
			"abc",
		);
		typeText(editor, "- - - abc", " ", 6);
		expect(
			{
				calls,
				text: editor.textContent,
				caret: caretTextOffset(editor),
			},
		).toStrictEqual(
			{
				calls: [
					{
						kind: "update",
						args:
						{
							nodeId: "alice",
							name: "abc",
						},
					},
					{
						kind: "create",
						args:
						{
							parent_id: "p",
							index: 1,
							name: "",
							layoutMode: "divider",
						},
					},
				],
				text: "abc",
				caret: 0,
			},
		);
	});

	it("leaves a prefix typed in the middle of the text alone", () =>
	{
		const editor = mountRow(
			[
				row(
					{
						id: "alice",
						name: "ab",
						priority: 100,
					},
				),
			],
			"ab",
		);
		typeText(editor, "ab[] ", " ");
		expect(
			{
				calls,
				text: editor.textContent,
			},
		).toStrictEqual(
			{
				calls: [],
				text: "ab[] ",
			},
		);
	});

	it("leaves [] typed into a note alone", () =>
	{
		const editor = mount(
			createElement(
				EditableNote,
				{
					nodeId: "alice",
					initialValue: "",
					isFocused: true,
				},
			),
			[
				row(
					{
						id: "alice",
					},
				),
			],
		);
		typeText(editor, "[] ", " ");
		expect(
			{
				calls,
				text: editor.textContent,
			},
		).toStrictEqual(
			{
				calls: [],
				text: "[] ",
			},
		);
	});
});
