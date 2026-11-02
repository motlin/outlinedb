import {describe, expect, it} from "vite-plus/test";
import {insertHelperValue, replaceSearchWord} from "../src/client/search/helper-insert.js";

describe("insertHelperValue", () =>
{
	it("inserts, toggles, and replaces group members like upstream's search helper", () =>
	{
		expect([
			insertHelperValue("", 0, "today"),
			insertHelperValue("today ", 6, "tomorrow"),
			insertHelperValue("tomorrow ", 9, "tomorrow"),
			insertHelperValue("@soPerson ", 10, "changed:"),
			insertHelperValue("next week ", 10, "today"),
			insertHelperValue("apple ", 6, "changed-by:me"),
			insertHelperValue("apple changed-by:me ", 20, "changed-by:others"),
		]).toStrictEqual([
			{
				query: "today ",
				caret: 6,
			},
			{
				query: "tomorrow ",
				caret: 9,
			},
			{
				query: "",
				caret: 0,
			},
			{
				query: "@soPerson changed:",
				caret: 18,
			},
			{
				query: "today ",
				caret: 6,
			},
			{
				query: "apple changed-by:me ",
				caret: 20,
			},
			{
				query: "apple changed-by:others ",
				caret: 24,
			},
		]);
	});

	it("replaces the word under the caret and treats regex characters literally", () =>
	{
		expect([
			insertHelperValue("foo ba", 6, "#tag"),
			insertHelperValue("a+b ", 4, "a+b"),
			insertHelperValue("CHANGED:1H x ", 13, "changed:1h"),
		]).toStrictEqual([
			{
				query: "foo #tag ",
				caret: 9,
			},
			{
				query: "",
				caret: 0,
			},
			{
				query: "x ",
				caret: 2,
			},
		]);
	});
});

describe("replaceSearchWord", () =>
{
	it("replaces the word under the caret with the value and a trailing space, without toggling", () =>
	{
		expect(
			{
				empty: replaceSearchWord("is:", 3, "is:shared"),
				middle: replaceSearchWord("foo is:co bar", 9, "is:complete"),
				afterCaret: replaceSearchWord("is:comp", 4, "is:complete"),
				doubleSpace: replaceSearchWord("a  is:", 6, "is:todo"),
				datePhrase: replaceSearchWord("this week", 9, "is:todo"),
				noToggle: replaceSearchWord("is:complete", 11, "is:complete"),
			},
		).toStrictEqual(
			{
				empty:
				{
					query: "is:shared ",
					caret: 10,
				},
				middle:
				{
					query: "foo is:complete bar",
					caret: 16,
				},
				afterCaret:
				{
					query: "is:complete ",
					caret: 12,
				},
				doubleSpace:
				{
					query: "a  is:todo ",
					caret: 11,
				},
				datePhrase:
				{
					query: "this is:todo ",
					caret: 13,
				},
				noToggle:
				{
					query: "is:complete ",
					caret: 12,
				},
			},
		);
	});

	it("honours trailingSpace and caretOffset for in: values", () =>
	{
		expect(
			replaceSearchWord(
				"is:shared in:",
				13,
				'in:note:""',
				{
					trailingSpace: false,
					caretOffset: -1,
				},
			),
		).toStrictEqual(
			{
				query: 'is:shared in:note:""',
				caret: 19,
			},
		);
	});
});
