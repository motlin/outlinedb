// @vitest-environment happy-dom
import {afterEach, beforeAll, describe, expect, it, vi} from "vite-plus/test";
import type {Root} from "react-dom/client";

declare global
{
	// React reads this to know act() wraps every update.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const saves:
{
	nodeId: string;
	note: string;
}[] = [];

vi.mock("../src/client/hooks/use-nodes.js", () => (
{
	useUpdateNode: () => (
	{
		mutate: (update: {nodeId: string; note: string}) =>
		{
			saves.push(update);
		},
	}),
}));

const {act, createElement} = await import("react");
const {createRoot} = await import("react-dom/client");
const {QueryClient, QueryClientProvider} = await import("@tanstack/react-query");
const {EditableNote} = await import("../src/client/components/editable-note.js");
const {caretTextOffset, placeCaretAtTextOffset} = await import("../src/client/caret-dom.js");

const PILL = '<time startYear="2026" startMonth="10" startDay="1">Thu, Oct 1, 2026</time>';

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
	saves.length = 0;
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

function pressKey(editor: HTMLElement, key: string): boolean
{
	const event = new KeyboardEvent(
		"keydown",
		{
			key,
			bubbles: true,
			cancelable: true,
		},
	);
	act(() =>
	{
		editor.dispatchEvent(event);
	});
	return event.defaultPrevented;
}

function noteState(editor: HTMLElement):
{
	pills: number;
	text: string;
	caret: number;
}
{
	return {
		pills: editor.querySelectorAll("time").length,
		text: editor.textContent.replaceAll("﻿", ""),
		caret: caretTextOffset(editor),
	};
}

describe("EditableNote atomic date-pill deletion", () =>
{
	it("removes the whole pill on Backspace right after it and saves", () =>
	{
		const editor = mountNote(`due ${PILL} tail`);
		placeCaretAtTextOffset(editor, 5);
		const prevented = pressKey(editor, "Backspace");
		expect(
			{
				prevented,
				...noteState(editor),
				saves,
			},
		).toStrictEqual(
			{
				prevented: true,
				pills: 0,
				text: "due  tail",
				caret: 4,
				saves: [
					{
						nodeId: "alice",
						note: "due  tail",
					},
				],
			},
		);
	});

	it("removes the whole pill on Delete right before it and saves", () =>
	{
		const editor = mountNote(`due ${PILL} tail`);
		placeCaretAtTextOffset(editor, 4);
		const prevented = pressKey(editor, "Delete");
		expect(
			{
				prevented,
				...noteState(editor),
				saves,
			},
		).toStrictEqual(
			{
				prevented: true,
				pills: 0,
				text: "due  tail",
				caret: 4,
				saves: [
					{
						nodeId: "alice",
						note: "due  tail",
					},
				],
			},
		);
	});

	it("leaves Backspace to the browser when no pill is adjacent", () =>
	{
		const editor = mountNote(`due ${PILL} tail`);
		placeCaretAtTextOffset(editor, 3);
		const prevented = pressKey(editor, "Backspace");
		expect(
			{
				prevented,
				pills: editor.querySelectorAll("time").length,
				saves,
			},
		).toStrictEqual(
			{
				prevented: false,
				pills: 1,
				saves: [],
			},
		);
	});
});
