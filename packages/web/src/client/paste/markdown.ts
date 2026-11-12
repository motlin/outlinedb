// Pasted markdown: upstream's `markdown_pasting` line hook (`xk2` / `T70` / `yk2`). Runs on escaped lines.
import type {PasteLine} from "./lines.js";
import {nestByLevels} from "./lines.js";

const FENCE = /^```\s*$/u;

interface Flat
{
	line: PasteLine;
	level: number;
}

function flatten(lines: readonly PasteLine[], level = 0): Flat[]
{
	return lines.flatMap((line) => [
		{
			line:
			{
				...line,
				children: [],
			},
			level,
		},
		...flatten(line.children, level + 1),
	]);
}

/** Lines between ``` fences collapse into one code-block row, two spaces per nesting level. */
function collapseFences(flat: readonly Flat[]): Flat[]
{
	const result: Flat[] = [];
	let index = 0;
	while (index < flat.length)
	{
		const open = flat[index];
		if (open === undefined)
		{
			break;
		}
		const close = FENCE.test(open.line.name)
			? flat.findIndex((entry, at) => at > index && FENCE.test(entry.line.name))
			: -1;
		if (close === -1)
		{
			result.push(open);
			index += 1;
			continue;
		}
		const body = flat
			.slice(index + 1, close)
			.map((entry) => `${"  ".repeat(Math.max(entry.level - open.level, 0))}${entry.line.name}`);
		result.push(
			{
				line:
				{
					name: body.join("\n"),
					mdBullet: false,
					layoutMode: "code-block",
					children: [],
				},
				level: open.level,
			},
		);
		index = close + 1;
	}
	return result;
}

/** `` `x` ``, `~~x~~`, `**x**`, `*x*`, word-boundary `_x_` and `[t](u)` to their HTML. */
export function inlineMarkdown(text: string): string
{
	const held: string[] = [];
	const hold = (html: string): string => `\uE000${held.push(html) - 1}\uE001`;
	let out = text
		.replaceAll(/`([^`]+)`/gu, (_match, code: string) => hold(`<code>${code}</code>`))
		.replaceAll(/\[([^\]]+)\]\(([^)\s]+)\)/gu, (_match, label: string, href: string) =>
			hold(`<a href="${href}">${label}</a>`),
		);
	out = out
		.replaceAll(/~~(.+?)~~/gu, "<s>$1</s>")
		.replaceAll(/\*\*(.+?)\*\*/gu, "<b>$1</b>")
		.replaceAll(/\*(.+?)\*/gu, "<i>$1</i>")
		.replaceAll(/(^|[^\p{L}\p{N}_])_([^_]+)_(?=[^\p{L}\p{N}_]|$)/gu, "$1<i>$2</i>");
	return out.replaceAll(/\uE000(\d+)\uE001/gu, (_match, at: string) => held[Number(at)] ?? "");
}

function withLayout(line: PasteLine, name: string, layout: Partial<PasteLine>): PasteLine
{
	return {
		...line,
		name,
		...layout,
	};
}

/** Block prefix of one line: the layout it asks for and the name without the marker. */
function markLine(line: PasteLine): PasteLine
{
	if (line.layoutMode !== undefined)
	{
		return line;
	}
	let name = line.name;
	let bullet = line.mdBullet;
	const dash = /^-\s+(?=\S)/u.exec(name);
	if (dash !== null && !/^(?:-\s+){2,}-\s*$/u.test(name))
	{
		name = name.slice(dash[0].length);
		bullet = true;
	}
	if (/^(?:---|- - -)\s*$/u.test(name))
	{
		return withLayout(
			line,
			"",
			{
				layoutMode: "divider",
			},
		);
	}
	const heading = /^(#{1,3}) (.*)$/su.exec(name);
	if (heading !== null)
	{
		const [, hashes = "", text = ""] = heading;
		return withLayout(
			line,
			inlineMarkdown(text),
			{
				layoutMode: `h${hashes.length}`,
			},
		);
	}
	const quote = /^(?:&gt;|>) (.*)$/su.exec(name);
	if (quote !== null)
	{
		return withLayout(
			line,
			inlineMarkdown(quote[1] ?? ""),
			{
				layoutMode: "quote-block",
			},
		);
	}
	const todo = /^\[([ xX-])\] (.*)$/su.exec(name);
	if (todo !== null)
	{
		return withLayout(
			line,
			inlineMarkdown(todo[2] ?? ""),
			{
				layoutMode: "todo",
				...(todo[1] === " "
					? {}
					:
						{
							complete: true,
						}),
			},
		);
	}
	const numbered = /^(\d+)\. (.*)$/su.exec(name);
	if (numbered !== null)
	{
		return withLayout(
			line,
			inlineMarkdown(numbered[2] ?? ""),
			{
				layoutMode: "numbered",
				numberedStart: Number(numbered[1]),
			},
		);
	}
	return withLayout(
		line,
		inlineMarkdown(name),
		bullet
			?
				{
					layoutMode: "bullet",
				}
			: {},
	);
}

function markSiblings(lines: readonly PasteLine[]): PasteLine[]
{
	const marked = lines.map((line) =>
	{
		const next = markLine(line);
		return {
			...next,
			children: markSiblings(next.children),
		};
	});
	// A fence alone is not a block marker, so U11's `after` stays unmarked.
	const anyBlock = marked.some(
		(line, at) => line.layoutMode !== undefined && !(line.layoutMode === "code-block" && lines[at]?.layoutMode),
	);
	return anyBlock
		? marked.map((line) =>
				line.layoutMode === undefined
					?
						{
							...line,
							layoutMode: "p",
						}
					: line,
			)
		: marked;
}

/** Apply upstream's markdown paste rules to a line tree. */
export function applyMarkdown(lines: readonly PasteLine[]): PasteLine[]
{
	return markSiblings(nestByLevels(collapseFences(flatten(lines))));
}
