// @vitest-environment happy-dom
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {openLinkAtCaret} from "../src/client/content-link-click.js";

afterEach(() =>
{
	vi.restoreAllMocks();
	document.body.innerHTML = "";
});

function editor(html: string): HTMLElement
{
	document.body.innerHTML = `<div id="editor" contenteditable="true">${html}</div>`;
	return document.querySelector<HTMLElement>("#editor")!;
}

function caretIn(node: Node, offset: number, end = offset): void
{
	const range = document.createRange();
	range.setStart(node, offset);
	range.setEnd(node, end);
	const selection = globalThis.getSelection()!;
	selection.removeAllRanges();
	selection.addRange(range);
}

describe("openLinkAtCaret (Alt+Enter)", () =>
{
	it("opens the link under a collapsed caret through window.open and reports it handled", () =>
	{
		const open = vi.spyOn(globalThis, "open").mockReturnValue(null);
		const root = editor('Ext <a class="contentLink" href="https://example.com/page">example</a> tail');
		caretIn(root.querySelector("a")!.firstChild!, 2);

		expect(
			{
				handled: openLinkAtCaret(root),
				calls: open.mock.calls,
			},
		).toStrictEqual(
			{
				handled: true,
				calls: [["https://example.com/page"]],
			},
		);
	});

	it("falls through outside a link and over a selection", () =>
	{
		const open = vi.spyOn(globalThis, "open").mockReturnValue(null);
		const root = editor('Ext <a class="contentLink" href="https://example.com/page">example</a> tail');
		caretIn(root.firstChild!, 1);
		const outside = openLinkAtCaret(root);
		caretIn(root.querySelector("a")!.firstChild!, 1, 4);
		const selected = openLinkAtCaret(root);

		expect(
			{
				outside,
				selected,
				calls: open.mock.calls.length,
			},
		).toStrictEqual(
			{
				outside: false,
				selected: false,
				calls: 0,
			},
		);
	});

	it("routes an internal link through the click handler instead of window.open", () =>
	{
		const open = vi.spyOn(globalThis, "open").mockReturnValue(null);
		const root = editor('<a class="contentLink" href="https://workflowy.com/#/0123456789ab">item</a>');
		const clicks: string[] = [];
		document.addEventListener(
			"click",
			(event) =>
			{
				clicks.push((event.target as Element).tagName);
			},
			{
				once: true,
			},
		);
		caretIn(root.querySelector("a")!.firstChild!, 1);

		expect(
			{
				handled: openLinkAtCaret(root),
				clicks,
				opens: open.mock.calls.length,
			},
		).toStrictEqual(
			{
				handled: true,
				clicks: ["A"],
				opens: 0,
			},
		);
	});
});
