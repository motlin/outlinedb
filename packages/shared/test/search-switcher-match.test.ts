import {describe, expect, it} from "vite-plus/test";
import {matchField, matchSwitcherRow, splitIntoWords} from "../src/search/index.js";

describe("splitIntoWords", () =>
{
	it("normalises and splits on non-word characters, keeping # and @", () =>
	{
		expect(splitIntoWords("  Café, #Tag @Bob!  ")).toStrictEqual(["cafe", "#tag", "@bob"]);
	});

	it("returns no words for an empty query", () =>
	{
		expect(splitIntoWords("  ")).toStrictEqual([]);
	});
});

describe("matchField", () =>
{
	it("scores hits per text length and highlights each hit", () =>
	{
		expect(matchField(["qwzx"], "deep qwzxchild")).toStrictEqual(
			{
				score: 1 / 14,
				html: "deep <b><u>qwzx</u></b>child",
			},
		);
	});

	it("scores 0 with escaped text when any word misses", () =>
	{
		expect(matchField(["deep", "nope"], "deep <x>")).toStrictEqual(
			{
				score: 0,
				html: "deep &lt;x&gt;",
			},
		);
	});

	it("counts every hit of a repeated word", () =>
	{
		expect(matchField(["ab"], "ab ab")).toStrictEqual(
			{
				score: 2 / 5,
				html: "<b><u>ab</u></b> <b><u>ab</u></b>",
			},
		);
	});
});

describe("matchSwitcherRow", () =>
{
	it("matches a word start inside the name", () =>
	{
		expect(
			matchSwitcherRow(
				{
					name: "deep qwzxchild",
					note: "",
					starLabel: null,
				},
				"qwzx",
			),
		).toStrictEqual(
			{
				labelHtml: "deep <b><u>qwzx</u></b>child",
				searchHtml: null,
			},
		);
	});

	it("does not match mid-word", () =>
	{
		expect(
			matchSwitcherRow(
				{
					name: "apple",
					note: "",
					starLabel: null,
				},
				"pple",
			),
		).toBeNull();
	});

	it("highlights every word, case-insensitively, on the original text", () =>
	{
		expect(
			matchSwitcherRow(
				{
					name: "Qwzx parent page",
					note: "",
					starLabel: null,
				},
				"par qwz",
			),
		).toStrictEqual(
			{
				labelHtml: "<b><u>Qwz</u></b>x <b><u>par</u></b>ent page",
				searchHtml: null,
			},
		);
	});

	it("folds diacritics", () =>
	{
		expect(
			matchSwitcherRow(
				{
					name: "Café",
					note: "",
					starLabel: null,
				},
				"cafe",
			),
		).toStrictEqual(
			{
				labelHtml: "<b><u>Café</u></b>",
				searchHtml: null,
			},
		);
	});

	it("keeps a note-only match with the plain label", () =>
	{
		expect(
			matchSwitcherRow(
				{
					name: "Unrelated row",
					note: "qwzx in note only",
					starLabel: null,
				},
				"qwzx",
			),
		).toStrictEqual(
			{
				labelHtml: "Unrelated row",
				searchHtml: null,
			},
		);
	});

	it("matches a tag with its sigil", () =>
	{
		expect(
			matchSwitcherRow(
				{
					name: "#tag",
					note: "",
					starLabel: null,
				},
				"#tag",
			),
		).toStrictEqual(
			{
				labelHtml: "<b><u>#tag</u></b>",
				searchHtml: null,
			},
		);
	});

	it("treats # as a word character, like upstream's start-of-word regexp", () =>
	{
		expect(
			matchSwitcherRow(
				{
					name: "#tag",
					note: "",
					starLabel: null,
				},
				"tag",
			),
		).toBeNull();
	});

	it("returns the plain escaped label for an empty query", () =>
	{
		expect(
			matchSwitcherRow(
				{
					name: "a<b",
					note: "",
					starLabel: null,
				},
				"",
			),
		).toStrictEqual(
			{
				labelHtml: "a&lt;b",
				searchHtml: null,
			},
		);
	});

	it("matches the plain text of an HTML name", () =>
	{
		expect(
			matchSwitcherRow(
				{
					name: "<b>bold</b> name",
					note: "",
					starLabel: null,
				},
				"bo",
			),
		).toStrictEqual(
			{
				labelHtml: "<b><u>bo</u></b>ld name",
				searchHtml: null,
			},
		);
	});

	it("matches the raw name markup but labels with the plain text", () =>
	{
		expect(
			matchSwitcherRow(
				{
					name: '<a href="https://example.com/zzlink">site</a>',
					note: "",
					starLabel: null,
				},
				"zzlink",
			),
		).toStrictEqual(
			{
				labelHtml: "site",
				searchHtml: null,
			},
		);
	});

	it("highlights a starred search label", () =>
	{
		expect(
			matchSwitcherRow(
				{
					name: "Home",
					note: "",
					starLabel: "#todo later",
				},
				"#todo",
			),
		).toStrictEqual(
			{
				labelHtml: "Home",
				searchHtml: "<b><u>#todo</u></b> later",
			},
		);
	});

	it("requires every word within one field", () =>
	{
		expect(
			matchSwitcherRow(
				{
					name: "alpha",
					note: "beta",
					starLabel: null,
				},
				"alpha beta",
			),
		).toBeNull();
	});
});
