// Table paste (upstream `doc/plugins/table_html-pasting` and the markdown `I30`): a TSV block, an HTML `<table>` or a
// markdown pipe table becomes a `Table` item of rows of cells, which `createTrees` writes as `layoutMode: "table"`.
import {escapeHtml} from "./lines.js";
import type {PasteLine} from "./lines.js";
import {inlineMarkdown} from "./markdown.js";

function cell(html: string): PasteLine
{
	return {
		name: html,
		mdBullet: false,
		children: [],
	};
}

function tableLine(rows: readonly (readonly string[])[], rowName: string): PasteLine
{
	return {
		name: "Table",
		mdBullet: false,
		layoutMode: "table",
		children: rows.map((cells) => (
		{
			name: rowName,
			mdBullet: false,
			children: cells.map((html) => cell(html)),
		})),
	};
}

/** A block of 2 or more lines that each have a tab after their first non-space character: rows named "". */
export function parseTsvTable(text: string): PasteLine | null
{
	const lines = text
		.replaceAll("\xA0", " ")
		.split(/\r\n|\r|\n/u)
		.filter((raw) => raw.trim() !== "");
	if (lines.length < 2 || !lines.every((raw) => /\S[^\t]*\t/u.test(raw.trimStart())))
	{
		return null;
	}
	return tableLine(
		lines.map((raw) => raw.split("\t").map((value) => escapeHtml(value.trim()))),
		"",
	);
}

function splitMarkdownRow(row: string): string[]
{
	const body = row.trim().replace(/^\|/u, "").replace(/\|$/u, "");
	const cells: string[] = [];
	let current = "";
	for (let index = 0; index < body.length; index += 1)
	{
		const char = body[index];
		if (char === "\\" && body[index + 1] === "|")
		{
			current += "|";
			index += 1;
		}
		else if (char === "|")
		{
			cells.push(current.trim());
			current = "";
		}
		else
		{
			current += char ?? "";
		}
	}
	cells.push(current.trim());
	return cells;
}

/** A pipe table: a header row, a `---` separator row, then body rows. */
export function parseMarkdownTable(text: string): PasteLine | null
{
	const lines = text.split(/\r\n|\r|\n/u).filter((raw) => raw.trim() !== "");
	const [header, separator, ...body] = lines;
	if (
		header === undefined ||
		separator === undefined ||
		!header.includes("|") ||
		!/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/u.test(separator) ||
		![header, ...body].every((raw) => raw.includes("|"))
	)
	{
		return null;
	}
	return tableLine(
		[header, ...body].map((raw) => splitMarkdownRow(raw).map((value) => inlineMarkdown(escapeHtml(value)))),
		"Row",
	);
}

/** The clipboard HTML is a single `<table>`: rows named "Row", a colspan adding empty cells. */
export function parseHtmlTable(html: string): PasteLine | null
{
	if (!/<table\b/iu.test(html))
	{
		return null;
	}
	const doc = new DOMParser().parseFromString(html, "text/html");
	const tables = doc.querySelectorAll("table");
	const [only] = tables;
	if (only === undefined || tables.length !== 1)
	{
		return null;
	}
	const outside = [...doc.body.childNodes].filter((node) => node !== only && (node.textContent ?? "").trim() !== "");
	if (outside.length > 0)
	{
		return null;
	}
	const rows = [...only.querySelectorAll("tr")].map((tr) =>
		[...tr.children]
			.filter((element) => element.tagName === "TD" || element.tagName === "TH")
			.flatMap((element) =>
			{
				const span = Math.max(1, Number(element.getAttribute("colspan")) || 1);
				const text = escapeHtml(element.textContent.replaceAll(/\s+/gu, " ").trim());
				return [
					text,
					...Array.from(
						{
							length: span - 1,
						},
						() => "",
					),
				];
			}),
	);
	return rows.length === 0 ? null : tableLine(rows, "Row");
}
