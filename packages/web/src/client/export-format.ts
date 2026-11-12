/**
 * Port of upstream's `WF.Format` serializers (html "Formatted", markdown, text, opml).
 *
 * Each formatter is a generator yielding the same chunks as upstream so a post-format
 * step (the Windows CRLF patch) can transform chunk by chunk. The "Formatted" HTML
 * serializer is shared by the export dialog and by copying selected rows.
 *
 * Quirks are kept on purpose (double-indented nested numbered markdown, dropped table
 * row names, `- ` for empty names): this module is a parity port.
 *
 * Needs a DOM (`document.createElement("template")`); every parse goes through an inert
 * template so stored markup never loads resources.
 */

import {dashboardsOn} from "./dashboard.js";
import {canRenderLayout} from "./layouts.js";
import type {ExportTreeItem} from "../node-types.js";

export interface ExportItem
{
	id: string;
	/** Raw stored HTML. */
	name: string;
	/** Raw stored HTML. */
	note: string;
	layoutMode: string | null;
	numberedStart: number | null;
	completed: boolean;
	parent: ExportItem | null;
	children: ExportItem[];
	/**
	 * On an export root only: the layoutModes from the root's real parent up to and including the zoom root, nearest
	 * first, so a table under a board or table outside the export still writes a list.
	 */
	aboveLayouts?: (string | null)[];
}

/** Returns the children to export for an item (upstream's accessor). */
export type ChildAccessor = (item: ExportItem) => ExportItem[];

export type ExportFormatType = "html" | "markdown" | "text" | "opml";

export interface FormatOptions
{
	/** Turns stored name HTML into the HTML the row renders (tags, links, date pills). Identity by default. */
	renderName?: (html: string) => string;
	/** Same as `renderName`, for notes. */
	renderNote?: (html: string) => string;
	/** Account email for the OPML head. */
	ownerEmail?: string;
}

interface Context
{
	accessor: ChildAccessor;
	renderName: (html: string) => string;
	renderNote: (html: string) => string;
	ownerEmail: string;
}

const defaultAccessor: ChildAccessor = (item) => item.children;

function identity(html: string): string
{
	return html;
}

function makeContext(accessor: ChildAccessor | undefined, options: FormatOptions | undefined): Context
{
	return {
		accessor: accessor ?? defaultAccessor,
		renderName: options?.renderName ?? identity,
		renderNote: options?.renderNote ?? identity,
		ownerEmail: options?.ownerEmail ?? "",
	};
}

/** Sets `parent` on every item in the forest, returning the same items. */
export function linkParents(items: ExportItem[], parent: ExportItem | null = null): ExportItem[]
{
	for (const item of items)
	{
		item.parent = parent;
		linkParents(item.children, item);
	}
	return items;
}

function parseTemplate(html: string): HTMLTemplateElement
{
	const template = document.createElement("template");
	template.innerHTML = html;
	return template;
}

function plainText(html: string): string
{
	return parseTemplate(html).content.textContent;
}

/** The HTML upstream's `nameFragment`/`noteFragment` serialize to (wrapped in `span.innerContentContainer`). */
function fragmentHtml(html: string): string
{
	return parseTemplate(`<span class="innerContentContainer">${html}</span>`).innerHTML;
}

function nameInPlainText(item: ExportItem): string
{
	return plainText(item.name);
}

function noteInPlainText(item: ExportItem): string
{
	return plainText(item.note);
}

function shortId(id: string): string
{
	return id.replaceAll("-", "").slice(-12);
}

function isNumbered(item: ExportItem): boolean
{
	return item.layoutMode === "numbered";
}

function isTable(item: ExportItem): boolean
{
	if (item.layoutMode !== "table")
	{
		return false;
	}
	const ancestors:
	{
		layoutMode: string | null;
	}[] = [];
	let root = item;
	while (root.parent)
	{
		root = root.parent;
		ancestors.push(
			{
				layoutMode: root.layoutMode,
			},
		);
	}
	for (const layoutMode of root.aboveLayouts ?? [])
	{
		ancestors.push(
			{
				layoutMode,
			},
		);
	}
	return canRenderLayout(
		"table",
		item,
		ancestors,
		{
			reachedRoot: true,
			dashboardsFlag: dashboardsOn(),
		},
	);
}

function previousSibling(item: ExportItem, accessor: ChildAccessor): ExportItem | null
{
	const {parent} = item;
	if (!parent)
	{
		return null;
	}
	let siblings = accessor(parent);
	if (!siblings.includes(item))
	{
		siblings = parent.children;
	}
	const index = siblings.indexOf(item);
	return index > 0 ? (siblings[index - 1] ?? null) : null;
}

/** The number printed for a numbered item (upstream `UU4`/`YU4`/`QU4`/`H70`). */
function numberedNumber(item: ExportItem, accessor: ChildAccessor): number
{
	if (typeof item.numberedStart === "number")
	{
		return item.numberedStart;
	}
	let count = 1;
	let current: ExportItem | null = item;
	for (;;)
	{
		current = previousSibling(current, accessor);
		if (current?.layoutMode !== "numbered")
		{
			return count;
		}
		if (current.numberedStart !== null && current.numberedStart !== 0)
		{
			return count + current.numberedStart;
		}
		count += 1;
	}
}

/** Children whose parent is the item itself: virtual children never become table cells. */
function ownChildren(item: ExportItem, accessor: ChildAccessor): ExportItem[]
{
	return accessor(item).filter((child) => child.parent?.id === item.id);
}

// ---- Formatted (html) ----

function styleAttribute(style: string): string
{
	return style ? `style="${style}"` : "";
}

function htmlStyles(item: ExportItem):
{
	container: string;
	name: string;
	note: string;
}
{
	let container = "";
	let name = "";
	const titledDivider = item.layoutMode === "divider" && nameInPlainText(item).trim() !== "";
	if (item.layoutMode === "divider")
	{
		if (titledDivider)
		{
			name += "display:flex; align-items:center; gap:8px; width:100%; border:none; ";
		}
		else
		{
			container += "display:flex; ";
			name += "width:100%; border:none; border-top: 1px solid #ECEEF0; ";
		}
	}
	name += item.completed ? "color:#999; text-decoration:line-through; " : "color:#333; ";
	return {
		container: styleAttribute(container),
		name: styleAttribute(name),
		note: styleAttribute("font-size:12px; color:#666; "),
	};
}

const HTML_BLOCK_TAGS = new Set(["p", "h1", "h2", "h3"]);

function htmlBlockTag(item: ExportItem): string | undefined
{
	const {layoutMode} = item;
	if (layoutMode === null)
	{
		return undefined;
	}
	if (HTML_BLOCK_TAGS.has(layoutMode))
	{
		return layoutMode;
	}
	if (layoutMode === "divider")
	{
		return nameInPlainText(item).trim() ? "div" : "hr";
	}
	return undefined;
}

function titledDividerHtml(inner: string): string
{
	const rule = '<hr style="flex:1; min-width:24px; border:none; border-top:1px solid #ECEEF0;" />';
	return `${rule}<span style="padding:0 8px; text-align:center;">${inner}</span>${rule}`;
}

/** Upstream `RU4`: a note whose rendered HTML ends in a blank line loses one newline. */
function trimNoteHtml(html: string): string
{
	const first = parseTemplate(html).content.children[0];
	const inner = first?.innerHTML ?? "";
	return inner.endsWith("\n\n") ? inner.slice(0, -1) : html;
}

function olOpen(item: ExportItem, ctx: Context): string
{
	return `<ol start=${numberedNumber(item, ctx.accessor)} style="list-style-type:decimal;">`;
}

function nameHtml(item: ExportItem, tag: string, indent: string, top: boolean, ctx: Context): string
{
	const styles = htmlStyles(item);
	let out = `${indent}<${tag} class="name" ${styles.name}`;
	out += top ? ` data-wfid="${shortId(item.id)}"` : ` data-chid="${shortId(item.id)}"`;
	if (item.parent)
	{
		out += ` data-parent="${shortId(item.parent.id)}"`;
	}
	let inner = fragmentHtml(ctx.renderName(item.name)) || " ";
	if (item.layoutMode === "divider" && nameInPlainText(item).trim() !== "")
	{
		inner = titledDividerHtml(inner);
	}
	out += `>${inner}</${tag}>`;
	if (noteInPlainText(item) !== "")
	{
		if (tag === "span")
		{
			out += `${indent}<br />`;
		}
		out += `${indent}<span class="note" ${styles.note}>${trimNoteHtml(fragmentHtml(ctx.renderNote(item.note)))}</span>`;
	}
	return out;
}

function* tableRowHtml(
	row: ExportItem,
	cellTag: string,
	width: number,
	indent: string,
	ctx: Context,
): Generator<string>
{
	const cells = ownChildren(row, ctx.accessor);
	const style = "border:1px solid #ECEEF0; padding:4px 8px; vertical-align:top; min-width:12px; height:24px;";
	yield `${indent}<tr>`;
	for (let index = 0; index < width; index++)
	{
		yield `${indent}  <${cellTag} style="${style}">`;
		const cell = cells[index];
		yield cell ? nameHtml(cell, "div", `${indent}    `, false, ctx) : " ";
		yield `${indent}  </${cellTag}>`;
	}
	yield `${indent}</tr>`;
}

function* tableHtml(table: ExportItem, indent: string, nested: boolean, ctx: Context): Generator<string>
{
	function* body(prefix: string): Generator<string>
	{
		const [head, ...rest] = ownChildren(table, ctx.accessor);
		if (!head)
		{
			return;
		}
		const rows = [head, ...rest];
		const width = Math.max(...rows.map((row) => ownChildren(row, ctx.accessor).length));
		if (width === 0)
		{
			return;
		}
		yield `${prefix}<table style="border-collapse:collapse;">`;
		yield `${prefix}  <thead>`;
		yield* tableRowHtml(head, "th", width, `${prefix}    `, ctx);
		yield `${prefix}  </thead>`;
		if (rest.length > 0)
		{
			yield `${prefix}  <tbody>`;
			for (const row of rest)
			{
				yield* tableRowHtml(row, "td", width, `${prefix}    `, ctx);
			}
			yield `${prefix}  </tbody>`;
		}
		yield `${prefix}</table>`;
	}

	if (nested)
	{
		yield `${indent}<ul>`;
		yield `${indent}  <li>`;
		yield* body(`${indent}    `);
		yield `${indent}  </li>`;
		yield `${indent}</ul>`;
		return;
	}
	yield* body(indent);
}

function* listHtml(items: ExportItem[], ctx: Context, indent = "\n", top = false): Generator<string>
{
	const single = top && items.length === 1;
	const only = single ? items[0] : undefined;
	const singleLeaf = only !== undefined && ctx.accessor(only).length === 0;
	let wrapNumbered = false;
	if (singleLeaf)
	{
		wrapNumbered = isNumbered(only);
		yield wrapNumbered ? `${olOpen(only, ctx)}<li>` : "<ul><li>";
	}
	let bulletOpen = false;
	let numberedOpen = false;
	for (const item of items)
	{
		let tag = htmlBlockTag(item);
		if (!tag && single)
		{
			tag = "span";
		}
		const bullet = !tag || indent !== "\n";
		const numbered = bullet && isNumbered(item);
		if (bullet && bulletOpen && numbered !== numberedOpen)
		{
			yield `${indent}</${numberedOpen ? "ol" : "ul"}>`;
			bulletOpen = false;
		}
		if (bullet && !bulletOpen)
		{
			yield numbered ? `${indent}${olOpen(item, ctx)}` : `${indent}<ul>`;
		}
		if (!bullet && bulletOpen)
		{
			yield `${indent}</${numberedOpen ? "ol" : "ul"}>`;
		}
		yield bullet ? `${indent}  <li ${htmlStyles(item).container}>` : `${indent}<div />`;
		const inner = bullet ? `${indent}    ` : indent;
		yield nameHtml(item, tag ?? "div", inner, top, ctx);
		yield* isTable(item) ? tableHtml(item, inner, bullet, ctx) : listHtml(ctx.accessor(item), ctx, inner);
		if (bullet)
		{
			yield `${indent}  </li>`;
		}
		bulletOpen = bullet;
		numberedOpen = numbered;
	}
	if (bulletOpen)
	{
		yield `${indent}</${numberedOpen ? "ol" : "ul"}>`;
	}
	if (singleLeaf)
	{
		yield wrapNumbered ? "</li></ol>" : "</li></ul>";
	}
}

function* formatHtml(items: ExportItem[], accessor?: ChildAccessor, options?: FormatOptions): Generator<string>
{
	yield* listHtml(items, makeContext(accessor, options), "\n", true);
}

// ---- Plain text ----

function dividerTitle(item: ExportItem): string
{
	return nameInPlainText(item).replaceAll(/\s+/gu, " ").trim();
}

function tableCellText(cell: ExportItem): string
{
	let text = nameInPlainText(cell);
	const note = noteInPlainText(cell);
	if (note !== "")
	{
		text += text ? ` ${note}` : note;
	}
	return text
		.replaceAll("\r\n", "\n")
		.replaceAll("\r", "\n")
		.replaceAll(/[\t\n]+/gu, " ");
}

function* tableText(table: ExportItem, indent: string, ctx: Context): Generator<string>
{
	const rows = ownChildren(table, ctx.accessor);
	if (rows.length === 0)
	{
		return;
	}
	const width = Math.max(...rows.map((row) => ownChildren(row, ctx.accessor).length));
	if (width === 0)
	{
		return;
	}
	for (const row of rows)
	{
		const cells = ownChildren(row, ctx.accessor);
		const texts: string[] = [];
		for (let index = 0; index < width; index++)
		{
			const cell = cells[index];
			texts.push(cell ? tableCellText(cell) : "");
		}
		yield `${indent}- ${texts.join("\t")}\n`;
	}
}

function* itemText(item: ExportItem, ctx: Context, depth = 0, indent = ""): Generator<string>
{
	if (item.layoutMode === "divider")
	{
		const title = dividerTitle(item);
		yield title ? `\n${indent}- - - ${title} - - -\n\n` : `\n${indent}- - -\n\n`;
	}
	else
	{
		if (depth > 0)
		{
			yield `${indent}- `;
		}
		if (item.completed)
		{
			yield "[COMPLETE] ";
		}
		if (isNumbered(item))
		{
			yield `${numberedNumber(item, ctx.accessor)}. `;
		}
		yield `${nameInPlainText(item)}\n`;
		if (depth === 0)
		{
			yield "\n";
		}
		const note = noteInPlainText(item);
		if (note !== "")
		{
			const noteIndent = depth > 0 ? `${indent}  ` : "";
			yield `${noteIndent}"${note.replaceAll("\n", `\n${noteIndent}`)}"\n`;
			if (depth === 0)
			{
				yield "\n";
			}
		}
	}
	if (isTable(item))
	{
		yield* tableText(item, `${indent}  `, ctx);
		return;
	}
	for (const child of ctx.accessor(item))
	{
		yield* itemText(child, ctx, depth + 1, depth > 0 ? `${indent}  ` : indent);
	}
}

function* formatText(items: ExportItem[], accessor?: ChildAccessor, options?: FormatOptions): Generator<string>
{
	const ctx = makeContext(accessor, options);
	const [only] = items;
	if (only && items.length === 1)
	{
		yield* itemText(only, ctx);
		return;
	}
	for (const item of items)
	{
		yield* itemText(item, ctx, 1);
	}
}

// ---- Markdown ----

type MarkdownTag = "p" | "h1" | "h2" | "h3" | "todo" | "pre" | "blockquote" | "span";

const MARKDOWN_TAGS: Record<string, MarkdownTag> =
{
	p: "p",
	h1: "h1",
	h2: "h2",
	h3: "h3",
	todo: "todo",
	"code-block": "pre",
	"quote-block": "blockquote",
};

function markdownBlockTag(item: ExportItem): MarkdownTag | undefined
{
	return item.layoutMode === null ? undefined : MARKDOWN_TAGS[item.layoutMode];
}

function inlineMarkdown(html: string, skipStrikethrough: boolean): string
{
	function walk(node: Node): string
	{
		let out = "";
		for (const child of node.childNodes)
		{
			if (child.nodeType === Node.TEXT_NODE)
			{
				out += child.textContent ?? "";
				continue;
			}
			if (!(child instanceof Element))
			{
				continue;
			}
			const element = child;
			switch (element.tagName.toLowerCase())
			{
				case "b":
				case "strong":
				{
					out += `**${walk(element)}**`;
					break;
				}
				case "i":
				case "em":
				{
					out += `*${walk(element)}*`;
					break;
				}
				case "code":
				{
					out += `\`${walk(element)}\``;
					break;
				}
				case "s":
				{
					out += skipStrikethrough ? walk(element) : `~~${walk(element)}~~`;
					break;
				}
				case "span":
				{
					out += element.classList.contains("colored") ? `==${walk(element)}==` : walk(element);
					break;
				}
				case "a":
				{
					out += `[${element.textContent}](${element instanceof HTMLAnchorElement ? element.href : ""})`;
					break;
				}
				default:
				{
					out += walk(element);
				}
			}
		}
		return out;
	}
	return walk(parseTemplate(fragmentHtml(html)).content);
}

const MARKDOWN_PREFIX: Record<MarkdownTag, string> =
{
	p: "",
	span: "",
	h1: "# ",
	h2: "## ",
	h3: "### ",
	blockquote: "> ",
	todo: "[ ] ",
	pre: "```\n",
};

function markdownLine(item: ExportItem, tag: MarkdownTag, indent: string, ctx: Context): string
{
	let out = MARKDOWN_PREFIX[tag];
	if (tag === "todo")
	{
		out = item.completed ? "[x] " : "[ ] ";
	}
	const strike = item.completed && tag !== "todo" && tag !== "pre";
	let name = inlineMarkdown(ctx.renderName(item.name), strike);
	if (name && strike && !name.includes("~~"))
	{
		name = `~~${name}~~`;
	}
	out += name;
	if (tag === "blockquote")
	{
		out = out.replaceAll("\n", "\n> ");
	}
	if (tag === "pre")
	{
		out += "\n```";
	}
	if (noteInPlainText(item) !== "")
	{
		for (const line of inlineMarkdown(ctx.renderNote(item.note), false).split("\n"))
		{
			out += `\n${indent}> ${line}`;
		}
	}
	return out;
}

function markdownTableCell(cell: ExportItem | undefined, ctx: Context): string
{
	if (!cell)
	{
		return " ";
	}
	const text = markdownLine(cell, "span", "", ctx)
		.replaceAll("\r\n", "\n")
		.replaceAll("\r", "\n")
		.replaceAll(/\n+/gu, "<br>")
		.replaceAll("|", String.raw`\|`)
		.trim();
	return text || " ";
}

function markdownTableRow(row: ExportItem, width: number, indent: string, ctx: Context): string
{
	const cells = ownChildren(row, ctx.accessor);
	const texts: string[] = [];
	for (let index = 0; index < width; index++)
	{
		texts.push(markdownTableCell(cells[index], ctx));
	}
	return `${indent}| ${texts.join(" | ")} |\n`;
}

function* tableMarkdown(table: ExportItem, indent: string, ctx: Context): Generator<string>
{
	const [head, ...rest] = ownChildren(table, ctx.accessor);
	if (!head)
	{
		return;
	}
	const rows = [head, ...rest];
	const width = Math.max(...rows.map((row) => ownChildren(row, ctx.accessor).length));
	if (width === 0)
	{
		return;
	}
	yield markdownTableRow(head, width, indent, ctx);
	yield `${indent}| ${Array.from(
		{
			length: width,
		},
		() => "---",
	).join(" | ")} |\n`;
	for (const row of rest)
	{
		yield markdownTableRow(row, width, indent, ctx);
	}
	yield "\n";
}

function* listMarkdown(items: ExportItem[], ctx: Context, indent = "", top = false): Generator<string>
{
	const single = top && items.length === 1;
	let last = "";
	function* emit(chunk: string): Generator<string>
	{
		yield chunk;
		last = (last + chunk).slice(-2);
	}
	for (const item of items)
	{
		if (item.layoutMode === "divider")
		{
			const title = dividerTitle(item);
			yield* emit(title ? `\n${indent}- - - ${title} - - -\n\n` : `\n${indent}- - -\n\n`);
			for (const chunk of listMarkdown(ctx.accessor(item), ctx, indent.length > 0 ? `${indent}  ` : indent))
			{
				yield* emit(chunk);
			}
			continue;
		}
		let tag = markdownBlockTag(item);
		if (!tag && single)
		{
			tag = "span";
		}
		const bullet = !tag || indent.length > 0 || tag === "todo";
		if (!bullet && last && last !== "\n\n")
		{
			yield* emit("\n");
		}
		let prefix = bullet ? "- " : "";
		if (isNumbered(item))
		{
			prefix = `${indent}${numberedNumber(item, ctx.accessor)}. `;
		}
		if (isTable(item))
		{
			const line = markdownLine(item, tag ?? "span", bullet ? `${indent}  ` : indent, ctx);
			if (bullet || line)
			{
				yield* emit(`${indent}${prefix}${line}\n\n`);
			}
			else
			{
				continue;
			}
			for (const chunk of tableMarkdown(item, bullet ? `${indent}  ` : indent, ctx))
			{
				yield* emit(chunk);
			}
			continue;
		}
		yield* emit(
			bullet
				? `${indent}${prefix}${markdownLine(item, tag ?? "span", `${indent}  `, ctx)}\n`
				: `${indent}${prefix}${markdownLine(item, tag ?? "span", indent, ctx)}\n\n`,
		);
		for (const chunk of listMarkdown(ctx.accessor(item), ctx, bullet ? `${indent}  ` : indent))
		{
			yield* emit(chunk);
		}
	}
}

function* formatMarkdown(items: ExportItem[], accessor?: ChildAccessor, options?: FormatOptions): Generator<string>
{
	yield* listMarkdown(items, makeContext(accessor, options), "", true);
}

// ---- OPML ----

function xmlEscape(text: string): string
{
	return text
		.replaceAll("&", "&amp;")
		.replaceAll(">", "&gt;")
		.replaceAll("<", "&lt;")
		.replaceAll('"', "&quot;")
		.replaceAll("\n", "&#10;");
}

function coloredToMark(html: string): string
{
	if (!html.includes('<span class="colored'))
	{
		return html;
	}
	const template = parseTemplate(html);
	for (const span of template.content.querySelectorAll("span.colored"))
	{
		const mark = document.createElement("mark");
		while (span.firstChild)
		{
			mark.append(span.firstChild);
		}
		mark.className = span.className;
		span.replaceWith(mark);
	}
	return template.innerHTML;
}

function* outlineOpml(item: ExportItem, ctx: Context, indent = "    "): Generator<string>
{
	const attributes: string[] = [];
	if (item.completed)
	{
		attributes.push('_complete="true"');
	}
	let text = xmlEscape(coloredToMark(item.name)).replaceAll("amp;amp;", "amp;");
	const note = noteInPlainText(item) === "" ? "" : xmlEscape(coloredToMark(item.note)).replaceAll("amp;amp;", "amp;");
	if (item.layoutMode === "divider")
	{
		const rule = xmlEscape("<hr />");
		text = nameInPlainText(item).trim() ? `${rule} ${text} ${rule}` : rule;
	}
	if (item.layoutMode === "code-block")
	{
		text = `\`\`\`&#10;${text}&#10;\`\`\``;
	}
	if (isNumbered(item))
	{
		text = `${numberedNumber(item, ctx.accessor)}. ${text}`;
	}
	attributes.push(`text="${text}"`);
	if (note)
	{
		attributes.push(`_note="${note}"`);
	}
	const children = ctx.accessor(item);
	if (children.length === 0)
	{
		yield `${indent}<outline ${attributes.join(" ")} />`;
		return;
	}
	yield `${indent}<outline ${attributes.join(" ")}>`;
	for (const child of children)
	{
		yield "\n";
		yield* outlineOpml(child, ctx, `${indent}  `);
	}
	yield `\n${indent}</outline>`;
}

function* formatOpml(items: ExportItem[], accessor?: ChildAccessor, options?: FormatOptions): Generator<string>
{
	const ctx = makeContext(accessor, options);
	yield '<?xml version="1.0"?>';
	yield '\n<opml version="2.0">';
	yield "\n  <head>";
	yield "\n    <ownerEmail>";
	yield `\n      ${xmlEscape(ctx.ownerEmail)}`;
	yield "\n    </ownerEmail>";
	yield "\n  </head>";
	yield "\n  <body>";
	yield "\n";
	for (const [index, item] of items.entries())
	{
		if (index > 0)
		{
			yield "\n";
		}
		yield* outlineOpml(item, ctx);
	}
	yield "\n  </body>";
	yield "\n</opml>";
}

// ---- Entry points ----

function formatChunks(
	type: ExportFormatType,
	items: ExportItem[],
	accessor?: ChildAccessor,
	options?: FormatOptions,
): Generator<string>
{
	switch (type)
	{
		case "html":
		{
			return formatHtml(items, accessor, options);
		}
		case "markdown":
		{
			return formatMarkdown(items, accessor, options);
		}
		case "text":
		{
			return formatText(items, accessor, options);
		}
		case "opml":
		{
			return formatOpml(items, accessor, options);
		}
		default:
		{
			const unknown: never = type;
			throw new Error(`Cannot format items as "${String(unknown)}": such type isn't registered.`);
		}
	}
}

export function formatToString(
	type: ExportFormatType,
	items: ExportItem[],
	accessor?: ChildAccessor,
	options?: FormatOptions &
	{
		postFormat?: (chunk: string) => string;
	},
): string
{
	const post = options?.postFormat ?? identity;
	let out = "";
	for (const chunk of formatChunks(type, items, accessor, options))
	{
		out += post(chunk);
	}
	return out;
}

// ---- Copying selected rows ----

/**
 * The HTML upstream's copy handler leaves on the clipboard: the Formatted serializer's
 * output re-serialized by the browser (the hidden contenteditable bucket), so `<div />`
 * opens a real div and `<br />` becomes `<br>`.
 */
export function copyItemsHtml(items: ExportItem[], childFilter: ChildAccessor, options?: FormatOptions): string
{
	return parseTemplate(formatToString("html", items, childFilter, options)).innerHTML;
}

/** The text of the copied selection: one line per name then per note, preorder, no trailing newline. */
export function copyItemsPlainText(items: ExportItem[], childFilter: ChildAccessor, options?: FormatOptions): string
{
	const ctx = makeContext(childFilter, options);
	const single = items.length === 1;
	const lines: string[] = [];
	function walk(item: ExportItem, top: boolean): void
	{
		const spanned = top && single && !htmlBlockTag(item);
		const name = plainText(ctx.renderName(item.name));
		if (name !== "")
		{
			lines.push(name);
		}
		if (noteInPlainText(item) !== "")
		{
			if (spanned)
			{
				lines.push("");
			}
			lines.push(plainText(ctx.renderNote(item.note)));
		}
		for (const child of ctx.accessor(item))
		{
			walk(child, false);
		}
	}
	for (const item of items)
	{
		walk(item, true);
	}
	return lines.join("\n");
}

// ---- Export dialog support ----

export interface ExportOption
{
	label: string;
	extension: string;
	type: string;
	/** Plain formats are previewed and downloaded as `text/plain`. */
	plain: boolean;
}

/** Upstream's `config("export")` options, in tab order. */
export const EXPORT_OPTIONS: Record<ExportFormatType, ExportOption> =
{
	html:
	{
		label: "Formatted",
		extension: "html",
		type: "text/html",
		plain: false,
	},
	markdown:
	{
		label: "Markdown",
		extension: "md",
		type: "text/markdown",
		plain: true,
	},
	text:
	{
		label: "Plain Text",
		extension: "txt",
		type: "text/plain",
		plain: true,
	},
	opml:
	{
		label: "OPML",
		extension: "opml",
		type: "text/xml",
		plain: true,
	},
};

/** The tabs, in order. */
export const EXPORT_FORMATS: readonly ExportFormatType[] = ["html", "markdown", "text", "opml"];

export const EXPORT_DEFAULT: ExportFormatType = "html";

/** Upstream's Windows `post_format` patch: every bare `\n` in a chunk becomes `\r\n`. */
export function windowsPostFormat(chunk: string): string
{
	return chunk.replaceAll(/([^\r]|^)\n/gu, "$1\r\n");
}

const PREPARING_THRESHOLD = 1_048_576;

/** The preview placeholder text: megabytes written so far, shown only while generating and from 1 MiB. */
export function preparingLabel(generating: boolean, bytes: number): string | null
{
	return generating && bytes >= PREPARING_THRESHOLD
		? `Preparing your export… ${(bytes / PREPARING_THRESHOLD).toFixed(1)} MB`
		: null;
}

const FLUSH_CHARS = 524_288;

/** Upstream's chunked Blob writer: buffers chunks, appends to a Blob every 512 Ki chars and yields to the event loop. */
export class ExportBlobWriter
{
	blob: Blob;
	private buffer = "";

	constructor(
		private readonly type: string,
		private readonly signal: AbortSignal,
		private readonly onWrite: (bytes: number) => void,
	)
	{
		this.blob = new Blob(
			[],
			{
				type,
			},
		);
	}

	async write(chunks: Iterable<string>): Promise<void>
	{
		for (const chunk of chunks)
		{
			this.signal.throwIfAborted();
			this.buffer += chunk;
			if (this.buffer.length >= FLUSH_CHARS)
			{
				this.flush();
				await new Promise<void>((resolve) =>
				{
					setTimeout(resolve, 0);
				});
			}
		}
		this.signal.throwIfAborted();
		if (this.buffer !== "")
		{
			this.flush();
		}
	}

	private flush(): void
	{
		this.blob = new Blob(
			[this.blob, this.buffer],
			{
				type: this.type,
			},
		);
		this.buffer = "";
		this.onWrite(this.blob.size);
	}
}

const FILE_NAME_LIMIT = 50;

function twoDigits(value: number): string
{
	return String(value).padStart(2, "0");
}

/** `WF - <name> - <YYMMDD-HHmmss>.<ext>`: the name is the one item's plain text, or "Export". */
export function exportFileName(
	items: readonly
	{
		name: string;
	}[],
	extension: string,
	now: Date,
): string
{
	const stamp = `${twoDigits(now.getFullYear() % 100)}${twoDigits(now.getMonth() + 1)}${twoDigits(now.getDate())}-${twoDigits(now.getHours())}${twoDigits(now.getMinutes())}${twoDigits(now.getSeconds())}`;
	const suffix = ` - ${stamp}.${extension}`;
	const [only] = items;
	const name =
		items.length === 1 && only !== undefined
			? plainText(only.name)
					.replace(/[^\p{L}\p{N} ]/u, "")
					.replace(/[^\p{L}\p{N} ]/u, "")
					.trim()
			: "";
	return `WF - ${(name === "" ? "Export" : name).slice(0, FILE_NAME_LIMIT - "WF - ".length - suffix.length)}${suffix}`;
}

/** Upstream's `USE_IFRAME_COPY_FOR`: on Android, Formatted copies by selecting the preview iframe's body. */
export function usesIframeCopy(format: ExportFormatType, userAgent: string): boolean
{
	return format === "html" && /(android|silk-accelerated)/iu.test(userAgent);
}

export type {ExportTreeItem} from "../node-types.js";

/** One server item as a formatter item, its parent links not yet set. */
function unlinkedExportItem(item: ExportTreeItem): ExportItem
{
	return {
		...item,
		parent: null,
		children: item.children.map(unlinkedExportItem),
	};
}

/** The server's tree as formatter items with parents linked. */
export function toExportItems(items: ExportTreeItem[]): ExportItem[]
{
	return linkParents(items.map(unlinkedExportItem));
}

/** Formats `items` into a Blob chunk by chunk (CRLF on Windows), rejecting with the abort reason if `signal` aborts. */
export async function generateExport(
	format: ExportFormatType,
	items: ExportItem[],
	ownerEmail: string,
	signal: AbortSignal,
	onWrite: (bytes: number) => void,
	userAgent: string,
): Promise<Blob>
{
	const option = EXPORT_OPTIONS[format];
	const writer = new ExportBlobWriter(option.plain ? "text/plain" : option.type, signal, onWrite);
	const post = /windows/iu.test(userAgent) ? windowsPostFormat : identity;
	function* chunks(): Generator<string>
	{
		for (const chunk of formatChunks(
			format,
			items,
			undefined,
			{
				ownerEmail,
			},
		))
		{
			yield post(chunk);
		}
	}
	await writer.write(chunks());
	return writer.blob;
}
