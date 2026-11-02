import {describe, expect, it} from "vite-plus/test";
import {planBlockPrefix, prefixedName} from "../src/client/block-prefix.js";
import type {BlockPrefixPlan} from "../src/client/block-prefix.js";

const FENCE = "```";

describe("planBlockPrefix", () =>
{
	it.each([
		["[] ", 3, false],
		["[ ] ", 4, false],
		["[x] ", 4, true],
		["[+] ", 4, true],
		["[-] ", 4, true],
	])("turns %j into a to-do", (before, strip, complete) =>
	{
		expect(
			planBlockPrefix(
				{
					before,
					after: "foo",
					layoutMode: null,
				},
			),
		).toStrictEqual(
			{
				kind: "strip",
				strip,
				layoutMode: "todo",
				complete,
			},
		);
	});

	it("fires on an existing to-do too", () =>
	{
		expect(
			planBlockPrefix(
				{
					before: "[ ] ",
					after: "foo",
					layoutMode: "todo",
				},
			),
		).toStrictEqual(
			{
				kind: "strip",
				strip: 4,
				layoutMode: "todo",
				complete: false,
			},
		);
	});

	it("reads a non-breaking space as a space", () =>
	{
		expect(
			planBlockPrefix(
				{
					before: "[] ",
					after: "",
					layoutMode: null,
				},
			),
		).toStrictEqual(
			{
				kind: "strip",
				strip: 3,
				layoutMode: "todo",
				complete: false,
			},
		);
	});

	it.each([
		["[X] ", ""],
		["x[] ", ""],
		["a# ", ""],
		["#", ""],
	])("ignores %j", (before, after) =>
	{
		expect(
			planBlockPrefix(
				{
					before,
					after,
					layoutMode: null,
				},
			),
		).toBeNull();
	});

	it.each([
		["# ", null, "h1", 2],
		["## ", "h1", "h2", 3],
		["### ", "todo", "h3", 4],
		["# ", "h1", "bullets", 2],
		["# ", "paragraph", "h1", 2],
		["# ", "p", "h1", 2],
	])("toggles heading %j on %j into %j", (before, layoutMode, target, strip) =>
	{
		expect(
			planBlockPrefix(
				{
					before,
					after: "",
					layoutMode,
				},
			),
		).toStrictEqual(
			{
				kind: "strip",
				strip,
				layoutMode: target,
				complete: false,
			},
		);
	});

	it("turns > into a quote unless already one", () =>
	{
		expect(
			{
				fresh: planBlockPrefix(
					{
						before: "> ",
						after: "x",
						layoutMode: null,
					},
				),
				quote: planBlockPrefix(
					{
						before: "> ",
						after: "",
						layoutMode: "quote-block",
					},
				),
				legacy: planBlockPrefix(
					{
						before: "> ",
						after: "",
						layoutMode: "quote",
					},
				),
			},
		).toStrictEqual(
			{
				fresh:
				{
					kind: "strip",
					strip: 2,
					layoutMode: "quote-block",
					complete: false,
				},
				quote: null,
				legacy: null,
			},
		);
	});

	it("turns three backticks into a code block unless already one", () =>
	{
		expect(
			{
				fresh: planBlockPrefix(
					{
						before: FENCE,
						after: "y",
						layoutMode: null,
					},
				),
				code: planBlockPrefix(
					{
						before: FENCE,
						after: "y",
						layoutMode: "code-block",
					},
				),
			},
		).toStrictEqual(
			{
				fresh:
				{
					kind: "code",
					strip: 3,
					layoutMode: "code-block",
					complete: false,
				},
				code: null,
			},
		);
	});

	it("turns a dash rule into a divider", () =>
	{
		expect(
			{
				empty: planBlockPrefix(
					{
						before: "--- ",
						after: "",
						layoutMode: null,
					},
				),
				spaced: planBlockPrefix(
					{
						before: "- - - ",
						after: "abc",
						layoutMode: "h2",
					},
				),
				already: planBlockPrefix(
					{
						before: "--- ",
						after: "",
						layoutMode: "divider",
					},
				),
			},
		).toStrictEqual(
			{
				empty:
				{
					kind: "clear",
					strip: 4,
					layoutMode: "divider",
					complete: false,
				},
				spaced:
				{
					kind: "divider-above",
					strip: 6,
					layoutMode: "h2",
					complete: false,
				},
				already: null,
			},
		);
	});

	it("turns N. on an empty row into a numbered list starting at N", () =>
	{
		expect(
			{
				empty: planBlockPrefix(
					{
						before: "12. ",
						after: "",
						layoutMode: null,
					},
				),
				withText: planBlockPrefix(
					{
						before: "12. ",
						after: "x",
						layoutMode: null,
					},
				),
				already: planBlockPrefix(
					{
						before: "1. ",
						after: "",
						layoutMode: "numbered",
					},
				),
			},
		).toStrictEqual(
			{
				empty:
				{
					kind: "clear",
					strip: 4,
					layoutMode: "numbered",
					complete: false,
					numberedStart: 12,
				},
				withText: null,
				already: null,
			},
		);
	});
});

describe("prefixedName", () =>
{
	const todo: BlockPrefixPlan =
	{
		kind: "strip",
		strip: 3,
		layoutMode: "todo",
		complete: false,
	};
	const quote: BlockPrefixPlan =
	{
		kind: "strip",
		strip: 2,
		layoutMode: "quote-block",
		complete: false,
	};
	const code: BlockPrefixPlan =
	{
		kind: "code",
		strip: 3,
		layoutMode: "code-block",
		complete: false,
	};
	const dividerAbove: BlockPrefixPlan =
	{
		kind: "divider-above",
		strip: 6,
		layoutMode: "h2",
		complete: false,
	};
	const numbered: BlockPrefixPlan =
	{
		kind: "clear",
		strip: 3,
		layoutMode: "numbered",
		complete: false,
		numberedStart: 3,
	};

	it.each([
		["[] <b>foo</b>", todo, "<b>foo</b>"],
		["<b>[] foo</b>", todo, "<b>foo</b>"],
		["&gt; a &amp; b", quote, "a &amp; b"],
		[`${FENCE}<b>y</b>`, code, "y"],
		["- - - a&lt;b", dividerAbove, "a&lt;b"],
		["3. ", numbered, ""],
	])("%j gives %j", (html, plan, expected) =>
	{
		expect(prefixedName(html, plan, "￼")).toBe(expected);
	});
});
