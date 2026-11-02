// OPML text on the clipboard (upstream `uD4` / `hD4`): outlines become rows, nesting preserved.
import type {PasteLine} from "./lines.js";
import {escapeHtml} from "./lines.js";

const OPML_TEXT = /^\s*(?:<\?xml[^>]*\?>)?\s*<opml[\s\S]*<\/opml>\s*$/u;

const ALLOWED_LAYOUTS = new Set([
	"ai_item",
	"board",
	"bullets",
	"check",
	"cmnt",
	"cmnt-c",
	"cmnt_p",
	"code-block",
	"dashboard",
	"divider",
	"good-dashboard",
	"h1",
	"h2",
	"h3",
	"numbered",
	"p",
	"quote-block",
	"table",
	"todo",
]);

export function isOpml(text: string): boolean
{
	return OPML_TEXT.test(text);
}

function decodeXml(value: string): string
{
	return value.replaceAll(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/giu, (_match, entity: string) =>
	{
		switch (entity.toLowerCase())
		{
			case "amp":
				return "&";
			case "lt":
				return "<";
			case "gt":
				return ">";
			case "quot":
				return '"';
			case "apos":
				return "'";
			default:
				return String.fromCodePoint(
					entity.toLowerCase().startsWith("#x")
						? Number.parseInt(entity.slice(2), 16)
						: Number(entity.slice(1)),
				);
		}
	});
}

function attributesOf(source: string): Map<string, string>
{
	const attributes = new Map<string, string>();
	for (const match of source.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu))
	{
		const [, key, doubleQuoted, singleQuoted] = match;
		if (key !== undefined)
		{
			attributes.set(key, decodeXml(doubleQuoted ?? singleQuoted ?? ""));
		}
	}
	return attributes;
}

/** Rows of an OPML document; `text` is already stored HTML, so it is kept as written. */
export function buildOpmlLines(opml: string): PasteLine[]
{
	const roots: PasteLine[] = [];
	const stack: PasteLine[] = [];
	for (const tag of opml.matchAll(/<(\/?)outline\b([^>]*?)(\/?)>/gu))
	{
		if (tag[1] === "/")
		{
			stack.pop();
			continue;
		}
		const attributes = attributesOf(tag[2] ?? "");
		const url = attributes.get("type") === "link" ? attributes.get("url") : undefined;
		const text = attributes.get("text") ?? "";
		const layout = attributes.get("wf:layout-mode");
		const note = attributes.get("_note");
		const line: PasteLine =
		{
			name: url === undefined ? text : `${text} ${escapeHtml(`<${url}>`)}`,
			mdBullet: false,
			...(note === undefined
				? {}
				:
					{
						note,
					}),
			...(attributes.get("_complete") === "true"
				?
					{
						complete: true,
					}
				: {}),
			...(layout !== undefined && ALLOWED_LAYOUTS.has(layout)
				?
					{
						layoutMode: layout,
					}
				: {}),
			children: [],
		};
		(stack.at(-1)?.children ?? roots).push(line);
		if (tag[3] !== "/")
		{
			stack.push(line);
		}
	}
	return roots;
}
