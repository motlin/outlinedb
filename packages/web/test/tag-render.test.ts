import {describe, expect, it} from "vite-plus/test";
import
{
	isTagDeleteClick,
	removeTagAt,
	removeTagFromHtml,
	renderTags,
	renderedTagStarts,
	stripTagMarkup,
	tagCaretUnits,
	teaserPosition,
	toggleTagInQuery,
} from "../src/client/tag-render.js";

function tagSpan(tag: string): string
{
	return `<span class="contentTag explosive" title="Filter ${tag}" data-val="${tag.toLowerCase()}">${tag.slice(0, 1)}<span class="contentTagText">${tag.slice(1)}</span><span class="contentTagNub"></span></span>`;
}

describe("renderTags", () =>
{
	it("wraps a tag in the upstream contentTag markup", () =>
	{
		expect(renderTags("Alpha #taZebra item")).toBe(
			'Alpha <span class="contentTag explosive" title="Filter #taZebra" data-val="#tazebra">#<span class="contentTagText">taZebra</span><span class="contentTagNub"></span></span> item',
		);
	});

	it("never tags text inside links, attributes, or after an entity", () =>
	{
		const html = 'Link <a href="https://example.com/#taFrag">site #taLinked</a> and &amp;#taAmp';
		expect(renderTags(html)).toBe(html);
	});

	it("never tags text inside code", () =>
	{
		const html = "Run <code>#taCode</code> now";
		expect(renderTags(html)).toBe(html);
	});

	it("keeps formatting that wraps the whole tag outside the span", () =>
	{
		expect(renderTags("Bold <b>#taBold</b> tag")).toBe(
			'Bold <b><span class="contentTag explosive" title="Filter #taBold" data-val="#tabold">#<span class="contentTagText">taBold</span><span class="contentTagNub"></span></span></b> tag',
		);
	});

	it("skips short numeric tags", () =>
	{
		expect(renderTags("Numbers #123 #1234")).toBe(`Numbers #123 ${tagSpan("#1234")}`);
	});

	it("wraps a colon-joined tag as one span", () =>
	{
		expect(renderTags("Delta #ta:sub:key end")).toBe(`Delta ${tagSpan("#ta:sub:key")} end`);
	});

	it("wraps mentions the same way", () =>
	{
		expect(renderTags("Ping @Alice now")).toBe(`Ping ${tagSpan("@Alice")} now`);
	});

	it("re-encodes the tag text exactly as it appeared and escapes attributes", () =>
	{
		expect(renderTags("Amp #ta&amp;b end")).toBe(
			'Amp <span class="contentTag explosive" title="Filter #ta&amp;b" data-val="#ta&amp;b">#<span class="contentTagText">ta&amp;b</span><span class="contentTagNub"></span></span> end',
		);
	});

	it("leaves a tag split across formatting untouched", () =>
	{
		const html = "Split #ta<b>Half</b> end";
		expect(renderTags(html)).toBe(html);
	});

	it("treats &nbsp; as a boundary", () =>
	{
		expect(renderTags("Space&nbsp;#taNbsp end")).toBe(`Space&nbsp;${tagSpan("#taNbsp")} end`);
	});
});

describe("teaserPosition", () =>
{
	it("places the teaser at the tag's right edge, vertically centred plus the Flyout margin", () =>
	{
		expect(
			teaserPosition(
				{
					top: 146.5,
					right: 216.92,
					height: 19,
				},
			),
		).toStrictEqual(
			{
				left: 215.92,
				top: 146.5,
			},
		);
	});
});

describe("toggleTagInQuery", () =>
{
	it("appends a new tag and removes one already in the query, case-insensitively, keeping one trailing space", () =>
	{
		expect(
			{
				empty: toggleTagInQuery("", "#taZebra"),
				append: toggleTagInQuery("#taZebra ", "#taApple"),
				removeCaseInsensitive: toggleTagInQuery("#taZebra #taApple ", "#TAAPPLE"),
				removeLast: toggleTagInQuery("#taZebra ", "#taZebra"),
				prefixIsNotMatch: toggleTagInQuery("#taZebraLong ", "#taZebra"),
				regexChars: toggleTagInQuery("#a.b ", "#a+b"),
			},
		).toStrictEqual(
			{
				empty: "#taZebra ",
				append: "#taZebra #taApple ",
				removeCaseInsensitive: "#taZebra ",
				removeLast: "",
				prefixIsNotMatch: "#taZebraLong #taZebra ",
				regexChars: "#a.b #a+b ",
			},
		);
	});
});

describe("removeTagAt", () =>
{
	it("removes the tag plus following spaces and tabs, leaving the caret at the tag's start", () =>
	{
		expect(
			{
				trailing: removeTagAt("Type here #taApple #taZebra foo #taBold ", 32, "#taBold"),
				tab: removeTagAt("a #x\tb", 2, "#x"),
				mismatch: removeTagAt("a #x b", 2, "#y"),
			},
		).toStrictEqual(
			{
				trailing:
				{
					text: "Type here #taApple #taZebra foo ",
					caret: 32,
				},
				tab:
				{
					text: "a b",
					caret: 2,
				},
				mismatch:
				{
					text: "a #x b",
					caret: 2,
				},
			},
		);
	});
});

describe("removeTagFromHtml", () =>
{
	it("removes the tag through the plain-text map and leaves surrounding markup intact", () =>
	{
		expect(
			{
				afterBold: removeTagFromHtml("<b>x</b> #t y", 2, "#t"),
				entities: removeTagFromHtml("a &amp; #t &lt;b", 4, "#t"),
				spaceInNextSegment: removeTagFromHtml("#t<i> y</i>", 0, "#t"),
				mismatch: removeTagFromHtml("<b>x</b> #t y", 2, "#u"),
			},
		).toStrictEqual(
			{
				afterBold: "<b>x</b> y",
				entities: "a &amp; &lt;b",
				spaceInNextSegment: "<i>y</i>",
				mismatch: "<b>x</b> #t y",
			},
		);
	});
});

describe("renderedTagStarts", () =>
{
	it("lists the plain offsets of the tags renderTags wraps, skipping links and code", () =>
	{
		expect(renderedTagStarts('#a <a href="x">#b</a> <code>#c</code> @d')).toStrictEqual([0, 9]);
	});
});

describe("tagCaretUnits", () =>
{
	it("counts a date pill as one caret unit and entities as one, unlike the label-length tag offsets", () =>
	{
		const pill = '<time startYear="2026" startMonth="10" startDay="19">Oct 19, 2026</time>';
		expect(
			{
				afterPill: tagCaretUnits(`${pill} #a #b text`, 16),
				entities: tagCaretUnits("a &amp; #t", 4),
				plain: tagCaretUnits("#a #b", 3),
			},
		).toStrictEqual(
			{
				afterPill: 5,
				entities: 4,
				plain: 3,
			},
		);
	});
});

describe("isTagDeleteClick", () =>
{
	it("is Meta-click on mac and Meta- or Alt-click elsewhere", () =>
	{
		expect(
			{
				macMeta: isTagDeleteClick(
					{
						metaKey: true,
						altKey: false,
					},
					true,
				),
				macAlt: isTagDeleteClick(
					{
						metaKey: false,
						altKey: true,
					},
					true,
				),
				otherAlt: isTagDeleteClick(
					{
						metaKey: false,
						altKey: true,
					},
					false,
				),
				otherMeta: isTagDeleteClick(
					{
						metaKey: true,
						altKey: false,
					},
					false,
				),
				plain: isTagDeleteClick(
					{
						metaKey: false,
						altKey: false,
					},
					false,
				),
			},
		).toStrictEqual(
			{
				macMeta: true,
				macAlt: false,
				otherAlt: true,
				otherMeta: true,
				plain: false,
			},
		);
	});
});

describe("stripTagMarkup", () =>
{
	it("unwraps rendered tags back to stored html, keeping other spans", () =>
	{
		const html = 'Hi <b><span class="colored c-red">x</span> #taBold</b> @Ellen&nbsp;';
		expect(stripTagMarkup(renderTags(html))).toBe(html);
	});

	it("unwraps a tag span the browser left holding extra typed text", () =>
	{
		expect(stripTagMarkup(`${tagSpan("#taZeb").replace("Zeb<", "Zebra<")} end`)).toBe("#taZebra end");
	});
});
