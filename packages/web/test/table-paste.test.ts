// @vitest-environment happy-dom
import {describe, expect, it} from "vite-plus/test";
import {buildPasteLines} from "../src/client/paste/apply.js";
import {parseHtmlTable, parseMarkdownTable, parseTsvTable} from "../src/client/paste/table.js";
import type {PasteLine} from "../src/client/paste/lines.js";

function line(name: string, children: PasteLine[] = [], extra: Partial<PasteLine> = {}): PasteLine
{
	return {
		name,
		mdBullet: false,
		children,
		...extra,
	};
}

function table(rows: string[][], rowName: string): PasteLine
{
	return line(
		"Table",
		rows.map((cells) =>
			line(
				rowName,
				cells.map((cell) => line(cell)),
			),
		),
		{
			layoutMode: "table",
		},
	);
}

describe("table paste", () =>
{
	it("turns a TSV block into a Table of unnamed rows", () =>
	{
		expect(parseTsvTable("a\tb\nc\td")).toStrictEqual(
			table(
				[
					["a", "b"],
					["c", "d"],
				],
				"",
			),
		);
	});

	it("keeps empty TSV cells and escapes their text", () =>
	{
		expect(parseTsvTable("a\t\tb<\nc\td\te")).toStrictEqual(
			table(
				[
					["a", "", "b&lt;"],
					["c", "d", "e"],
				],
				"",
			),
		);
	});

	it("does not take one line, or lines without tabs, for a table", () =>
	{
		expect([parseTsvTable("a\tb"), parseTsvTable("a b\nc d"), parseTsvTable("a\tb\nc d")]).toStrictEqual([
			null,
			null,
			null,
		]);
	});

	it("turns an HTML table into Row rows, a colspan adding empty cells", () =>
	{
		const html =
			'<table><thead><tr><th>Name</th><th colspan="2">Qty</th></tr></thead><tbody><tr><td>Apple</td><td>3</td><td></td></tr></tbody></table>';
		expect(parseHtmlTable(html)).toStrictEqual(
			table(
				[
					["Name", "Qty", ""],
					["Apple", "3", ""],
				],
				"Row",
			),
		);
	});

	it("ignores HTML that holds more than a table", () =>
	{
		expect(parseHtmlTable("<p>before</p><table><tr><td>a</td></tr></table>")).toBeNull();
	});

	it("turns a markdown pipe table into a table whose first row is the header", () =>
	{
		expect(parseMarkdownTable("| Name | Qty |\n| --- | --- |\n| Apple | **3** |")).toStrictEqual(
			table(
				[
					["Name", "Qty"],
					["Apple", "<b>3</b>"],
				],
				"Row",
			),
		);
	});

	it("routes a table clipboard through buildPasteLines, preferring the HTML table over its TSV text", () =>
	{
		expect(
			buildPasteLines(
				{
					text: "a\tb\nc\td",
					html: "<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>",
				},
			),
		).toStrictEqual([
			table(
				[
					["a", "b"],
					["c", "d"],
				],
				"Row",
			),
		]);
		expect(
			buildPasteLines(
				{
					text: "a\tb\nc\td",
				},
			),
		).toStrictEqual([
			table(
				[
					["a", "b"],
					["c", "d"],
				],
				"",
			),
		]);
	});
});
