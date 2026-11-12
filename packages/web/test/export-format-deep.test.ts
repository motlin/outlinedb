// @vitest-environment happy-dom
import {describe, expect, it} from "vite-plus/test";
import {formatToString, linkParents} from "../src/client/export-format.js";
import type {ExportItem} from "../src/client/export-format.js";
import expected from "./fixtures/export-format-deep-expected.json" with {type: "json"};

let counter = 0;

interface Options
{
	note?: string;
	layoutMode?: string;
	completed?: boolean;
}

function mk(name: string, options: Options = {}, children: ExportItem[] = []): ExportItem
{
	counter += 1;
	return {
		id: `00000000-0000-0000-0000-${String(counter).padStart(12, "0")}`,
		name,
		note: options.note ?? "",
		layoutMode: options.layoutMode ?? null,
		numberedStart: null,
		completed: options.completed ?? false,
		parent: null,
		children,
	};
}

function deep():
{
	root: ExportItem;
	table: ExportItem;
	todo: ExportItem;
}
{
	counter = 0;
	const table = mk(
		"Table",
		{
			layoutMode: "table",
		},
		[mk("r1c1", {}, [mk("r1c2")]), mk("r2c1", {}, [mk("r2c2")])],
	);
	const todo = mk(
		"Todo",
		{
			layoutMode: "todo",
		},
		[
			mk("Open task"),
			mk(
				"Done task",
				{
					completed: true,
				},
			),
		],
	);
	const root = mk(
		'🧪 Export: deep &amp; "fixture"!',
		{
			note: "line one\nline two & <three>",
		},
		[
			mk(
				"Heading two",
				{
					layoutMode: "h2",
				},
			),
			mk(
				"Heading three",
				{
					layoutMode: "h3",
				},
			),
			mk(
				"Paragraph text",
				{
					layoutMode: "p",
				},
			),
			mk(
				"const a = 1; const b = 2;",
				{
					layoutMode: "code-block",
				},
			),
			mk(
				"Quote here",
				{
					layoutMode: "quote-block",
				},
			),
			mk(
				'<span class="colored c-red">red</span> <span class="colored bc-yellow">hl</span> <s>struck</s> <b><i>bi</i></b>',
			),
			mk('Date <time startYear="2026" startMonth="10" startDay="1">Thu, Oct 1, 2026</time> end'),
			mk('Link <a href="https://workflowy.com/#/ab03ee6d2ae0">sandbox</a> and https://example.com/x?y=1&amp;z=2'),
			mk(
				"Board",
				{
					layoutMode: "board",
				},
				[mk("Col A", {}, [mk("Card 1")]), mk("Col B")],
			),
			table,
			todo,
			mk(
				"Nested numbered",
				{
					layoutMode: "numbered",
				},
				[
					mk(
						"N1",
						{
							layoutMode: "numbered",
						},
					),
					mk(
						"N2",
						{
							layoutMode: "numbered",
						},
						[
							mk(
								"N2a",
								{
									layoutMode: "numbered",
								},
							),
						],
					),
				],
			),
			mk(
				"Divider titled",
				{
					layoutMode: "divider",
				},
			),
			mk(
				"",
				{
					note: "empty name with note",
				},
			),
		],
	);
	linkParents([root]);
	return {
		root,
		table,
		todo,
	};
}

const hideCompleted = (item: ExportItem): ExportItem[] => item.children.filter((child) => !child.completed);
const options =
{
	ownerEmail: "user@example.com",
};

/** Real ids differ from the fixture's: rename each distinct 12-hex id to its order of first appearance. */
function canonicalIds(html: string): string
{
	const seen = new Map<string, number>();
	return html.replaceAll(/data-(wfid|chid|parent)="([0-9a-f]{12})"/gu, (_match, kind: string, id: string) =>
	{
		if (!seen.has(id))
		{
			seen.set(id, seen.size);
		}
		return `data-${kind}="#${seen.get(id)}"`;
	});
}

describe("export formatters on layout-rich rows", () =>
{
	it("plain text, hiding completed rows", () =>
	{
		const {root} = deep();
		expect(formatToString("text", [root], hideCompleted)).toStrictEqual(expected.single_text);
	});

	it("plain text, two roots", () =>
	{
		const {table, todo} = deep();
		expect(formatToString("text", [table, todo], hideCompleted)).toStrictEqual(expected.multi_text);
	});

	it("plain text, completed shown", () =>
	{
		const {todo} = deep();
		expect(formatToString("text", [todo])).toStrictEqual(expected.shown_text);
	});

	it("markdown, hiding completed rows", () =>
	{
		const {root} = deep();
		expect(formatToString("markdown", [root], hideCompleted)).toStrictEqual(expected.single_markdown);
	});

	it("markdown, two roots", () =>
	{
		const {table, todo} = deep();
		expect(formatToString("markdown", [table, todo], hideCompleted)).toStrictEqual(expected.multi_markdown);
	});

	it("markdown, completed shown", () =>
	{
		const {todo} = deep();
		expect(formatToString("markdown", [todo])).toStrictEqual(expected.shown_markdown);
	});

	it("opml, hiding completed rows", () =>
	{
		const {root} = deep();
		expect(formatToString("opml", [root], hideCompleted, options)).toStrictEqual(expected.single_opml);
	});

	it("opml, two roots", () =>
	{
		const {table, todo} = deep();
		expect(formatToString("opml", [table, todo], hideCompleted, options)).toStrictEqual(expected.multi_opml);
	});

	it("html, hiding completed rows", () =>
	{
		const {root} = deep();
		expect(canonicalIds(formatToString("html", [root], hideCompleted))).toStrictEqual(
			canonicalIds(expected.single_html),
		);
	});

	it("html, two roots", () =>
	{
		const {table, todo} = deep();
		expect(canonicalIds(formatToString("html", [table, todo], hideCompleted))).toStrictEqual(
			canonicalIds(expected.multi_html),
		);
	});

	it("runs the post-format step on every chunk", () =>
	{
		counter = 0;
		const items = linkParents([mk("Leaf only")]);
		const crlf = (chunk: string): string => chunk.replaceAll("\n", "\r\n");
		expect(
			formatToString(
				"text",
				items,
				undefined,
				{
					postFormat: crlf,
				},
			),
		).toBe("Leaf only\r\n\r\n");
	});
});
