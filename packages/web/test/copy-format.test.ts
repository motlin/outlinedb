// @vitest-environment happy-dom
import {describe, expect, it} from "vite-plus/test";
import {copyItemsHtml, copyItemsPlainText, linkParents} from "../src/client/export-format.js";
import type {ChildAccessor, ExportItem} from "../src/client/export-format.js";
import expected from "./fixtures/copy-format-expected.json" with {type: "json"};
import deepExpected from "./fixtures/copy-format-deep-expected.json" with {type: "json"};

interface Options
{
	note?: string;
	layoutMode?: string;
	completed?: boolean;
}

function mk(shortId: string, name: string, options: Options = {}, children: ExportItem[] = []): ExportItem
{
	return {
		id: `00000000-0000-0000-0000-${shortId}`,
		name,
		note: options.note ?? "",
		layoutMode: options.layoutMode ?? null,
		numberedStart: null,
		completed: options.completed ?? false,
		parent: null,
		children,
	};
}

/** Upstream's copy childFilter: only expanded rows and the zoom root contribute children. */
function filterFor(expanded: Set<string>, zoomId?: string): ChildAccessor
{
	return (item) => (item.id === zoomId || expanded.has(item.id) ? item.children : []);
}

function ccFixture()
{
	const a1 = mk("e00f955fa992", "A1");
	const a2 = mk("0d8bb6069b31", "A2");
	const alpha = mk("1ccce67ee6ff", "Alpha", {}, [a1, a2]);
	const bravo = mk(
		"70fab4089100",
		"Bravo <b>bold</b>",
		{
			note: "bravo note",
		},
	);
	const charlie = mk("9da451f0256e", "Charlie", {}, [mk("c1c1c1c1c1c1", "C1")]);
	const delta = mk("53b4d5571cce", "Delta");
	const dest = mk("4b159905d286", "Dest");
	const root = mk("fa85028843d2", "CC fixture", {}, [alpha, bravo, charlie, delta, dest]);
	const top = mk("ab03ee6d2ae0", "Home", {}, [root]);
	linkParents([top]);
	return {
		root,
		alpha,
		a1,
		a2,
		bravo,
		charlie,
		delta,
		dest,
	};
}

describe("copying selected rows", () =>
{
	it("copies two top rows, expanding only the expanded one", () =>
	{
		const {alpha, charlie} = ccFixture();
		const filter = filterFor(new Set([alpha.id]));
		expect(copyItemsHtml([alpha, charlie], filter)).toStrictEqual(expected.alpha_charlie.html);
		expect(copyItemsPlainText([alpha, charlie], filter)).toStrictEqual(expected.alpha_charlie.plain);
	});

	it("copies rows of different depth with a note, in the order given", () =>
	{
		const {a2, bravo} = ccFixture();
		const filter = filterFor(new Set());
		expect(copyItemsHtml([a2, bravo], filter)).toStrictEqual(expected.a2_bravo.html);
		expect(copyItemsPlainText([a2, bravo], filter)).toStrictEqual(expected.a2_bravo.plain);
	});

	it("copies one leaf as a span inside a list", () =>
	{
		const {a1} = ccFixture();
		const filter = filterFor(new Set());
		expect(copyItemsHtml([a1], filter)).toStrictEqual(expected.a1_only.html);
		expect(copyItemsPlainText([a1], filter)).toStrictEqual(expected.a1_only.plain);
	});

	it("copies the zoom root with its visible children", () =>
	{
		const {root, alpha} = ccFixture();
		const filter = filterFor(new Set([alpha.id]), root.id);
		expect(copyItemsHtml([root], filter)).toStrictEqual(expected.zoomroot.html);
		expect(copyItemsPlainText([root], filter)).toStrictEqual(expected.zoomroot.plain);
	});

	it("copies rows in display order", () =>
	{
		const {bravo, delta} = ccFixture();
		const filter = filterFor(new Set());
		expect(copyItemsHtml([bravo, delta], filter)).toStrictEqual(expected.reversed_insert.html);
		expect(copyItemsPlainText([bravo, delta], filter)).toStrictEqual(expected.reversed_insert.plain);
	});
});

const ccd = deepExpected as unknown as Record<
	string,
	{
		html: string;
		text: string;
	}
>;

/** The fixture's tag markup, as the row renders it. */
function renderTag(html: string): string
{
	return html.replaceAll(
		/#(ccdtag)/gu,
		'<span class="contentTag explosive" title="Filter #$1" data-val="#$1">#<span class="contentTagText">$1</span><span class="contentTagNub"></span></span>',
	);
}

function ccdFixture()
{
	const p1 = mk("1dffea89a928", "P1");
	const p2 = mk("cd8cd021c376", "P2");
	const plain = mk(
		"f858f5ef34bf",
		"Plain #ccdtag",
		{
			note: "plain note",
		},
		[p1, p2],
	);
	const dest = mk("ecbac275491a", "Dest");
	const home = mk("b0adce4a2894", "Home", {}, [plain, dest]);
	linkParents([home]);
	return {
		plain,
		p1,
		p2,
		dest,
	};
}

/** The dump strips data-parent from these cases. */
function withoutParents(html: string): string
{
	return html.replaceAll(/ data-parent="[0-9a-f]{12}"/gu, "");
}

describe("copied markup follows what the row renders", () =>
{
	const options =
	{
		renderName: renderTag,
	};

	it("writes a break between the name and note of a single collapsed row", () =>
	{
		const {plain} = ccdFixture();
		const expectedCase = ccd.single_with_note_collapsed;
		expect(copyItemsHtml([plain], filterFor(new Set()), options)).toStrictEqual(expectedCase.html);
		expect(copyItemsPlainText([plain], filterFor(new Set()), options)).toStrictEqual(expectedCase.text);
	});

	it("puts the note in the item block when several rows are copied", () =>
	{
		const {plain, dest} = ccdFixture();
		const expectedCase = ccd.two_items_first_with_note;
		const filter = filterFor(new Set());
		expect(copyItemsHtml([plain, dest], filter, options)).toStrictEqual(expectedCase.html);
		expect(copyItemsPlainText([plain, dest], filter, options)).toStrictEqual(expectedCase.text);
	});

	it("copies an expanded single row with its children", () =>
	{
		const {plain} = ccdFixture();
		const expectedCase = ccd["single_expanded_with_note_and_children (data-parent stripped)"];
		const filter = filterFor(new Set([plain.id]));
		expect(withoutParents(copyItemsHtml([plain], filter, options))).toStrictEqual(
			expectedCase.html.replaceAll(" >", ">"),
		);
		expect(copyItemsPlainText([plain], filter, options)).toStrictEqual(expectedCase.text);
	});

	it("copies rows of mixed depth", () =>
	{
		const {p2, dest} = ccdFixture();
		const expectedCase = ccd["mixed_depth (data-parent stripped)"];
		const filter = filterFor(new Set());
		expect(withoutParents(copyItemsHtml([p2, dest], filter, options))).toStrictEqual(
			expectedCase.html.replaceAll(" >", ">"),
		);
		expect(copyItemsPlainText([p2, dest], filter, options)).toStrictEqual(expectedCase.text);
	});

	it("copies only the rows search renders, with highlights", () =>
	{
		const {plain, p1} = ccdFixture();
		const expectedCase = ccd.search_mode_q_P1;
		const filter: ChildAccessor = (item) => (item === plain ? [p1] : []);
		const highlight = (html: string): string =>
			renderTag(html).replace("P1", '<span class="contentMatch">P1</span>');
		const rendered =
		{
			renderName: highlight,
		};
		expect(copyItemsHtml([plain], filter, rendered)).toStrictEqual(expectedCase.html);
		expect(copyItemsPlainText([plain], filter, rendered)).toStrictEqual(expectedCase.text);
	});

	it("copies rendered links and date pills", () =>
	{
		const rich = mk("f00eb4839228", "Rich", {});
		const home = mk("b0adce4a2894", "Home", {}, [rich]);
		linkParents([home]);
		const expectedCase = ccd.rich_markup;
		const markup =
			'Rich <b>bold</b> <span class="colored c-red">red</span> <a class="contentLink" target="_blank" rel="noreferrer" href="https://example.com/">link</a> <time data-monolith="true" contenteditable="false" class="explosive monolith-pill" title="⌥click to search" startyear="2026" startmonth="10" startday="1">﻿<span class="content-wrapper">2026-10-01 Thu</span>﻿</time> &amp; <code>cd</code>';
		const rendered =
		{
			renderName: () => markup,
		};
		expect(copyItemsHtml([rich], filterFor(new Set()), rendered)).toStrictEqual(expectedCase.html);
		expect(copyItemsPlainText([rich], filterFor(new Set()), rendered)).toStrictEqual(expectedCase.text);
	});

	it("copies a completed row struck through", () =>
	{
		const done = mk(
			"111111111111",
			"Done",
			{
				completed: true,
			},
		);
		linkParents([mk("222222222222", "Home", {}, [done])]);
		expect(copyItemsHtml([done], filterFor(new Set()))).toBe(
			'<ul><li>\n<div>\n<span class="name" style="color:#999; text-decoration:line-through; " data-wfid="111111111111" data-parent="222222222222"><span class="innerContentContainer">Done</span></span></div></li></ul>',
		);
	});

	it("copies a numbered row as an ordered list starting at its position", () =>
	{
		const first = mk(
			"111111111111",
			"One",
			{
				layoutMode: "numbered",
			},
		);
		const second = mk(
			"222222222222",
			"Two",
			{
				layoutMode: "numbered",
			},
		);
		second.numberedStart = 3;
		linkParents([mk("333333333333", "Home", {}, [first, second])]);
		expect(copyItemsHtml([second], filterFor(new Set()))).toBe(
			'<ol start="3" style="list-style-type:decimal;"><li>\n<div>\n<span class="name" style="color:#333; " data-wfid="222222222222" data-parent="333333333333"><span class="innerContentContainer">Two</span></span></div></li></ol>',
		);
	});
});
