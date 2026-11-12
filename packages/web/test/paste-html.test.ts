// @vitest-environment happy-dom
import {describe, expect, it} from "vite-plus/test";
import {buildHtmlLines, hasRichContent, normalizePastedColors} from "../src/client/paste/html.js";
import {buildOpmlLines, isOpml} from "../src/client/paste/opml.js";
import {notePasteHtml} from "../src/client/paste/note.js";

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
