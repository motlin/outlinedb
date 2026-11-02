// Planning a paste (upstream `pD4` / `LD4`): which source the lines come from, and what the row, its children and its
// following siblings become. Pure: the editor runs the plan.
import {parseHtmlTable, parseMarkdownTable, parseTsvTable} from "./table.js";
import {findAutoLinks} from "../auto-link.js";
import {concatHtml, plainLength} from "../rich-text.js";
import {isFeatureOn} from "../features.js";
import {applyMarkdown} from "./markdown.js";
import {buildHtmlLines, hasRichContent} from "./html.js";
import {escapeHtml, buildPlainLines} from "./lines.js";
import type {PasteLine} from "./lines.js";
import {buildOpmlLines, isOpml} from "./opml.js";

const PASTE_LIMIT = 10_000;
export const PASTE_LIMIT_ALERT = "Pasting more than 10000 items at a time is not supported.";

/** A row to create, in the shape `POST /api/v1/nodes/trees` takes. */
export interface PasteTree
{
	name: string;
	note?: string;
	completed?: boolean;
	layoutMode?: string;
	numberedStart?: number;
	children?: PasteTree[];
}

export interface CurrentRowChange
{
	note?: string;
	complete?: boolean;
	layoutMode?: string;
	numberedStart?: number;
}

export interface PastePlan
{
	/** The row's new name; null leaves it (and the selection) untouched. */
	currentName: string | null;
	current?: CurrentRowChange;
	/** Created as the row's first children (the row opens), or the zoom root's when it is the title. */
	childTrees: PasteTree[];
	/** Created right after the row. */
	siblingTrees: PasteTree[];
	caret:
	{
		row: "current" | "lastCreated";
		offset: number | "end";
	};
}

export type RowKind = "zoomRoot" | "leaf" | "branch";

/** The lines a paste carries. `plain` (paste and match style) ignores the clipboard html. */
export function buildPasteLines({
	text,
	html,
	plain = false,
}: {
	text: string;
	html?: string;
	plain?: boolean;
}): PasteLine[]
{
	if (isOpml(text))
	{
		return buildOpmlLines(text);
	}
	const table =
		(!plain && html !== undefined ? parseHtmlTable(html) : null) ?? parseTsvTable(text) ?? parseMarkdownTable(text);
	if (table !== null)
	{
		return [table];
	}
	const lines = !plain && html !== undefined && hasRichContent(html) ? buildHtmlLines(html) : buildPlainLines(text);
	return isFeatureOn("markdown_pasting") ? applyMarkdown(lines) : lines;
}

function toTree(line: PasteLine): PasteTree
{
	const children = line.children.map(toTree);
	return {
		name: line.name.trim(),
		...(line.note === undefined
			? {}
			:
				{
					note: line.note,
				}),
		...(line.complete === true
			?
				{
					completed: true,
				}
			: {}),
		...(line.layoutMode === undefined
			? {}
			:
				{
					layoutMode: line.layoutMode,
				}),
		...(line.numberedStart === undefined
			? {}
			:
				{
					numberedStart: line.numberedStart,
				}),
		...(children.length === 0
			? {}
			:
				{
					children,
				}),
	};
}

function countLines(lines: readonly PasteLine[]): number
{
	return lines.reduce((total, line) => total + 1 + countLines(line.children), 0);
}

/** Wrap bare urls, emails and phone numbers in text outside tags and existing links. */
function linkifyHtml(html: string): string
{
	let anchorDepth = 0;
	return html
		.split(/(<[^>]*>)/u)
		.map((part) =>
		{
			if (part.startsWith("<"))
			{
				if (/^<a\b/iu.test(part))
				{
					anchorDepth += 1;
				}
				else if (/^<\/a\s*>/iu.test(part))
				{
					anchorDepth -= 1;
				}
				return part;
			}
			if (anchorDepth > 0 || part === "")
			{
				return part;
			}
			let out = "";
			let at = 0;
			for (const link of findAutoLinks(part, []))
			{
				out += `${part.slice(at, link.start)}<a href="${link.href}">${part.slice(link.start, link.end)}</a>`;
				at = link.end;
			}
			return out + part.slice(at);
		})
		.join("");
}

function currentChange(line: PasteLine): CurrentRowChange | undefined
{
	const change: CurrentRowChange =
	{
		...(line.note === undefined
			? {}
			:
				{
					note: line.note,
				}),
		...(line.complete === true
			?
				{
					complete: true,
				}
			: {}),
		...(line.layoutMode === undefined
			? {}
			:
				{
					layoutMode: line.layoutMode,
				}),
		...(line.numberedStart === undefined
			? {}
			:
				{
					numberedStart: line.numberedStart,
				}),
	};
	return Object.keys(change).length === 0 ? undefined : change;
}

function trimEndHtml(html: string): string
{
	return html.replace(/\s+$/u, "");
}

/** What a paste of `lines` does to a row whose name is split around the selection into `before` and `after`. */
export function planPasteApply({
	before,
	after,
	lines,
	rowKind,
}: {
	before: string;
	after: string;
	lines: readonly PasteLine[];
	rowKind: RowKind;
}):
	| PastePlan
	|
	  {
			alert: string;
	  }
{
	if (countLines(lines) > PASTE_LIMIT)
	{
		return {
			alert: PASTE_LIMIT_ALERT,
		};
	}
	const [first] = lines;
	if (first === undefined)
	{
		return {
			currentName: concatHtml(before, after),
			childTrees: [],
			siblingTrees: [],
			caret:
			{
				row: "current",
				offset: plainLength(before),
			},
		};
	}
	const splices =
		lines.length === 1 && first.children.length === 0 && first.note === undefined && first.complete !== true;
	if (splices)
	{
		const merged = concatHtml(before, linkifyHtml(first.name));
		const change = currentChange(first);
		return {
			currentName: concatHtml(merged, after),
			...(change === undefined
				? {}
				:
					{
						current: change,
					}),
			childTrees: [],
			siblingTrees: [],
			caret:
			{
				row: "current",
				offset: plainLength(merged),
			},
		};
	}
	if (rowKind === "zoomRoot")
	{
		return {
			currentName: null,
			childTrees: lines.map(toTree),
			siblingTrees: [],
			caret:
			{
				row: "lastCreated",
				offset: "end",
			},
		};
	}
	if (rowKind === "branch")
	{
		return {
			currentName: null,
			childTrees: [],
			siblingTrees: lines.map(toTree),
			caret:
			{
				row: "lastCreated",
				offset: "end",
			},
		};
	}
	const merged = concatHtml(trimEndHtml(before), linkifyHtml(first.name.trim()));
	const change = currentChange(first);
	const splitAfter = after.trim() !== "";
	const siblingTrees = [
		...lines.slice(1).map(toTree),
		...(splitAfter
			? [
					{
						name: after.trim(),
					},
				]
			: []),
	];
	const childTrees = first.children.map(toTree);
	const created = siblingTrees.length > 0 || childTrees.length > 0;
	return {
		currentName: merged,
		...(change === undefined
			? {}
			:
				{
					current: change,
				}),
		childTrees,
		siblingTrees,
		caret: created
			?
				{
					row: "lastCreated",
					offset: splitAfter ? 0 : "end",
				}
			:
				{
					row: "current",
					offset: plainLength(merged),
				},
	};
}

/** A quote-block row (or a note) takes pasted text in place with its newlines, escaped; no rows are made. */
export function planMultilineSplice({before, after, text}: {before: string; after: string; text: string}):
{
	html: string;
	caret: number;
}
{
	const inserted = escapeHtml(text.replaceAll("\xA0", " "));
	const head = concatHtml(before, inserted);
	return {
		html: concatHtml(head, after),
		caret: plainLength(head),
	};
}

function copiedItems(list: Element): PasteLine[]
{
	return [...list.children]
		.filter((child) => child.tagName.toLowerCase() === "li")
		.flatMap((item): PasteLine[] =>
		{
			const name = item.querySelector(":scope > .name");
			if (name === null)
			{
				return [];
			}
			const note = item.querySelector(":scope > .note");
			const noteHtml = note?.innerHTML ?? "";
			const nested = item.querySelector(":scope > ul, :scope > ol");
			return [
				{
					name: (name.querySelector(".innerContentContainer") ?? name).innerHTML,
					mdBullet: false,
					...(noteHtml === ""
						? {}
						:
							{
								note: noteHtml,
							}),
					children: nested === null ? [] : copiedItems(nested),
				},
			];
		});
}

/** Rows rebuilt from Workflowy's own copy html (`.name[data-wfid]` spans); null when the html is not one. */
export function buildItemCopyLines(html: string): PasteLine[] | null
{
	if (!html.includes("data-wfid"))
	{
		return null;
	}
	const doc = new DOMParser().parseFromString(html, "text/html");
	if (doc.querySelector(".name[data-wfid]") === null)
	{
		return null;
	}
	const root = doc.body.querySelector("ul, ol");
	return root === null ? null : copiedItems(root);
}

export type ItemCopyPlacement =
	|
	  {
			kind: "index";
			index: number;
	  }
	|
	  {
			kind: "firstChild";
	  }
	|
	  {
			kind: "after";
	  };

/** Where copied rows go (upstream `gD4`): replace an empty row, else first child of an open row, else the next sibling. */
export function planItemCopy({
	lines,
	rowEmpty,
	rowIndex,
	rowOpen,
}: {
	lines: readonly PasteLine[];
	rowEmpty: boolean;
	rowIndex: number;
	rowOpen: boolean;
}):
{
	deleteCurrent: boolean;
	placement: ItemCopyPlacement;
	trees: PasteTree[];
}
{
	const placement: ItemCopyPlacement = rowEmpty
		?
			{
				kind: "index",
				index: rowIndex,
			}
		: rowOpen
			?
				{
					kind: "firstChild",
				}
			:
				{
					kind: "after",
				};
	return {
		deleteCurrent: rowEmpty,
		placement,
		trees: lines.map(toTree),
	};
}
