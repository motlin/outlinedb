import {describe, expect, it} from "vite-plus/test";
import {operatorAutocomplete, tagAutocompleteRows} from "../src/client/search/autocomplete-values.js";

const OPTIONS =
{
	now: new Date(2026, 9, 23, 11, 1),
	dateFormat: "YYYY-MM-DD",
	timeFormat: "HH:mm",
};

function pairs(word: string): string[][]
{
	return operatorAutocomplete(word, OPTIONS).map((row) => [row.label, row.value]);
}

describe("operatorAutocomplete", () =>
{
	it("lists the locally supported is: options in upstream order", () =>
	{
		expect(pairs("is:")).toStrictEqual([
			["complete", "is:complete"],
			["mirror", "is:mirror"],
			["todo", "is:todo"],
			["divider", "is:divider"],
			["h1", "is:h1"],
			["h2", "is:h2"],
			["h3", "is:h3"],
			["paragraph", "is:paragraph"],
			["code-block", "is:code-block"],
			["quote", "is:quote"],
		]);
	});

	it("matches by value or label prefix, case-insensitively", () =>
	{
		expect(pairs("is:c")).toStrictEqual([
			["complete", "is:complete"],
			["code-block", "is:code-block"],
		]);
	});

	it("keeps a fully typed lowercase value (the capitalized value never equals it)", () =>
	{
		expect(pairs("is:complete")).toStrictEqual([["complete", "is:complete"]]);
	});

	it("returns nothing for a capitalized value, a capitalized operator, no colon, a second colon or unknown operators", () =>
	{
		expect(
			{
				capitalizedValue: pairs("is:Complete"),
				capitalizedOperator: pairs("IS:"),
				noColon: pairs("is"),
				secondColon: pairs("is:a:b"),
				link: pairs("link:"),
				changedBy: pairs("changed-by:"),
				negated: pairs("-is:"),
				quoted: pairs('"is:'),
			},
		).toStrictEqual(
			{
				capitalizedValue: [],
				capitalizedOperator: [],
				noColon: [],
				secondColon: [],
				link: [],
				changedBy: [],
				negated: [],
				quoted: [],
			},
		);
	});

	it("sorts has: options by displayOrder", () =>
	{
		expect(pairs("has:")).toStrictEqual([
			["note", "has:note"],
			["children", "has:children"],
			["date", "has:date"],
			["file", "has:file"],
			["image", "has:image"],
			["video", "has:video"],
			["tweet", "has:tweet"],
		]);
	});

	it("lists text: colours first, then colored and highlighted, then styles", () =>
	{
		expect(pairs("text:b")).toStrictEqual([
			["blue", "text:blue"],
			["bold", "text:bold"],
		]);
		expect(pairs("text:").map(([label]) => label)).toStrictEqual([
			"red",
			"orange",
			"yellow",
			"green",
			"teal",
			"sky",
			"blue",
			"purple",
			"pink",
			"gray",
			"colored",
			"highlighted",
			"bold",
			"italic",
			"underline",
			"strikethrough",
			"code",
		]);
	});

	it("gives text: colours a text swatch and highlight: colours a background swatch", () =>
	{
		expect(
			{
				text: operatorAutocomplete("text:red", OPTIONS)[0]?.icon,
				highlight: operatorAutocomplete("highlight:red", OPTIONS)[0]?.icon,
				colored: operatorAutocomplete("text:col", OPTIONS)[0]?.icon,
			},
		).toStrictEqual(
			{
				text:
				{
					swatch: "text",
					color: "red",
				},
				highlight:
				{
					swatch: "background",
					color: "red",
				},
				colored: "fal:paint-brush",
			},
		);
	});

	it("lowercases day-of-week values and capitalizes their labels", () =>
	{
		expect(pairs("day-of-week:f")).toStrictEqual([["Friday", "day-of-week:friday"]]);
	});

	it("lists changed: and created: relative windows", () =>
	{
		expect(
			{
				changed: pairs("changed:"),
				created: pairs("created:7"),
			},
		).toStrictEqual(
			{
				changed: [
					["1 hour", "changed:1h"],
					["1 day", "changed:1d"],
					["1 week", "changed:7d"],
				],
				created: [["1 week", "created:7d"]],
			},
		);
	});

	it("lists date: past, future and today in the account formats", () =>
	{
		expect(pairs("date:")).toStrictEqual([
			["past", "date:past"],
			["future", "date:future"],
			["10-23", "date:10-23"],
			["10-23@11:01", "date:10-23@11:01"],
			["2026-10-23", "date:2026-10-23"],
		]);
	});

	it("makes in:note insert a quoted value with the caret between the quotes", () =>
	{
		expect(operatorAutocomplete("in:", OPTIONS)).toStrictEqual([
			{
				type: "row",
				label: "note",
				value: "in:note",
				insert:
				{
					suffix: ':""',
					trailingSpace: false,
					caretOffset: -1,
				},
			},
		]);
	});
});

describe("tagAutocompleteRows", () =>
{
	it("prepends a Tags header for @ words with tags only", () =>
	{
		expect(
			{
				at: tagAutocompleteRows("@s", ["@sa", "@sb"]),
				atNone: tagAutocompleteRows("@s", []),
				hash: tagAutocompleteRows("#s", ["#sa"]),
				other: tagAutocompleteRows("is:", ["#sa"]),
			},
		).toStrictEqual(
			{
				at: [
					{
						type: "header",
						label: "Tags",
					},
					{
						type: "row",
						label: "@sa",
						value: "@sa",
					},
					{
						type: "row",
						label: "@sb",
						value: "@sb",
					},
				],
				atNone: [],
				hash: [
					{
						type: "row",
						label: "#sa",
						value: "#sa",
					},
				],
				other: [],
			},
		);
	});
});
