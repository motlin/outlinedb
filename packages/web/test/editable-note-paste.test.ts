// @vitest-environment happy-dom
import {afterEach, beforeAll, describe, expect, it, vi} from "vite-plus/test";
import type {Root} from "react-dom/client";

declare global
{
	// React reads this to know act() wraps every update.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

vi.mock("../src/client/hooks/use-nodes.js", () => (
{
	useUpdateNode: () => (
	{
		mutate: () =>
		{
		},
	}),
}));

const {act, createElement} = await import("react");
const {createRoot} = await import("react-dom/client");
const {QueryClient, QueryClientProvider} = await import("@tanstack/react-query");
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
	act(() =>
	{
		editor.focus();
	});
	return editor;
}

function paste(editor: HTMLElement, data: Record<string, string>): boolean
{
	const event = new Event(
		"paste",
		{
			bubbles: true,
			cancelable: true,
		},
	);
	Object.defineProperty(
		event,
		"clipboardData",
		{
			value:
			{
				getData: (type: string) => data[type] ?? "",
				files: [],
			},
		},
	);
	act(() =>
	{
		editor.dispatchEvent(event);
	});
	return event.defaultPrevented;
}

describe("EditableNote paste", () =>
{
	it("inserts escaped plain text with newlines in place and puts the caret after it (U12)", () =>
	{
		const editor = mountNote("n");
		placeCaretAtTextOffset(editor, 1);
		const prevented = paste(
			editor,
			{
				"text/plain": "l1\nl2 <x> & y\n- l3",
			},
		);
		expect(
			{
				prevented,
				text: editor.textContent,
				caret: caretTextOffset(editor),
				busy: editor.className,
			},
		).toStrictEqual(
			{
				prevented: true,
				text: "nl1\nl2 <x> & y\n- l3",
				caret: 19,
				busy: expect.not.stringContaining("copyOrPasteInProgress"),
			},
		);
	});

	it("keeps bold and drops list and paragraph tags from html (U13)", () =>
	{
		const editor = mountNote("n");
		placeCaretAtTextOffset(editor, 1);
		paste(
			editor,
			{
				"text/plain": "l1\nl2 x B\nl3",
				"text/html": "<p>l1</p><p>l2 &lt;x&gt; <b>B</b></p><ul><li>l3</li></ul>",
			},
		);
		expect(
			{
				text: editor.textContent,
				bold: [...editor.querySelectorAll("b")].map((bold) => bold.textContent),
				blocks: editor.querySelectorAll("p, ul, li").length,
			},
		).toStrictEqual(
			{
				text: "nl1\n\nl2 <x> B\n\nl3",
				bold: ["B"],
				blocks: 0,
			},
		);
	});
});
