// @vitest-environment happy-dom
import {afterEach, beforeAll, describe, expect, it, vi} from "vite-plus/test";
import type {Root} from "react-dom/client";

declare global
{
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const mutate = vi.fn<(request: {nodeId: string; note?: string}) => void>();
vi.mock("../src/client/hooks/use-nodes.js", async () =>
{
	const {noopMutation} = await import("./helpers/stable-mutation.js");
	const updateNode =
	{
		...noopMutation,
		mutate,
	};
	return {
		useUpdateNode: () => updateNode,
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
	useTagColors: () => ({}),
}));

const {act, createElement} = await import("react");
const {createRoot} = await import("react-dom/client");
const {QueryClient, QueryClientProvider} = await import("@tanstack/react-query");
const {EditableNote} = await import("../src/client/components/editable-note.js");
const {resetPopupsForTests} = await import("../src/client/popups.js");

let root: Root | undefined;

beforeAll(() =>
{
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
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
	document.body.innerHTML = "";
	resetPopupsForTests();
	mutate.mockClear();
});

function mountNote(): HTMLElement
{
	const host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
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
						initialValue: "SX note",
						isFocused: false,
					},
				),
			),
		);
	});
	const editor = host.querySelector<HTMLElement>("[contenteditable]");
	if (!editor)
	{
		throw new Error("no note editor");
	}
	return editor;
}

function typeAtEnd(editor: HTMLElement, text: string): void
{
	act(() =>
	{
		editor.focus();
	});
	const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
	let node = walker.nextNode();
	while (node !== null && !node.textContent?.includes("SX note"))
	{
		node = walker.nextNode();
	}
	if (!node)
	{
		throw new Error("no text node");
	}
	node.textContent = `${node.textContent}${text}`;
	const range = document.createRange();
	range.setStart(node, node.textContent.length);
	range.collapse(true);
	const selection = globalThis.getSelection();
	selection?.removeAllRanges();
	selection?.addRange(range);
	act(() =>
	{
		editor.dispatchEvent(
			new InputEvent(
				"input",
				{
					bubbles: true,
					data: text,
					inputType: "insertText",
				},
			),
		);
	});
}

describe("note date autocomplete", () =>
{
	it("offers a flyout for a typed date phrase and converts it to a pill on Tab", () =>
	{
		const editor = mountNote();
		typeAtEnd(editor, " tomorrow");
		expect(document.querySelector(".flyout")?.textContent).toContain("Press Tab or click here");
		act(() =>
		{
			window.dispatchEvent(
				new KeyboardEvent(
					"keydown",
					{
						key: "Tab",
						bubbles: true,
						cancelable: true,
					},
				),
			);
		});
		expect(document.querySelector(".flyout")).toBeNull();
		const saved = mutate.mock.calls.at(-1)?.[0].note ?? "";
		expect(saved).toContain("<time startYear=");
	});

	it("hides the flyout on blur", () =>
	{
		const editor = mountNote();
		typeAtEnd(editor, " tomorrow");
		act(() =>
		{
			editor.blur();
		});
		expect(document.querySelector(".flyout")).toBeNull();
	});
});
