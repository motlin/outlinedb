import {describe, expect, it} from "vite-plus/test";
import
{
	applyAccept,
	attach,
	autocompleteSearch,
	currentQuery,
	narrowResults,
	shouldShow,
	spliceAcceptedTag,
} from "../src/client/tag-autocomplete.js";

describe("attach", () =>
{
	it("attaches at a bare # after a space", () =>
	{
		expect(attach("Type here #")).toStrictEqual(
			{
				start: 10,
			},
		);
	});

	it("attaches at a bare # glued to a word", () =>
	{
		expect(attach("foo#")).toStrictEqual(
			{
				start: 3,
			},
		);
	});

	it("attaches at the start of a partial tag", () =>
	{
		expect(attach("Type here #taA")).toStrictEqual(
			{
				start: 10,
			},
		);
	});

	it("does not attach after a tag followed by whitespace", () =>
	{
		expect(attach("#taA ")).toBeNull();
	});
});

describe("currentQuery", () =>
{
	it("returns the typed tag between start and caret", () =>
	{
		expect(currentQuery("x #taA", 2, 6)).toBe("#taA");
	});

	it("returns null when the query contains whitespace", () =>
	{
		expect(currentQuery("x #ta A", 2, 7)).toBeNull();
	});

	it("returns a bare # so the popup can open on it", () =>
	{
		expect(currentQuery("foo#", 3, 4)).toBe("#");
	});

	it("accepts colon-separated segments, including a trailing colon", () =>
	{
		expect([currentQuery("#ta:sub:", 0, 8), currentQuery("#ta::", 0, 5)]).toStrictEqual(["#ta:sub:", "#ta::"]);
	});

	it("returns null when the caret is before the start or at it", () =>
	{
		expect([currentQuery("x #taA", 2, 1), currentQuery("x #taA", 2, 2)]).toStrictEqual([null, null]);
	});

	it("returns null when the start is not a # or @", () =>
	{
		expect(currentQuery("x taA", 2, 5)).toBeNull();
	});

	it("returns null for punctuation inside the body", () =>
	{
		expect(currentQuery("#ta.b", 0, 5)).toBeNull();
	});
});

describe("shouldShow", () =>
{
	it("hides a single result equal to the typed text", () =>
	{
		expect(
			shouldShow(
				[
					{
						tag: "#taBold",
					},
				],
				"#taBold",
			),
		).toBe(false);
	});

	it("hides an empty result list", () =>
	{
		expect(shouldShow([], "#taB")).toBe(false);
	});

	it("shows a single result that extends the typed text", () =>
	{
		expect(
			shouldShow(
				[
					{
						tag: "#taBold",
					},
				],
				"#taBol",
			),
		).toBe(true);
	});

	it("shows several results even when one equals the typed text", () =>
	{
		expect(
			shouldShow(
				[
					{
						tag: "#taBold",
					},
					{
						tag: "#taBolder",
					},
				],
				"#taBold",
			),
		).toBe(true);
	});
});

describe("applyAccept", () =>
{
	it("appends a space when the tag is accepted at the end of the text", () =>
	{
		expect(applyAccept("Type here #taA", 10, 14, "#taApple")).toStrictEqual(
			{
				text: "Type here #taApple ",
				caret: 19,
			},
		);
	});

	it("does not add a space when whitespace already follows", () =>
	{
		expect(applyAccept("a #taA b", 2, 6, "#taApple")).toStrictEqual(
			{
				text: "a #taApple b",
				caret: 10,
			},
		);
	});

	it("adds a space when a non-whitespace character follows", () =>
	{
		expect(applyAccept("#taA,x", 0, 4, "#taApple")).toStrictEqual(
			{
				text: "#taApple ,x",
				caret: 9,
			},
		);
	});

	it("does not add a space after a tag ending in a colon", () =>
	{
		expect(applyAccept("#ta", 0, 3, "#ta:sub:")).toStrictEqual(
			{
				text: "#ta:sub:",
				caret: 8,
			},
		);
	});

	it("replaces only the case-insensitively matching prefix", () =>
	{
		expect(applyAccept("#TAAx", 0, 5, "#taApple")).toStrictEqual(
			{
				text: "#taApple x",
				caret: 9,
			},
		);
	});
});

describe("spliceAcceptedTag", () =>
{
	it("replaces plain-text units inside rich text, escaping the inserted tag", () =>
	{
		expect(
			spliceAcceptedTag(
				"<b>x</b> #ta y",
				{
					start: 2,
					end: 5,
					inserted: "#a&b ",
				},
			),
		).toBe("<b>x</b> #a&amp;b  y");
	});
});

describe("autocompleteSearch", () =>
{
	it("sends the edited field's live text so the server counts it in place of the saved text", () =>
	{
		expect([
			autocompleteSearch(
				{
					root: "z",
					prefix: "#me",
					item: "n1",
					field: "name",
					text: "Plan #me",
				},
			),
			autocompleteSearch(
				{
					root: "",
					prefix: "#",
					item: "n2",
					field: "note",
					text: "x #",
				},
			),
		]).toStrictEqual([
			"root=z&prefix=%23me&limit=8&fallback=1&item=n1&name=Plan+%23me",
			"root=&prefix=%23&limit=8&fallback=1&item=n2&note=x+%23",
		]);
	});
});

describe("narrowResults", () =>
{
	it("keeps results that still start with the query, ignoring case", () =>
	{
		expect([
			narrowResults(
				[
					{
						tag: "#taZebra",
					},
					{
						tag: "#taApple",
					},
				],
				"#taZ",
			),
			narrowResults(
				[
					{
						tag: "#taZebra",
					},
				],
				"#TAZ",
			),
		]).toStrictEqual([
			[
				{
					tag: "#taZebra",
				},
			],
			[
				{
					tag: "#taZebra",
				},
			],
		]);
	});
});
