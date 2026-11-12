// Plain-text paste lines: upstream's `th2` + `SD4` line builder. Names are HTML-escaped; nesting comes from
// leading whitespace ranked into levels.

/** One pasted row: a name (stored HTML) with optional note, completion, layout and children. */
export interface PasteLine
{
	name: string;
	/** The line started with an unindented `- ` or `* `; the markdown hook turns it into a bullet. */
	mdBullet: boolean;
	note?: string;
	complete?: boolean;
	layoutMode?: string;
	numberedStart?: number;
	children: PasteLine[];
}

/** `&` first, then `>` and `<`, like upstream's `HL`. */
export function escapeHtml(text: string): string
{
	return text.replaceAll("&", "&amp;").replaceAll(">", "&gt;").replaceAll("<", "&lt;");
}

function indentWidth(line: string): number
{
	const leading = /^\s*/u.exec(line)?.[0] ?? "";
	return leading.split("").reduce((width, char) => width + (char === "\t" ? 4 : 1), 0);
}

/** Nest `flat` lines by `levels` (0-based); a level that skips ahead is clamped to one deeper than its parent. */
export function nestByLevels(
	flat: readonly
	{
		line: PasteLine;
		level: number;
	}[],
): PasteLine[]
{
	const roots: PasteLine[] = [];
	const stack: PasteLine[] = [];
	for (const {line, level} of flat)
	{
		const depth = Math.min(level, stack.length);
		stack.length = depth;
		const parent = stack[depth - 1];
		(parent === undefined ? roots : parent.children).push(line);
		stack.push(line);
	}
	return roots;
}

/** Lines of plain clipboard text. Whitespace-only lines are dropped; with 2+ lines every line loses its leading whitespace. */
export function buildPlainLines(text: string): PasteLine[]
{
	const raw = text
		.replaceAll("\xA0", " ")
		.split(/\r\n|\r|\n/u)
		.filter((line) => line.trim() !== "");
	if (raw.length === 0)
	{
		return [];
	}
	const [only] = raw;
	if (only !== undefined && raw.length === 1)
	{
		return [
			{
				name: escapeHtml(only),
				mdBullet: false,
				children: [],
			},
		];
	}
	const widths = [...new Set(raw.map(indentWidth))].toSorted((a, b) => a - b);
	const flat = raw.map((line, index) =>
	{
		const body = line.trimStart();
		const marker = /^[-*]\s+(?=\S)/u.exec(body);
		const stripped = marker === null || /^(?:-\s+){2,}-\s*$/u.test(body) ? body : body.slice(marker[0].length);
		const unindented = !/^\s/u.test(line);
		return {
			line:
			{
				name: escapeHtml(stripped),
				mdBullet: marker !== null && unindented,
				children: [],
			},
			level: index === 0 ? 0 : widths.indexOf(indentWidth(line)),
		};
	});
	return nestByLevels(flat);
}
