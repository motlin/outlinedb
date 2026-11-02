/**
 * Upstream's markdown-style block prefixes (`editor.input.todo`, `paragraphs`, `quote-block`, `code-block`,
 * `transform-to-gui-divider`, `transform-to-numbered`): typing the prefix at the very start of a row name
 * turns the row into that block type.
 */
import {isFeatureOn} from "./features.js";
import {normalizeLayoutMode} from "./layout-types.js";
import {plainText, splitHtml} from "./rich-text.js";

export interface BlockPrefixPlan
{
	/**
	 * `strip` keeps the rich rest of the name; `code` and `divider-above` keep its plain text; `clear` empties it.
	 * `divider-above` also creates a divider sibling directly above the row.
	 */
	kind: "strip" | "code" | "clear" | "divider-above";
	/** Plain-text units of prefix to remove from the name. */
	strip: number;
	/** The layout mode to store; `"bullets"` means remove it. For `divider-above` it is the row's own mode. */
	layoutMode: string;
	complete: boolean;
	numberedStart?: number;
}

const TODO_PREFIXES: Record<string, boolean> =
{
	"[] ": false,
	"[ ] ": false,
	"[x] ": true,
	"[+] ": true,
	"[-] ": true,
};
const HEADING_PREFIXES: Record<string, string> =
{
	"# ": "h1",
	"## ": "h2",
	"### ": "h3",
};
const HEADING_MODES = new Set(["p", "h1", "h2", "h3"]);
const NUMBERED_PREFIX = /^(\d+)\. $/u;
const CODE_FENCE = "```";

/** The block a typed prefix turns the row into, or null when `before` is not exactly a prefix that applies. */
export function planBlockPrefix(input: {
	before: string;
	after: string;
	layoutMode: string | null;
}): BlockPrefixPlan | null
{
	const before = input.before.replaceAll(" ", " ");
	const current = normalizeLayoutMode(input.layoutMode);
	const {length} = before;

	const complete = TODO_PREFIXES[before];
	if (complete !== undefined)
	{
		return {
			kind: "strip",
			strip: length,
			layoutMode: "todo",
			complete,
		};
	}
	if (before === CODE_FENCE)
	{
		return current === "code-block"
			? null
			:
				{
					kind: "code",
					strip: length,
					layoutMode: "code-block",
					complete: false,
				};
	}
	if (before === "> ")
	{
		return current === "quote-block"
			? null
			:
				{
					kind: "strip",
					strip: length,
					layoutMode: "quote-block",
					complete: false,
				};
	}
	if (before === "--- " || before === "- - - ")
	{
		if (current === "divider")
		{
			return null;
		}
		return input.after === ""
			?
				{
					kind: "clear",
					strip: length,
					layoutMode: "divider",
					complete: false,
				}
			:
				{
					kind: "divider-above",
					strip: length,
					layoutMode: input.layoutMode ?? "bullets",
					complete: false,
				};
	}
	const heading = HEADING_PREFIXES[before];
	if (heading !== undefined)
	{
		const currentHeading = current !== null && HEADING_MODES.has(current) ? current : null;
		return {
			kind: "strip",
			strip: length,
			layoutMode: currentHeading === heading ? "bullets" : heading,
			complete: false,
		};
	}
	const numbered = NUMBERED_PREFIX.exec(before);
	if (numbered !== null && input.after === "" && current !== "numbered" && isFeatureOn("numbered_list"))
	{
		return {
			kind: "clear",
			strip: length,
			layoutMode: "numbered",
			complete: false,
			numberedStart: Number(numbered[1]),
		};
	}
	return null;
}

function escapeHtml(text: string): string
{
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** The stored name once the plan's prefix is removed from the typed `html`. */
export function prefixedName(html: string, plan: BlockPrefixPlan, pillChar: string): string
{
	if (plan.kind === "clear")
	{
		return "";
	}
	const rest = splitHtml(html, 0, plan.strip).after;
	return plan.kind === "strip" ? rest : escapeHtml(plainText(rest, pillChar));
}
