import {describe, expect, it} from "vite-plus/test";
import
{
	bracketMatch,
	innerText,
	planAutoClose,
	planInsertInlineLink,
	planLinkInsert,
} from "../src/client/inline-link.js";

describe("bracketMatch", () =>
{
	it("finds an empty pair around the caret", () =>
	{
		expect(bracketMatch("Plain P [[]]", 10)).toStrictEqual(
			{
				index: 8,
				text: "[[]]",
			},
		);
	});

	it("finds a pair holding a filter", () =>
	{
		expect(bracketMatch("Plain P [[zq]]", 11)).toStrictEqual(
			{
				index: 8,
				text: "[[zq]]",
			},
		);
	});

	it("misses once the caret is past the pair", () =>
	{
		expect(bracketMatch("Plain P [[zq]]", 14)).toStrictEqual(
			{
				index: -1,
				text: "",
			},
		);
	});

	it("reads the filter between the brackets", () =>
	{
		expect(innerText(bracketMatch("Plain P [[zq]]", 11))).toBe("zq");
	});
});

describe("planAutoClose", () =>
{
	it("closes a freshly typed [[", () =>
	{
		expect(planAutoClose("a [[", 4)).toStrictEqual(
			{
				insertAt: 4,
				text: "]]",
			},
		);
	});

	it("does nothing when a ]] already follows", () =>
	{
		expect(planAutoClose("a [[x]]", 4)).toBeNull();
	});
});

describe("planLinkInsert", () =>
{
	it("replaces the pair with a link and one space, and puts the caret after the space", () =>
	{
		const text = "Plain P [[Target T]]";
		const match = bracketMatch(text, 12);

		expect(planLinkInsert(text, match, "Target T", "https://workflowy.com/#/81df3e9581ea")).toStrictEqual(
			{
				html: 'Plain P <a href="https://workflowy.com/#/81df3e9581ea">Target T</a> ',
				caret: 17,
			},
		);
	});

	it("escapes markup in the label", () =>
	{
		const text = "[[x]]";

		expect(planLinkInsert(text, bracketMatch(text, 3), "A<B>&", "https://workflowy.com/#/81df3e9581ea").html).toBe(
			'<a href="https://workflowy.com/#/81df3e9581ea">A&lt;B&gt;&amp;</a> ',
		);
	});
});

describe("planInsertInlineLink", () =>
{
	it("adds a space before [[ after a word", () =>
	{
		expect(planInsertInlineLink("a", 1)).toStrictEqual(
			{
				text: "a [[",
				caret: 4,
			},
		);
	});

	it("inserts [[ alone in an empty row", () =>
	{
		expect(planInsertInlineLink("", 0)).toStrictEqual(
			{
				text: "[[",
				caret: 2,
			},
		);
	});

	it("inserts [[ alone after a space", () =>
	{
		expect(planInsertInlineLink("a ", 2)).toStrictEqual(
			{
				text: "a [[",
				caret: 4,
			},
		);
	});
});
