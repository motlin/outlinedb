// @vitest-environment happy-dom
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {openLinkAtCaret} from "../src/client/content-link-click.js";
import
{
	applyLinkToHtml,
	canApply,
	canUnlink,
	linkPopupTrigger,
	normalizeLinkHref,
	unlinkInHtml,
} from "../src/client/link-popup-model.js";
import {readLinkPopupTarget, toolbarLinkTarget} from "../src/client/link-popup-open.js";
import {installLinkStatusBar} from "../src/client/link-status-bar.js";

describe("link alt enter", () =>
{
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
});

describe("link popup model", () =>
{
	describe("normalizeLinkHref", () =>
	{
		it.each([
			["example.org/x", "https://example.org/x"],
			[" http://a.b ", "http://a.b"],
			["ftp://x", "ftp://x"],
			["message:<a@b>", "message:%3Ca@b%3E"],
			["message:abc", "message:abc"],
			["mailto:a@b.c", "https://mailto:a@b.c"],
		])("%s -> %s", (raw, expected) =>
		{
			expect(normalizeLinkHref(raw)).toBe(expected);
		});
	});

	describe("canApply and canUnlink", () =>
	{
		it("needs both a text and an href", () =>
		{
			expect([canApply("a", "b"), canApply(" ", "b"), canApply("a", " ")]).toStrictEqual([true, false, false]);
		});

		it("hides Unlink when the text is itself exactly one URL", () =>
		{
			expect([canUnlink("https://x.com"), canUnlink("alpha"), canUnlink("see https://x.com")]).toStrictEqual([
				false,
				true,
				true,
			]);
		});
	});

	describe("linkPopupTrigger", () =>
	{
		it.each([
			[
				{
					collapsed: false,
					selectionTouchesLink: false,
					caretInLink: false,
				},
				"new",
			],
			[
				{
					collapsed: false,
					selectionTouchesLink: true,
					caretInLink: false,
				},
				null,
			],
			[
				{
					collapsed: true,
					selectionTouchesLink: false,
					caretInLink: true,
				},
				"edit",
			],
			[
				{
					collapsed: true,
					selectionTouchesLink: false,
					caretInLink: false,
				},
				null,
			],
		] as const)("%j -> %s", (input, expected) =>
		{
			expect(linkPopupTrigger(input)).toBe(expected);
		});
	});

	describe("applyLinkToHtml", () =>
	{
		it("wraps the selected range in a link and puts the caret after the old end", () =>
		{
			expect(applyLinkToHtml("Plain alpha beta", 6, 11, "alpha", "https://example.org/x", false)).toStrictEqual(
				{
					html: 'Plain <a href="https://example.org/x">alpha</a> beta',
					caret: 12,
				},
			);
		});

		it("rewrites an existing link's text and href", () =>
		{
			expect(applyLinkToHtml('Plain <a href="h">alpha</a> beta', 6, 11, "alpha two", "h2", true)).toStrictEqual(
				{
					html: 'Plain <a href="h2">alpha two</a> beta',
					caret: 12,
				},
			);
		});
	});

	describe("unlinkInHtml", () =>
	{
		it("keeps the text and drops the anchor", () =>
		{
			expect(unlinkInHtml('Plain <a href="h">alpha</a> beta', 6)).toBe("Plain alpha beta");
		});
	});
});

describe("link popup open", () =>
{
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
});

describe("link status bar", () =>
{
	let uninstall: (() => void) | undefined;

	afterEach(() =>
	{
		uninstall?.();
		uninstall = undefined;
		document.body.innerHTML = "";
	});

	describe("installLinkStatusBar", () =>
	{
		it("appends upstream's fixed bottom-left bar, hidden until a link is hovered", () =>
		{
			uninstall = installLinkStatusBar(document);
			const bar = document.body.lastElementChild as HTMLElement;

			expect(
				[
					"position: fixed",
					"bottom: 0px",
					"left: 0px",
					"z-index: 1000",
					"font-size: 12px",
					"padding: 2px 5px",
					"opacity: 0",
					"transition: opacity 0.3s",
					"color: rgb(60, 64, 67)",
					"background: rgb(222, 225, 230)",
				].filter((part) => !bar.style.cssText.includes(part)),
			).toStrictEqual([]);
		});

		it("shows the hovered link's href and hides on leave and on hashchange", () =>
		{
			document.body.innerHTML = '<a class="contentLink" href="https://example.com/page">example</a>';
			uninstall = installLinkStatusBar(document);
			const bar = document.body.lastElementChild as HTMLElement;
			const anchor = document.querySelector("a")!;

			anchor.dispatchEvent(
				new MouseEvent(
					"mouseover",
					{
						bubbles: true,
					},
				),
			);
			const hovered =
			{
				text: bar.textContent,
				opacity: bar.style.opacity,
			};
			anchor.dispatchEvent(
				new MouseEvent(
					"mouseout",
					{
						bubbles: true,
					},
				),
			);
			const left = bar.style.opacity;
			anchor.dispatchEvent(
				new MouseEvent(
					"mouseover",
					{
						bubbles: true,
					},
				),
			);
			window.dispatchEvent(new Event("hashchange"));

			expect(
				{
					hovered,
					left,
					afterHashChange: bar.style.opacity,
				},
			).toStrictEqual(
				{
					hovered:
					{
						text: "https://example.com/page",
						opacity: "1",
					},
					left: "0",
					afterHashChange: "0",
				},
			);
		});

		it("removes the bar on uninstall", () =>
		{
			uninstall = installLinkStatusBar(document);
			uninstall();
			uninstall = undefined;

			expect(document.body.children).toHaveLength(0);
		});
	});
});
