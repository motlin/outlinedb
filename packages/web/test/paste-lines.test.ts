import {describe, expect, it} from "vite-plus/test";
import {buildPlainLines, escapeHtml} from "../src/client/paste/lines.js";

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
