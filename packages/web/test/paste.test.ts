import {describe, expect, it} from "vite-plus/test";
import {buildPlainLines, escapeHtml} from "../src/client/paste/lines.js";
import {applyMarkdown, inlineMarkdown} from "../src/client/paste/markdown.js";

describe("paste lines", () =>
{
	describe("escapeHtml", () =>
	{
		it("escapes ampersand first, then angle brackets", () =>
		{
			expect(escapeHtml("<b>x</b> & y")).toBe("&lt;b&gt;x&lt;/b&gt; &amp; y");
		});
	});

	describe("buildPlainLines", () =>
	{
		it("nests by leading whitespace", () =>
		{
			expect(buildPlainLines("one\ntwo\n  three\nfour")).toStrictEqual([
				{
					name: "one",
					mdBullet: false,
					children: [],
				},
				{
					name: "two",
					mdBullet: false,
					children: [
						{
							name: "three",
							mdBullet: false,
							children: [],
						},
					],
				},
				{
					name: "four",
					mdBullet: false,
					children: [],
				},
			]);
		});

		it("escapes a single line and keeps its whitespace", () =>
		{
			expect(buildPlainLines("<b>x</b> & y")).toStrictEqual([
				{
					name: "&lt;b&gt;x&lt;/b&gt; &amp; y",
					mdBullet: false,
					children: [],
				},
			]);
			expect(buildPlainLines("   x  ")).toStrictEqual([
				{
					name: "   x  ",
					mdBullet: false,
					children: [],
				},
			]);
		});

		it("ranks distinct indent widths into levels", () =>
		{
			expect(buildPlainLines("a\n    b\n        c")).toStrictEqual([
				{
					name: "a",
					mdBullet: false,
					children: [
						{
							name: "b",
							mdBullet: false,
							children: [
								{
									name: "c",
									mdBullet: false,
									children: [],
								},
							],
						},
					],
				},
			]);
		});

		it("marks unindented dash and star lines as markdown bullets", () =>
		{
			expect(buildPlainLines("- a\n* b")).toStrictEqual([
				{
					name: "a",
					mdBullet: true,
					children: [],
				},
				{
					name: "b",
					mdBullet: true,
					children: [],
				},
			]);
		});

		it("drops blank lines and strips indented markers without marking them", () =>
		{
			expect(buildPlainLines("\n- a\n  - b\n    - c\n- d")).toStrictEqual([
				{
					name: "a",
					mdBullet: true,
					children: [
						{
							name: "b",
							mdBullet: false,
							children: [
								{
									name: "c",
									mdBullet: false,
									children: [],
								},
							],
						},
					],
				},
				{
					name: "d",
					mdBullet: true,
					children: [],
				},
			]);
		});

		it("strips the first line's leading whitespace when there are 2+ lines", () =>
		{
			expect(buildPlainLines(" t1\nt2").map((line) => line.name)).toStrictEqual(["t1", "t2"]);
		});

		it("keeps a divider line", () =>
		{
			expect(buildPlainLines("a\n- - -").map((line) => line.name)).toStrictEqual(["a", "- - -"]);
		});

		it("returns nothing for whitespace only", () =>
		{
			expect(buildPlainLines("   \n  \n")).toStrictEqual([]);
		});

		it("turns non-breaking spaces into spaces", () =>
		{
			expect(buildPlainLines("T1  x")).toStrictEqual([
				{
					name: "T1  x",
					mdBullet: false,
					children: [],
				},
			]);
		});
	});
});

describe("paste markdown", () =>
{
	const U4 = [
		"# Head",
		"- item **bold** and *it* and _u_ and ~~s~~ and `c`",
		"  - child [link](https://e.com/x)",
		"- [ ] todo open",
		"- [x] todo done",
		"1. first",
		"2. second",
		"> quote",
		"---",
		"plain line",
	].join("\n");

	describe("applyMarkdown", () =>
	{
		it("turns the upstream U4 sample into layouts and inline formatting", () =>
		{
			expect(applyMarkdown(buildPlainLines(U4))).toStrictEqual([
				{
					name: "Head",
					mdBullet: false,
					layoutMode: "h1",
					children: [],
				},
				{
					name: "item <b>bold</b> and <i>it</i> and <i>u</i> and <s>s</s> and <code>c</code>",
					mdBullet: true,
					layoutMode: "bullet",
					children: [
						{
							name: 'child <a href="https://e.com/x">link</a>',
							mdBullet: false,
							children: [],
						},
					],
				},
				{
					name: "todo open",
					mdBullet: true,
					layoutMode: "todo",
					children: [],
				},
				{
					name: "todo done",
					mdBullet: true,
					layoutMode: "todo",
					complete: true,
					children: [],
				},
				{
					name: "first",
					mdBullet: false,
					layoutMode: "numbered",
					numberedStart: 1,
					children: [],
				},
				{
					name: "second",
					mdBullet: false,
					layoutMode: "numbered",
					numberedStart: 2,
					children: [],
				},
				{
					name: "quote",
					mdBullet: false,
					layoutMode: "quote-block",
					children: [],
				},
				{
					name: "",
					mdBullet: false,
					layoutMode: "divider",
					children: [],
				},
				{
					name: "plain line",
					mdBullet: false,
					layoutMode: "p",
					children: [],
				},
			]);
		});

		it("handles the U9 single lines", () =>
		{
			const one = (text: string) => applyMarkdown(buildPlainLines(text));
			expect(one("# Title")).toStrictEqual([
				{
					name: "Title",
					mdBullet: false,
					layoutMode: "h1",
					children: [],
				},
			]);
			expect(one("**just bold**")).toStrictEqual([
				{
					name: "<b>just bold</b>",
					mdBullet: false,
					children: [],
				},
			]);
			expect(one("- [ ] task")).toStrictEqual([
				{
					name: "task",
					mdBullet: false,
					layoutMode: "todo",
					children: [],
				},
			]);
			expect(one("[1] see source\n[2] other")).toStrictEqual([
				{
					name: "[1] see source",
					mdBullet: false,
					children: [],
				},
				{
					name: "[2] other",
					mdBullet: false,
					children: [],
				},
			]);
		});

		it("collapses a fence into one code-block row (U11)", () =>
		{
			expect(applyMarkdown(buildPlainLines("```\ncode a\n  code b\n```\nafter"))).toStrictEqual([
				{
					name: "code a\n  code b",
					mdBullet: false,
					layoutMode: "code-block",
					children: [],
				},
				{
					name: "after",
					mdBullet: false,
					children: [],
				},
			]);
		});

		it("keeps an unclosed fence as plain lines", () =>
		{
			expect(applyMarkdown(buildPlainLines("```\nx")).map((line) => line.name)).toStrictEqual(["```", "x"]);
		});

		it("marks bullets from mdBullet only", () =>
		{
			expect(applyMarkdown(buildPlainLines("- a\n- b"))).toStrictEqual([
				{
					name: "a",
					mdBullet: true,
					layoutMode: "bullet",
					children: [],
				},
				{
					name: "b",
					mdBullet: true,
					layoutMode: "bullet",
					children: [],
				},
			]);
		});
	});

	describe("inlineMarkdown", () =>
	{
		it("does not italicize underscores inside words", () =>
		{
			expect(inlineMarkdown("snake_case_name and _it_")).toBe("snake_case_name and <i>it</i>");
		});

		it("leaves formatting inside code spans alone", () =>
		{
			expect(inlineMarkdown("`**x**`")).toBe("<code>**x**</code>");
		});
	});
});
