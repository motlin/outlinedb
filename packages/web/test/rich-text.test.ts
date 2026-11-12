import {describe, expect, it} from "vite-plus/test";
import
{
	colorAt,
	concatHtml,
	hasAttr,
	parseInline,
	pendingFormatApply,
	plainLength,
	planInlineToggle,
	planItemsAttrToggle,
	planItemsCodeToggle,
	planItemsColorClear,
	planItemsColorToggle,
	plainText,
	serializeInline,
	splitHtml,
	toggleAttr,
	toggleColor,
	touchesAttr,
	touchesColor,
	trimmedPlainLength,
} from "../src/client/rich-text.js";

describe("splitHtml", () =>
{
	it("splits plain text at a collapsed caret", () =>
	{
		expect(splitHtml("Bravo text", 5, 5)).toStrictEqual(
			{
				before: "Bravo",
				after: " text",
			},
		);
	});

	it("closes open tags in before and reopens them in after", () =>
	{
		expect(splitHtml("<b>harl</b>ie", 2, 2)).toStrictEqual(
			{
				before: "<b>ha</b>",
				after: "<b>rl</b>ie",
			},
		);
	});

	it("drops the selected text", () =>
	{
		expect(splitHtml("XyCharlie", 1, 3)).toStrictEqual(
			{
				before: "X",
				after: "harlie",
			},
		);
	});

	it("reopens nested tags with their attributes", () =>
	{
		expect(splitHtml('<a href="u"><i>abcd</i></a>', 2, 2)).toStrictEqual(
			{
				before: '<a href="u"><i>ab</i></a>',
				after: '<a href="u"><i>cd</i></a>',
			},
		);
	});

	it("keeps entities intact and counts them as one character", () =>
	{
		expect(splitHtml("a &amp; b", 3, 3)).toStrictEqual(
			{
				before: "a &amp;",
				after: " b",
			},
		);
	});

	it("drops tags left empty at the split edges", () =>
	{
		expect(splitHtml("<b>ab</b>cd", 2, 2)).toStrictEqual(
			{
				before: "<b>ab</b>",
				after: "cd",
			},
		);
		expect(splitHtml("ab<b>cd</b>", 2, 2)).toStrictEqual(
			{
				before: "ab",
				after: "<b>cd</b>",
			},
		);
	});

	it("splits at the ends", () =>
	{
		expect(splitHtml("<b>ab</b>", 0, 0)).toStrictEqual(
			{
				before: "",
				after: "<b>ab</b>",
			},
		);
		expect(splitHtml("<b>ab</b>", 2, 2)).toStrictEqual(
			{
				before: "<b>ab</b>",
				after: "",
			},
		);
	});
});

describe("concatHtml", () =>
{
	it("merges an identical closing and opening tag at the seam", () =>
	{
		expect(concatHtml("<b>ha</b>", "<b>rl</b>ie")).toBe("<b>harl</b>ie");
	});

	it("concatenates plain text", () =>
	{
		expect(concatHtml("Xy", "Charlie")).toBe("XyCharlie");
	});

	it("does not merge different tags", () =>
	{
		expect(concatHtml("<b>ha</b>", "<i>rl</i>")).toBe("<b>ha</b><i>rl</i>");
	});

	it("does not merge tags with different attributes", () =>
	{
		expect(concatHtml('<a href="x">a</a>', '<a href="y">b</a>')).toBe('<a href="x">a</a><a href="y">b</a>');
	});

	it("round-trips a split", () =>
	{
		const {before, after} = splitHtml('<a href="u"><i>abcd</i></a>', 2, 2);
		expect(concatHtml(before, after)).toBe('<a href="u"><i>abcd</i></a>');
	});
});

describe("plainLength", () =>
{
	it("counts entities as one character", () =>
	{
		expect(plainLength("a &amp; b")).toBe(5);
	});

	it("ignores tags", () =>
	{
		expect(plainLength("<b>harl</b>ie")).toBe(6);
	});
});

describe("trimmedPlainLength", () =>
{
	it("ignores trailing whitespace, nbsp entities, and tags", () =>
	{
		expect(trimmedPlainLength("<b>Bravo&nbsp;</b> &#160;")).toBe(5);
	});

	it("keeps leading and inner whitespace", () =>
	{
		expect(trimmedPlainLength(" a b")).toBe(4);
	});
});

describe("date pills are one character", () =>
{
	const pill = '<time startYear="2026" startMonth="10" startDay="1">Thu, Oct 1, 2026</time>';

	it("counts a <time> element as one plain-text character", () =>
	{
		expect(plainLength(`ab ${pill} c`)).toBe(6);
	});

	it("never splits inside a <time> element", () =>
	{
		expect(splitHtml(`ab ${pill} c`, 4, 4)).toStrictEqual(
			{
				before: `ab ${pill}`,
				after: " c",
			},
		);
	});
});

describe("mentions are one character", () =>
{
	const mention = '<mention id="0" by="1" ts="1"> </mention>';

	it("counts a <mention> element as one plain-text character", () =>
	{
		expect([plainLength(`a ${mention} b`), plainText(`a ${mention} b`, "\u0001")]).toStrictEqual([5, "a \u0001 b"]);
	});

	it("never splits inside a <mention> element", () =>
	{
		expect(splitHtml(`a ${mention} b`, 2, 3)).toStrictEqual(
			{
				before: "a ",
				after: " b",
			},
		);
		expect(splitHtml(`a ${mention} b`, 3, 3)).toStrictEqual(
			{
				before: `a ${mention}`,
				after: " b",
			},
		);
	});

	it("keeps the whole mention inside a toggled format", () =>
	{
		expect(toggleAttr(`a ${mention} b`, 0, 5, "b")).toBe(`<b>a ${mention} b</b>`);
	});
});

describe("toggleAttr", () =>
{
	it("sets an attribute on a plain range and removes it again", () =>
	{
		const bold = toggleAttr("Bravo plain text here", 6, 11, "b");
		expect(bold).toBe("Bravo <b>plain</b> text here");
		expect(toggleAttr(bold, 6, 11, "b")).toBe("Bravo plain text here");
	});

	it("extends a partial attribute over the whole range, then removes it", () =>
	{
		const extended = toggleAttr("Bravo <b>text</b> here", 6, 15, "b");
		expect(extended).toBe("Bravo <b>text here</b>");
		expect(toggleAttr(extended, 6, 15, "b")).toBe("Bravo text here");
	});

	it("nests attributes in canonical order regardless of toggle order", () =>
	{
		const expected = "Bravo <code><i><u><s>plain</s></u></i></code> text here";
		const forward = ["i", "u", "s", "code"] as const;
		const backward = ["code", "s", "u", "i"] as const;
		expect(forward.reduce((html, attr) => toggleAttr(html, 6, 11, attr), "Bravo plain text here")).toStrictEqual(
			expected,
		);
		expect(backward.reduce((html, attr) => toggleAttr(html, 6, 11, attr), "Bravo plain text here")).toStrictEqual(
			expected,
		);
	});

	it("puts bold innermost", () =>
	{
		expect(toggleAttr(toggleAttr("plain", 0, 5, "b"), 0, 5, "u")).toBe("<u><b>plain</b></u>");
	});

	it("round trips entities and links unchanged", () =>
	{
		expect(toggleAttr("a &amp; b", 0, 1, "b")).toBe("<b>a</b> &amp; b");
		expect(toggleAttr('see <a href="x">link</a> now', 0, 3, "i")).toBe('<i>see</i> <a href="x">link</a> now');
		expect(toggleAttr('<a href="x">link</a>', 0, 4, "b")).toBe('<a href="x"><b>link</b></a>');
	});
});

describe("hasAttr and touchesAttr", () =>
{
	it("distinguish a partial overlap from full coverage", () =>
	{
		expect(touchesAttr("Bravo <b>text</b> here", 6, 15, "b")).toBe(true);
		expect(hasAttr("Bravo <b>text</b> here", 6, 15, "b")).toBe(false);
		expect(hasAttr("Bravo <b>text</b> here", 6, 10, "b")).toBe(true);
		expect(touchesAttr("Bravo <b>text</b> here", 11, 15, "b")).toBe(false);
	});
});

describe("parseInline and serializeInline", () =>
{
	it("round trip markup with opaque spans", () =>
	{
		const html = 'x <span class="colored c-red">red</span> <a href="x">&amp;</a> <b>y</b>';
		expect(serializeInline(parseInline(html))).toStrictEqual(html);
	});

	it("keeps a trailing non-format tag without counting it as a character", () =>
	{
		expect(toggleAttr("ab<br>", 0, 2, "b")).toBe("<b>ab</b><br>");
	});

	it("exposes attribute spans", () =>
	{
		expect(parseInline("ab<b>cd</b>")).toStrictEqual(
			{
				chars: ["a", "b", "c", "d"],
				spans: [
					{
						start: 2,
						end: 4,
						name: "b",
						raw: "<b>",
					},
				],
				tail: "",
			},
		);
	});
});

describe("planInlineToggle", () =>
{
	it("toggles the selection and keeps it", () =>
	{
		expect(
			planInlineToggle(
				"Bravo plain text here",
				{
					start: 6,
					end: 11,
				},
				"b",
			),
		).toStrictEqual(
			{
				html: "Bravo <b>plain</b> text here",
				sel:
				{
					start: 6,
					end: 11,
				},
			},
		);
	});
});

describe("pendingFormatApply", () =>
{
	it("inserts a typed character carrying the pending attributes", () =>
	{
		expect(pendingFormatApply("here", 4, new Set(["b"]), "z")).toBe("here<b>z</b>");
	});

	it("inherits the attributes of the preceding character", () =>
	{
		expect(pendingFormatApply("<b>z</b>", 1, new Set(["i"]), "y")).toBe("<b>z</b><i><b>y</b></i>");
	});

	it("escapes the typed character", () =>
	{
		expect(pendingFormatApply("a", 1, new Set(["b"]), "<")).toBe("a<b>&lt;</b>");
	});
});

describe("planItemsAttrToggle", () =>
{
	it("sets the attribute on a plain field and removes it when every field has it", () =>
	{
		expect(
			{
				set: planItemsAttrToggle(
					[
						{
							id: "a",
							field: "name",
							html: "Bravo",
						},
					],
					"b",
				),
				remove: planItemsAttrToggle(
					[
						{
							id: "a",
							field: "name",
							html: "<b>Bravo</b>",
						},
					],
					"b",
				),
			},
		).toStrictEqual(
			{
				set: [
					{
						id: "a",
						field: "name",
						html: "<b>Bravo</b>",
					},
				],
				remove: [
					{
						id: "a",
						field: "name",
						html: "Bravo",
					},
				],
			},
		);
	});

	it("sets only the fields lacking the attribute when the selection is mixed", () =>
	{
		expect(
			planItemsAttrToggle(
				[
					{
						id: "a",
						field: "name",
						html: "<b>A</b>",
					},
					{
						id: "c",
						field: "name",
						html: "C",
					},
				],
				"b",
			),
		).toStrictEqual([
			{
				id: "c",
				field: "name",
				html: "<b>C</b>",
			},
		]);
	});

	it("includes notes and skips empty fields", () =>
	{
		expect(
			planItemsAttrToggle(
				[
					{
						id: "a",
						field: "note",
						html: "n",
					},
					{
						id: "b",
						field: "name",
						html: "",
					},
				],
				"i",
			),
		).toStrictEqual([
			{
				id: "a",
				field: "note",
				html: "<i>n</i>",
			},
		]);
	});
});

describe("planItemsCodeToggle", () =>
{
	it("flips each field independently", () =>
	{
		expect(
			planItemsCodeToggle([
				{
					id: "a",
					field: "name",
					html: "<code>A</code>",
				},
				{
					id: "c",
					field: "name",
					html: "C",
				},
			]),
		).toStrictEqual([
			{
				id: "a",
				field: "name",
				html: "A",
			},
			{
				id: "c",
				field: "name",
				html: "<code>C</code>",
			},
		]);
	});

	it("wraps the name and the note of one item separately", () =>
	{
		expect(
			planItemsCodeToggle([
				{
					id: "n",
					field: "name",
					html: "note row",
				},
				{
					id: "n",
					field: "note",
					html: "note <code>n code</code>",
				},
			]),
		).toStrictEqual([
			{
				id: "n",
				field: "name",
				html: "<code>note row</code>",
			},
			{
				id: "n",
				field: "note",
				html: "<code>note n code</code>",
			},
		]);
	});
});

describe("touchesColor", () =>
{
	it("is true only when a colored span overlaps the range", () =>
	{
		const html = 'a <span class="colored bc-yellow">bc</span> d';
		expect([touchesColor(html, 2, 3), touchesColor(html, 0, 1), touchesColor(html, 5, 6)]).toStrictEqual([
			true,
			false,
			false,
		]);
	});

	it("recognizes c-* classes and inline color styles", () =>
	{
		expect([
			touchesColor('<span class="c-red">x</span>', 0, 1),
			touchesColor('<span style="background-color: red">x</span>', 0, 1),
			touchesColor('<span class="other">x</span>', 0, 1),
		]).toStrictEqual([true, true, false]);
	});
});

describe("toggleColor", () =>
{
	const red = '<span class="colored c-red">';
	const yellow = '<span class="colored bc-yellow">';

	it("sets a color on a range and removes it when the whole range already has it", () =>
	{
		const colored = toggleColor("Bravo plain text here", 6, 11, "text", "red");
		expect([colored, toggleColor(colored, 6, 11, "text", "red")]).toStrictEqual([
			`Bravo ${red}plain</span> text here`,
			"Bravo plain text here",
		]);
	});

	it("extends a partial color over the whole range", () =>
	{
		expect(toggleColor(`Bravo ${red}plain</span> text here`, 0, 11, "text", "red")).toBe(
			`${red}Bravo plain</span> text here`,
		);
	});

	it("replaces the other kind of the exclusive group on the range", () =>
	{
		const input = `${red}Bravo plain</span> text here`;
		const highlighted = toggleColor(input, 6, 16, "highlight", "yellow");
		expect([highlighted, toggleColor(highlighted, 0, 5, "text", null)]).toStrictEqual([
			`${red}Bravo </span>${yellow}plain text</span> here`,
			`Bravo${red} </span>${yellow}plain text</span> here`,
		]);
	});

	it("reads an inline style that is a palette shade as a color class and leaves other spans opaque", () =>
	{
		expect([
			serializeInline(parseInline('<span style="color: rgb(224, 36, 36)">x</span>')),
			serializeInline(parseInline('<span style="color: rgb(1, 2, 3)">x</span>')),
			serializeInline(parseInline('<span style="background-color: #FCE96A">x</span>')),
		]).toStrictEqual([`${red}x</span>`, '<span style="color: rgb(1, 2, 3)">x</span>', `${yellow}x</span>`]);
	});

	it("keeps bold toggling working on colored text", () =>
	{
		expect(toggleAttr(`${red}ab</span>`, 0, 1, "b")).toBe(`${red}<b>a</b>b</span>`);
	});
});

describe("colorAt", () =>
{
	const html = 'Bravo <span class="colored bc-yellow">plain text</span> here';

	it("returns the color covering the whole range", () =>
	{
		expect([colorAt(html, 6, 16), colorAt(html, 6, 17), colorAt(html, 0, 3)]).toStrictEqual([
			{
				highlight: "yellow",
			},
			{},
			{},
		]);
	});
});

describe("planItemsColorToggle", () =>
{
	const fields = [
		{
			id: "c",
			field: "name" as const,
			html: "Charlie plain words here",
		},
		{
			id: "d",
			field: "name" as const,
			html: 'Delta <span class="colored bc-green">green hl</span> and <span class="colored c-blue">blue text</span>',
		},
		{
			id: "e",
			field: "note" as const,
			html: "",
		},
	];
	const latest =
	{
		kind: "highlight" as const,
		color: "yellow" as const,
	};

	it("sets the color on every non-empty field, then removes it from all", () =>
	{
		const set = planItemsColorToggle(fields, latest);
		expect(set).toStrictEqual([
			{
				id: "c",
				field: "name",
				html: '<span class="colored bc-yellow">Charlie plain words here</span>',
			},
			{
				id: "d",
				field: "name",
				html: '<span class="colored bc-yellow">Delta green hl and blue text</span>',
			},
		]);
		expect(planItemsColorToggle(set, latest)).toStrictEqual([
			{
				id: "c",
				field: "name",
				html: "Charlie plain words here",
			},
			{
				id: "d",
				field: "name",
				html: "Delta green hl and blue text",
			},
		]);
	});

	it("sets only the fields lacking the color", () =>
	{
		expect(
			planItemsColorToggle(
				[
					{
						id: "a",
						field: "name",
						html: '<span class="colored c-green">A</span>',
					},
					{
						id: "b",
						field: "name",
						html: "B",
					},
				],
				{
					kind: "text",
					color: "green",
				},
			),
		).toStrictEqual([
			{
				id: "b",
				field: "name",
				html: '<span class="colored c-green">B</span>',
			},
		]);
	});
});

describe("pendingFormatApply with a color", () =>
{
	it("wraps the typed character in the latest color", () =>
	{
		expect(
			pendingFormatApply(
				"here",
				4,
				new Set(),
				"z",
				{
					kind: "highlight",
					color: "yellow",
				},
			),
		).toBe('here<span class="colored bc-yellow">z</span>');
	});
});

describe("planItemsColorClear", () =>
{
	it("strips both color kinds from the fields that have one", () =>
	{
		expect(
			planItemsColorClear([
				{
					id: "a",
					field: "name",
					html: 'x <span class="colored c-red">y</span>',
				},
				{
					id: "b",
					field: "name",
					html: "plain",
				},
				{
					id: "c",
					field: "note",
					html: '<span class="colored bc-green">z</span>',
				},
			]),
		).toStrictEqual([
			{
				id: "a",
				field: "name",
				html: "x y",
			},
			{
				id: "c",
				field: "note",
				html: "z",
			},
		]);
	});
});

describe("code is atomic", () =>
{
	it("drops a link inside the range when code is set, keeping its text", () =>
	{
		expect(toggleAttr('go <a href="https://ex.com/z">ex</a> k', 0, 7, "code")).toBe("<code>go ex k</code>");
	});

	it("turns a date pill inside the range back into its text and keeps the selection over it", () =>
	{
		const html = 'on <time startYear="2026" startMonth="10" startDay="1">Oct 1</time> ok';
		expect(
			planInlineToggle(
				html,
				{
					start: 0,
					end: 7,
				},
				"code",
			),
		).toStrictEqual(
			{
				html: "<code>on Oct 1 ok</code>",
				sel:
				{
					start: 0,
					end: 11,
				},
			},
		);
	});

	it("keeps a link when code is removed", () =>
	{
		expect(toggleAttr('<code>go <a href="https://ex.com/z">ex</a></code>', 0, 5, "code")).toBe(
			'go <a href="https://ex.com/z">ex</a>',
		);
	});
});

describe("code across split and merge", () =>
{
	it("keeps code on both sides of a split and merges it back", () =>
	{
		expect([
			splitHtml("split <code>abcd</code> z", 8, 8),
			concatHtml("split <code>ab</code>", "<code>cd</code> z"),
			concatHtml("x <code>a</code>", "<b>b</b>"),
		]).toStrictEqual([
			{
				before: "split <code>ab</code>",
				after: "<code>cd</code> z",
			},
			"split <code>abcd</code> z",
			"x <code>a</code><b>b</b>",
		]);
	});
});
