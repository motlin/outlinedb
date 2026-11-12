// @vitest-environment happy-dom
import {renderToStaticMarkup} from "react-dom/server";
import {createElement} from "react";
import {describe, expect, it, vi} from "vite-plus/test";
import {AlertDialogView} from "../src/client/components/alert-dialog.js";
import {listenForSelectionPaste} from "../src/client/item-selection.js";
import
{
	buildPasteLines,
	buildItemCopyLines,
	planItemCopy,
	planMultilineSplice,
	planPasteApply,
	PASTE_LIMIT_ALERT,
} from "../src/client/paste/apply.js";
import type {PasteLine} from "../src/client/paste/lines.js";
import {buildHtmlLines, hasRichContent, normalizePastedColors} from "../src/client/paste/html.js";
import {buildOpmlLines, isOpml} from "../src/client/paste/opml.js";
import {notePasteHtml} from "../src/client/paste/note.js";
import {QueryClient} from "@tanstack/react-query";
import
{
	pasteSteps,
	planItemPaste,
	copyTreeFromCache,
	resolveShortId,
	stepsRunnable,
} from "../src/client/paste/items.js";
import type {ItemPasteLookup} from "../src/client/paste/items.js";
import {nodeKeys} from "../src/client/node-cache.js";
import type {NodeResponse} from "../src/node-types.js";
import expected from "./fixtures/copy-format-expected.json" with {type: "json"};

describe("paste alert selection", () =>
{
	describe("AlertDialogView", () =>
	{
		it("renders upstream's alert markup", () =>
		{
			const html = renderToStaticMarkup(
				createElement(
					AlertDialogView,
					{
						title: "Error",
						message: "Pasting more than 10000 items at a time is not supported.",
						onClose: () =>
						{
						},
					},
				),
			);
			expect(html).toContain('style="z-index:600"');
			expect(html).toContain("dialog-backdrop");
			expect(html).toContain(" p-xl ");
			expect(html).toContain(
				'<h1 class="title text-l leading-xs font-bold whitespace-nowrap overflow-hidden text-ellipsis mr-3xl">Error</h1>',
			);
			expect(html).toContain(
				'<div class="text-base leading-base ">Pasting more than 10000 items at a time is not supported.</div>',
			);
			expect(html).toContain("position:absolute;top:30px;right:30px");
		});
	});

	describe("listenForSelectionPaste", () =>
	{
		function paste(target: HTMLElement): Event
		{
			const event = new Event(
				"paste",
				{
					bubbles: true,
					cancelable: true,
				},
			);
			target.dispatchEvent(event);
			return event;
		}

		it("swallows a paste while items are selected", () =>
		{
			const stop = listenForSelectionPaste(document, () => true);
			const reached = vi.fn<() => void>();
			document.body.addEventListener("paste", reached);
			const event = paste(document.body);
			expect(event.defaultPrevented).toBe(true);
			expect(reached).not.toHaveBeenCalled();
			document.body.removeEventListener("paste", reached);
			stop();
		});

		it("leaves a paste alone without a selection", () =>
		{
			const stop = listenForSelectionPaste(document, () => false);
			expect(paste(document.body).defaultPrevented).toBe(false);
			stop();
		});

		it("leaves a paste into an input alone", () =>
		{
			const stop = listenForSelectionPaste(document, () => true);
			const input = document.createElement("input");
			document.body.append(input);
			expect(paste(input).defaultPrevented).toBe(false);
			input.remove();
			stop();
		});
	});
});

describe("paste apply", () =>
{
	const line = (name: string, extra: Partial<PasteLine> = {}): PasteLine => (
	{
		name,
		mdBullet: false,
		children: [],
		...extra,
	});
	const plain = (text: string) =>
		buildPasteLines(
			{
				text,
			},
		);

	describe("planPasteApply", () =>
	{
		it("merges the first line, nests and splits after-text (U1)", () =>
		{
			expect(
				planPasteApply(
					{
						before: "P1",
						after: "",
						lines: plain("one\ntwo\n  three\nfour"),
						rowKind: "leaf",
					},
				),
			).toStrictEqual(
				{
					currentName: "P1one",
					childTrees: [],
					siblingTrees: [
						{
							name: "two",
							children: [
								{
									name: "three",
								},
							],
						},
						{
							name: "four",
						},
					],
					caret:
					{
						row: "lastCreated",
						offset: "end",
					},
				},
			);
		});

		it("splits the after-text into its own last row with the caret at 0 (U2)", () =>
		{
			expect(
				planPasteApply(
					{
						before: "fo",
						after: "ur",
						lines: plain("A\nB"),
						rowKind: "leaf",
					},
				),
			).toStrictEqual(
				{
					currentName: "foA",
					childTrees: [],
					siblingTrees: [
						{
							name: "B",
						},
						{
							name: "ur",
						},
					],
					caret:
					{
						row: "lastCreated",
						offset: 0,
					},
				},
			);
		});

		it("applies the first line's layout to the current row (U4)", () =>
		{
			const plan = planPasteApply(
				{
					before: "u",
					after: "r",
					lines: plain("# Head\nx"),
					rowKind: "leaf",
				},
			);
			expect(plan).toMatchObject(
				{
					currentName: "uHead",
					current:
					{
						layoutMode: "h1",
					},
				},
			);
		});

		it("splices a single plain line, untrimmed, with its metadata on the row (U3, U9, D7)", () =>
		{
			expect(
				planPasteApply(
					{
						before: "",
						after: "",
						lines: plain("# Title"),
						rowKind: "leaf",
					},
				),
			).toStrictEqual(
				{
					currentName: "Title",
					current:
					{
						layoutMode: "h1",
					},
					childTrees: [],
					siblingTrees: [],
					caret:
					{
						row: "current",
						offset: 5,
					},
				},
			);
			expect(
				planPasteApply(
					{
						before: "T1",
						after: "",
						lines: plain("   x  "),
						rowKind: "leaf",
					},
				),
			).toStrictEqual(
				{
					currentName: "T1   x  ",
					childTrees: [],
					siblingTrees: [],
					caret:
					{
						row: "current",
						offset: 8,
					},
				},
			);
		});

		it("replaces the selection with nothing for whitespace-only text (D8)", () =>
		{
			expect(
				planPasteApply(
					{
						before: "",
						after: "",
						lines: plain("   \n  \n"),
						rowKind: "leaf",
					},
				),
			).toStrictEqual(
				{
					currentName: "",
					childTrees: [],
					siblingTrees: [],
					caret:
					{
						row: "current",
						offset: 0,
					},
				},
			);
		});

		it("creates every line as first children of the zoom root and leaves its title (D1)", () =>
		{
			expect(
				planPasteApply(
					{
						before: "PD",
						after: "",
						lines: plain("T1\nT2"),
						rowKind: "zoomRoot",
					},
				),
			).toStrictEqual(
				{
					currentName: null,
					childTrees: [
						{
							name: "T1",
						},
						{
							name: "T2",
						},
					],
					siblingTrees: [],
					caret:
					{
						row: "lastCreated",
						offset: "end",
					},
				},
			);
		});

		it("creates siblings after a branch row without merging (D2, D3)", () =>
		{
			expect(
				planPasteApply(
					{
						before: "Par",
						after: "ent",
						lines: plain("A\nB"),
						rowKind: "branch",
					},
				),
			).toStrictEqual(
				{
					currentName: null,
					childTrees: [],
					siblingTrees: [
						{
							name: "A",
						},
						{
							name: "B",
						},
					],
					caret:
					{
						row: "lastCreated",
						offset: "end",
					},
				},
			);
		});

		it("strips line one's leading space and never copies the layout to siblings (D5)", () =>
		{
			const plan = planPasteApply(
				{
					before: "Todo row",
					after: "",
					lines: plain(" t1\nt2"),
					rowKind: "leaf",
				},
			);
			expect(plan).toMatchObject(
				{
					currentName: "Todo rowt1",
					siblingTrees: [
						{
							name: "t2",
						},
					],
				},
			);
			expect(plan).not.toHaveProperty("current");
		});

		it("turns an unindented dash into a bullet and nests the rest (D6)", () =>
		{
			expect(
				planPasteApply(
					{
						before: "Leaf row",
						after: "",
						lines: plain("\n- a\n  - b\n    - c\n- d"),
						rowKind: "leaf",
					},
				),
			).toStrictEqual(
				{
					currentName: "Leaf rowa",
					current:
					{
						layoutMode: "bullet",
					},
					childTrees: [
						{
							name: "b",
							children: [
								{
									name: "c",
								},
							],
						},
					],
					siblingTrees: [
						{
							name: "d",
							layoutMode: "bullet",
						},
					],
					caret:
					{
						row: "lastCreated",
						offset: "end",
					},
				},
			);
		});

		it("links urls in the merged text only (D9, D10)", () =>
		{
			expect(
				planPasteApply(
					{
						before: "Parent",
						after: " row",
						lines: plain("see https://ex.com/z now"),
						rowKind: "branch",
					},
				),
			).toMatchObject(
				{
					currentName: 'Parentsee <a href="https://ex.com/z">https://ex.com/z</a> now row',
				},
			);
			expect(
				planPasteApply(
					{
						before: "B",
						after: "",
						lines: plain(" u1 https://a.com/1\nu2 https://b.com/2 #tg @someone Oct 3, 2026"),
						rowKind: "leaf",
					},
				),
			).toStrictEqual(
				{
					currentName: 'Bu1 <a href="https://a.com/1">https://a.com/1</a>',
					childTrees: [],
					siblingTrees: [
						{
							name: "u2 https://b.com/2 #tg @someone Oct 3, 2026",
						},
					],
					caret:
					{
						row: "lastCreated",
						offset: "end",
					},
				},
			);
		});

		it("moves a leading nested group under the current row (D13)", () =>
		{
			expect(
				planPasteApply(
					{
						before: "d",
						after: "",
						lines: buildPasteLines(
							{
								text: "a\nb\nc",
								html: "<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>",
							},
						),
						rowKind: "leaf",
					},
				),
			).toStrictEqual(
				{
					currentName: "da",
					childTrees: [
						{
							name: "b",
						},
					],
					siblingTrees: [
						{
							name: "c",
						},
					],
					caret:
					{
						row: "lastCreated",
						offset: "end",
					},
				},
			);
		});

		it("carries notes, completion, layout and numbering into trees", () =>
		{
			const plan = planPasteApply(
				{
					before: "",
					after: "",
					lines: [
						line("x"),
						line(
							"y",
							{
								note: "n",
								complete: true,
								layoutMode: "numbered",
								numberedStart: 3,
							},
						),
					],
					rowKind: "branch",
				},
			);
			expect(plan).toMatchObject(
				{
					siblingTrees: [
						{
							name: "x",
						},
						{
							name: "y",
							note: "n",
							completed: true,
							layoutMode: "numbered",
							numberedStart: 3,
						},
					],
				},
			);
		});

		it("refuses more than 10000 lines with the upstream alert (D12)", () =>
		{
			const lines = Array.from(
				{
					length: 10_001,
				},
				() => line("x"),
			);
			expect(
				planPasteApply(
					{
						before: "",
						after: "",
						lines,
						rowKind: "leaf",
					},
				),
			).toStrictEqual(
				{
					alert: "Pasting more than 10000 items at a time is not supported.",
				},
			);
			expect(PASTE_LIMIT_ALERT).toBe("Pasting more than 10000 items at a time is not supported.");
		});

		it("counts nested lines toward the limit", () =>
		{
			const lines = [
				line(
					"p",
					{
						children: Array.from(
							{
								length: 10_000,
							},
							() => line("x"),
						),
					},
				),
			];
			expect(
				planPasteApply(
					{
						before: "",
						after: "",
						lines,
						rowKind: "leaf",
					},
				),
			).toHaveProperty("alert");
		});
	});

	describe("buildPasteLines", () =>
	{
		it("ignores html when pasting as plain text (PD5)", () =>
		{
			expect(
				buildPasteLines(
					{
						text: "a\nb",
						html: "<ul><li><b>a</b></li><li>b</li></ul>",
						plain: true,
					},
				),
			).toStrictEqual(plain("a\nb"));
			expect(
				buildPasteLines(
					{
						text: "a\nb",
						html: "<ul><li><b>a</b></li><li>b</li></ul>",
					},
				)[0]?.name,
			).toBe("<b>a</b>");
		});

		it("reads OPML text", () =>
		{
			expect(
				buildPasteLines(
					{
						text: '<opml><body><outline text="x"/></body></opml>',
					},
				),
			).toStrictEqual([line("x")]);
		});

		it("applies markdown to plain text", () =>
		{
			expect(
				buildPasteLines(
					{
						text: "# Title",
					},
				),
			).toStrictEqual([
				line(
					"Title",
					{
						layoutMode: "h1",
					},
				),
			]);
		});
	});

	describe("planMultilineSplice", () =>
	{
		it("escapes and keeps every newline, including a leading one (D4)", () =>
		{
			expect(
				planMultilineSplice(
					{
						before: "Quote row",
						after: "",
						text: "\nq1\nq2 <x>",
					},
				),
			).toStrictEqual(
				{
					html: "Quote row\nq1\nq2 &lt;x&gt;",
					caret: 19,
				},
			);
		});
	});

	describe("item copy", () =>
	{
		const html =
			'<ul><li><span class="name" data-wfid="abc" data-parent="p"><span class="innerContentContainer">NoteRow2</span></span><br/><span class="note">nl1\nl2 &lt;x&gt; &amp; y\n- l3</span></li></ul>';

		it("rebuilds rows from Workflowy's own copy html (U15)", () =>
		{
			expect(buildItemCopyLines(html)).toStrictEqual([
				line(
					"NoteRow2",
					{
						note: "nl1\nl2 &lt;x&gt; &amp; y\n- l3",
					},
				),
			]);
			expect(buildItemCopyLines("<b>x</b>")).toBeNull();
		});

		it("replaces an empty row at its index", () =>
		{
			expect(
				planItemCopy(
					{
						lines: buildItemCopyLines(html) ?? [],
						rowEmpty: true,
						rowIndex: 4,
						rowOpen: false,
					},
				),
			).toStrictEqual(
				{
					deleteCurrent: true,
					placement:
					{
						kind: "index",
						index: 4,
					},
					trees: [
						{
							name: "NoteRow2",
							note: "nl1\nl2 &lt;x&gt; &amp; y\n- l3",
						},
					],
				},
			);
		});

		it("goes first under an open row, else after the row", () =>
		{
			const lines = [line("x")];
			expect(
				planItemCopy(
					{
						lines,
						rowEmpty: false,
						rowIndex: 0,
						rowOpen: true,
					},
				),
			).toMatchObject(
				{
					deleteCurrent: false,
					placement:
					{
						kind: "firstChild",
					},
				},
			);
			expect(
				planItemCopy(
					{
						lines,
						rowEmpty: false,
						rowIndex: 0,
						rowOpen: false,
					},
				),
			).toMatchObject(
				{
					deleteCurrent: false,
					placement:
					{
						kind: "after",
					},
				},
			);
		});
	});
});

describe("paste html", () =>
{
	const U7 =
		'<p>Intro <b>bold</b> <a href="https://ex.com/a">link</a> <span style="font-weight:700">heavy</span> <em>em</em> <code>cd</code> <mark>mk</mark></p><ul><li>one<ul><li>one.a</li></ul></li><li>two</li></ul><p>after</p>';

	describe("buildHtmlLines", () =>
	{
		it("keeps the allowed inline set, maps lists to nesting and drops marks (U7)", () =>
		{
			expect(buildHtmlLines(U7)).toStrictEqual([
				{
					name: 'Intro <b>bold</b> <a href="https://ex.com/a">link</a> <b>heavy</b> <i>em</i> <code>cd</code> mk',
					mdBullet: false,
					children: [],
				},
				{
					name: "one",
					mdBullet: false,
					children: [
						{
							name: "one.a",
							mdBullet: false,
							children: [],
						},
					],
				},
				{
					name: "two",
					mdBullet: false,
					children: [],
				},
				{
					name: "after",
					mdBullet: false,
					children: [],
				},
			]);
		});

		it("turns a font-weight span into bold (U8)", () =>
		{
			expect(buildHtmlLines('<span style="font-weight:700">single bold</span>')).toStrictEqual([
				{
					name: "<b>single bold</b>",
					mdBullet: false,
					children: [],
				},
			]);
		});

		it("never stores style attributes or list tags (L2)", () =>
		{
			const lines = buildHtmlLines(
				'<p style="color:rgb(1,2,3)">Intro <b>bold</b> <span style="font-weight:700">heavy</span></p><ul><li>one</li><li>two</li></ul>',
			);
			expect(JSON.stringify(lines)).not.toMatch(/style|<ul|<li/u);
			expect(lines.map((line) => line.name)).toStrictEqual(["Intro <b>bold</b> <b>heavy</b>", "one", "two"]);
		});

		it("nests a list inside a leading item (D13)", () =>
		{
			expect(buildHtmlLines("<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>")).toStrictEqual([
				{
					name: "a",
					mdBullet: false,
					children: [
						{
							name: "b",
							mdBullet: false,
							children: [],
						},
					],
				},
				{
					name: "c",
					mdBullet: false,
					children: [],
				},
			]);
		});

		it("splits br into lines and escapes text", () =>
		{
			expect(buildHtmlLines("x &lt;y&gt; &amp; z<br>second")).toStrictEqual([
				{
					name: "x &lt;y&gt; &amp; z",
					mdBullet: false,
					children: [],
				},
				{
					name: "second",
					mdBullet: false,
					children: [],
				},
			]);
		});

		it("unwraps li > p", () =>
		{
			expect(
				buildHtmlLines("<ul><li><p>one</p></li><li><p>two</p></li></ul>").map((line) => line.name),
			).toStrictEqual(["one", "two"]);
		});
	});

	describe("hasRichContent", () =>
	{
		it("is true for formatting or lists and false for bare text", () =>
		{
			expect(hasRichContent("<b>x</b>")).toBe(true);
			expect(hasRichContent("<ul><li>x</li></ul>")).toBe(true);
			expect(hasRichContent("<span>x</span>")).toBe(false);
		});
	});

	describe("OPML", () =>
	{
		const U10 =
			'<?xml version="1.0"?><opml><body><outline text="O1" _note="n1"><outline text="O1a" _complete="true"/></outline><outline text="O2 &amp;lt;b&amp;gt;x"/><outline text="L" type="link" url="https://ex.com"/></body></opml>';

		it("recognizes OPML text", () =>
		{
			expect(isOpml(`  ${U10}\n`)).toBe(true);
			expect(isOpml("<p>x</p>")).toBe(false);
		});

		it("builds lines with notes, completion, layout and link urls (U10)", () =>
		{
			expect(buildOpmlLines(U10)).toStrictEqual([
				{
					name: "O1",
					mdBullet: false,
					note: "n1",
					children: [
						{
							name: "O1a",
							mdBullet: false,
							complete: true,
							children: [],
						},
					],
				},
				{
					name: "O2 &lt;b&gt;x",
					mdBullet: false,
					children: [],
				},
				{
					name: "L &lt;https://ex.com&gt;",
					mdBullet: false,
					children: [],
				},
			]);
		});

		it("keeps only allowed wf:layout-mode values", () =>
		{
			const opml =
				'<opml><body><outline text="a" wf:layout-mode="h1"/><outline text="b" wf:layout-mode="evil"/></body></opml>';
			expect(buildOpmlLines(opml).map((line) => line.layoutMode)).toStrictEqual(["h1", undefined]);
		});
	});

	describe("notePasteHtml", () =>
	{
		it("escapes plain text and keeps newlines (U12)", () =>
		{
			expect(
				notePasteHtml(
					{
						text: "l1\nl2 <x> & y\n- l3",
					},
				),
			).toBe("l1\nl2 &lt;x&gt; &amp; y\n- l3");
		});

		it("keeps bold and drops block tags, collapsing blank runs (U13)", () =>
		{
			const html = notePasteHtml(
				{
					text: "",
					html: "<p>l1</p><p>l2 &lt;x&gt; <b>B</b></p><ul><li>l3</li></ul>",
				},
			);
			expect(html).toBe("l1\n\nl2 &lt;x&gt; <b>B</b>\n\nl3");
			expect(html).not.toMatch(/<(?:p|ul|li)\b/u);
		});

		it("collapses runs of 3+ newlines to one blank line", () =>
		{
			expect(
				notePasteHtml(
					{
						text: "a\n\n\n\nb",
					},
				),
			).toBe("a\n\nb");
			expect(
				notePasteHtml(
					{
						text: "",
						html: "<b>a</b><br><br><br><br>b",
					},
				),
			).toBe("<b>a</b>\n\nb");
		});

		it("ignores html when pasting plain", () =>
		{
			expect(
				notePasteHtml(
					{
						text: "a",
						html: "<b>a</b>",
						plain: true,
					},
				),
			).toBe("a");
		});
	});

	describe("normalizePastedColors", () =>
	{
		function normalized(html: string): string
		{
			const doc = new DOMParser().parseFromString(html, "text/html");
			normalizePastedColors(doc);
			return doc.body.innerHTML;
		}

		it("wraps the children of a colored element in a span carrying the color", () =>
		{
			// happy-dom keeps the hex; a browser reports rgb(224, 36, 36). Both read as red.
			expect(normalized('<p style="color:#E02424">a</p>')).toBe(
				'<p style="color:#E02424"><span style="color: #E02424;">a</span></p>',
			);
		});

		it("skips an element whose parent span is already colored", () =>
		{
			const html = '<span style="color:#E02424"><b style="color:#E02424">a</b></span>';
			expect(normalized(html)).toContain('<b style="color:#E02424">a</b>');
		});

		it("leaves table elements alone", () =>
		{
			expect(
				normalized(
					'<table style="color:red"><tbody style="color:red"><tr style="color:red"><td>a</td></tr></tbody></table>',
				),
			).not.toContain("<span");
		});
	});

	describe("pasted colors", () =>
	{
		it("keeps a palette color as a colored span and drops any other", () =>
		{
			expect(
				buildHtmlLines(
					'<p>a <span style="color:#E02424">red</span> <span style="background-color:#FCE96A">hl</span> <span style="color:#123456">odd</span></p><ul><li>x</li></ul>',
				)[0]?.name,
			).toBe('a <span class="colored c-red">red</span> <span class="colored bc-yellow">hl</span> odd');
		});

		it("treats color styles as rich content", () =>
		{
			expect(hasRichContent('<span style="color:#E02424">x</span>')).toBe(true);
		});
	});
});

describe("paste items", () =>
{
	const A2 = "00000000-0000-0000-0000-0d8bb6069b31";
	const BRAVO = "00000000-0000-0000-0000-70fab4089100";

	function node(
		id: string,
		name: string,
		parentId: string | null,
		priority: number,
		extra: Partial<NodeResponse> = {},
	): NodeResponse
	{
		return {
			id,
			parent_id: parentId,
			name,
			note: null,
			priority,
			data:
			{
				layoutMode: null,
			},
			createdAt: null,
			modifiedAt: null,
			completedAt: null,
			...extra,
		};
	}

	describe("planItemPaste", () =>
	{
		const cutIds = new Map([
			["0d8bb6069b31", A2],
			["70fab4089100", BRAVO],
		]);

		it("restores cut rows with their original ids", () =>
		{
			expect(
				planItemPaste(
					expected.a2_bravo.html,
					{
						cutId: (short) => cutIds.get(short),
						resolve: () =>
						{
						},
					},
				),
			).toStrictEqual([
				{
					kind: "restore",
					shortId: "0d8bb6069b31",
					id: A2,
				},
				{
					kind: "restore",
					shortId: "70fab4089100",
					id: BRAVO,
				},
			]);
		});

		it("copies rows that were not cut, resolving them from the cache", () =>
		{
			expect(
				planItemPaste(
					expected.a2_bravo.html,
					{
						cutId: () =>
						{
						},
						resolve: (short) => `full-${short}`,
					},
				),
			).toStrictEqual([
				{
					kind: "copy",
					shortId: "0d8bb6069b31",
					id: "full-0d8bb6069b31",
				},
				{
					kind: "copy",
					shortId: "70fab4089100",
					id: "full-70fab4089100",
				},
			]);
		});

		it("takes only the top item when html has data-chid children", () =>
		{
			const steps = planItemPaste(
				expected.alpha_charlie.html,
				{
					cutId: () =>
					{
					},
					resolve: () =>
					{
					},
				},
			);
			expect(steps).toStrictEqual([
				{
					kind: "copy",
					shortId: "1ccce67ee6ff",
					id: null,
				},
				{
					kind: "copy",
					shortId: "9da451f0256e",
					id: null,
				},
			]);
			expect(Array.isArray(steps) && stepsRunnable(steps)).toBe(false);
		});

		it("is null for html that is not copied rows", () =>
		{
			expect(
				planItemPaste(
					"<p>hi</p>",
					{
						cutId: () =>
						{
						},
						resolve: () =>
						{
						},
					},
				),
			).toBeNull();
		});

		it("alerts above ten thousand rows", () =>
		{
			const html = `<ul>${'<li><div class="name" data-wfid="aaaaaaaaaaaa">x</div></li>'.repeat(10_001)}</ul>`;
			expect(
				planItemPaste(
					html,
					{
						cutId: () =>
						{
						},
						resolve: () =>
						{
						},
					},
				),
			).toStrictEqual(
				{
					alert: PASTE_LIMIT_ALERT,
				},
			);
		});
	});

	describe("mirror-aware paste plan", () =>
	{
		const ORIG = "00000000-0000-0000-0000-0d8bb6069b31";
		const MIRROR = "00000000-0000-0000-0000-70fab4089100";
		const mirrorOriginal = (id: string): string | undefined => (id === ORIG || id === MIRROR ? ORIG : undefined);
		const lookup: ItemPasteLookup =
		{
			cutId: () =>
			{
			},
			resolve: (short: string) =>
				short === "0d8bb6069b31" ? ORIG : short === "70fab4089100" ? MIRROR : `plain-${short}`,
			mirrorOriginal,
		};

		it("pastes an original that has mirrors, and a mirror, as mirrors of the original", () =>
		{
			expect(planItemPaste(expected.a2_bravo.html, lookup)).toStrictEqual([
				{
					kind: "mirror",
					shortId: "0d8bb6069b31",
					originalId: ORIG,
				},
				{
					kind: "mirror",
					shortId: "70fab4089100",
					originalId: ORIG,
				},
			]);
		});

		it("copies a plain row", () =>
		{
			expect(
				planItemPaste(
					expected.a2_bravo.html,
					{
						...lookup,
						mirrorOriginal: () =>
						{
						},
					},
				),
			).toStrictEqual([
				{
					kind: "copy",
					shortId: "0d8bb6069b31",
					id: ORIG,
				},
				{
					kind: "copy",
					shortId: "70fab4089100",
					id: MIRROR,
				},
			]);
		});

		it("lets a cut row restore before any mirror rule", () =>
		{
			expect(
				planItemPaste(
					expected.a2_bravo.html,
					{
						...lookup,
						cutId: (short) => (short === "0d8bb6069b31" ? ORIG : undefined),
					},
				),
			).toStrictEqual([
				{
					kind: "restore",
					shortId: "0d8bb6069b31",
					id: ORIG,
				},
				{
					kind: "mirror",
					shortId: "70fab4089100",
					originalId: ORIG,
				},
			]);
		});

		it("runs mirror steps through the mirror effect in order", async () =>
		{
			const calls: string[] = [];
			const steps = planItemPaste(expected.a2_bravo.html, lookup);
			const result = await pasteSteps(
				Array.isArray(steps) ? steps : [],
				3,
				{
					restore: async () =>
					{
					},
					copyFromCache: async () =>
					{
					},
					fallbackCopy: async () =>
					{
					},
					mirror: async (originalId, at) =>
					{
						calls.push(`${originalId}@${at}`);
						return Promise.resolve(`m${at}`);
					},
				},
			);
			expect(
				{
					calls,
					result,
				},
			).toStrictEqual(
				{
					calls: [`${ORIG}@3`, `${ORIG}@4`],
					result:
					{
						unmovable: false,
						lastId: "m4",
						fellBack: false,
					},
				},
			);
		});
	});

	describe("copying from the model", () =>
	{
		it("duplicates a collapsed row with its children, note, completion and layout", () =>
		{
			const queryClient = new QueryClient();
			queryClient.setQueryData(nodeKeys.children(null), [
				node(
					"00000000-0000-0000-0000-9da451f0256e",
					"Charlie",
					null,
					1,
					{
						note: "n",
						completedAt: 5,
						data:
						{
							layoutMode: "todo",
						},
					},
				),
			]);
			queryClient.setQueryData(nodeKeys.children("00000000-0000-0000-0000-9da451f0256e"), [
				node("00000000-0000-0000-0000-c1c1c1c1c1c1", "C1", "00000000-0000-0000-0000-9da451f0256e", 1),
			]);
			const id = resolveShortId(queryClient, "9da451f0256e");
			expect(id).toBe("00000000-0000-0000-0000-9da451f0256e");
			expect(copyTreeFromCache(queryClient, id ?? "")).toStrictEqual(
				{
					name: "Charlie",
					note: "n",
					completed: true,
					layoutMode: "todo",
					children: [
						{
							name: "C1",
						},
					],
				},
			);
		});
	});

	describe("planItemPaste of a copied Mirror", () =>
	{
		it("turns each data-wf-mirror div into a mirror step for that original", () =>
		{
			expect(
				planItemPaste(
					'<div data-wf-mirror="orig-a">&nbsp;</div><div data-wf-mirror="orig-b">&nbsp;</div>',
					{
						cutId: () =>
						{
						},
						resolve: () =>
						{
						},
					},
				),
			).toStrictEqual([
				{
					kind: "mirror",
					shortId: "orig-a",
					originalId: "orig-a",
				},
				{
					kind: "mirror",
					shortId: "orig-b",
					originalId: "orig-b",
				},
			]);
		});
	});
});
