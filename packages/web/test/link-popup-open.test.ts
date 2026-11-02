// @vitest-environment happy-dom
import {afterEach, describe, expect, it} from "vite-plus/test";
import {readLinkPopupTarget, toolbarLinkTarget} from "../src/client/link-popup-open.js";

afterEach(() =>
{
	document.body.innerHTML = "";
});

const NAME =
	'Plain alpha beta <a class="contentLink" target="_blank" rel="noreferrer" href="https://e.com/">example</a> tail';

function row(): HTMLElement
{
	document.body.innerHTML = `<span class="innerContentContainer editing" data-node-id="n1" contenteditable="true">${NAME}</span>`;
	return document.querySelector<HTMLElement>(".innerContentContainer")!;
}

function select(start: Node, startOffset: number, end: Node = start, endOffset = startOffset): void
{
	const range = document.createRange();
	range.setStart(start, startOffset);
	range.setEnd(end, endOffset);
	const selection = globalThis.getSelection()!;
	selection.removeAllRanges();
	selection.addRange(range);
}

describe("readLinkPopupTarget", () =>
{
	it("opens a new link over a selection clear of links, with the stored html snapshot", () =>
	{
		const root = row();
		select(root.firstChild!, 6, root.firstChild!, 11);

		expect(readLinkPopupTarget("n1")).toMatchObject(
			{
				nodeId: "n1",
				field: "name",
				html: 'Plain alpha beta <a href="https://e.com/">example</a> tail',
				start: 6,
				end: 11,
				text: "alpha",
				href: "",
				existing: false,
			},
		);
	});

	it("edits the link under a collapsed caret, prefilled with its text and href", () =>
	{
		const root = row();
		select(root.querySelector("a")!.firstChild!, 2);

		expect(readLinkPopupTarget("n1")).toMatchObject(
			{
				start: 17,
				end: 24,
				text: "example",
				href: "https://e.com/",
				existing: true,
			},
		);
	});

	it("leaves a selection that touches a link, and a caret outside one, to the Jump menu", () =>
	{
		const root = row();
		select(root.firstChild!, 12, root.querySelector("a")!.firstChild!, 3);
		const touching = readLinkPopupTarget("n1");
		select(root.firstChild!, 3);
		const outside = readLinkPopupTarget("n1");

		expect(
			{
				touching,
				outside,
			},
		).toStrictEqual(
			{
				touching: null,
				outside: null,
			},
		);
	});
});

describe("toolbarLinkTarget", () =>
{
	it("opens nothing when the selection touches a link, like upstream's inert toolbar button", () =>
	{
		const root = row();
		select(root.firstChild!, 12, root.querySelector("a")!.firstChild!, 3);
		const touching = toolbarLinkTarget("n1");
		select(root.firstChild!, 6, root.firstChild!, 11);
		const clear = toolbarLinkTarget("n1");

		expect(
			{
				touching,
				clearText: clear?.text,
			},
		).toStrictEqual(
			{
				touching: null,
				clearText: "alpha",
			},
		);
	});
});
