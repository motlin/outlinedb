/**
 * The pure core of upstream's ⌘K Text/Link popup (`xn4` model, `In4` trigger): href normalizing, the Apply and Unlink
 * rules, when ⌘K opens the popup, and the edits Apply and Unlink make to a row's html.
 */
import {findAutoLinks} from "./auto-link.js";
import {rangeAtTextOffsets, unitsBefore} from "./caret-dom.js";
import {storeAnchors} from "./link-render.js";

const SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//u;

/** The href Apply stores: `message:<` is `encodeURI`'d, a scheme with `//` is kept, anything else gets `https://`. */
export function normalizeLinkHref(raw: string): string
{
	const href = raw.trim();
	if (href.startsWith("message:<"))
	{
		return encodeURI(href);
	}
	if (href.startsWith("message:") || SCHEME_PATTERN.test(href))
	{
		return href;
	}
	return `https://${href}`;
}

/** Apply is enabled once both fields have text. */
export function canApply(text: string, href: string): boolean
{
	return text.trim() !== "" && href.trim() !== "";
}

/** Unlink is hidden when the text is exactly one URL (it would just relink itself). */
export function canUnlink(text: string): boolean
{
	const links = findAutoLinks(text, []);
	return !(links.length === 1 && links[0]?.start === 0 && links[0].end === text.length);
}

export interface LinkPopupTriggerInput
{
	collapsed: boolean;
	selectionTouchesLink: boolean;
	caretInLink: boolean;
}

/** `new` for a selection clear of any link, `edit` for a caret inside one, else ⌘K is not the popup's. */
export function linkPopupTrigger({
	collapsed,
	selectionTouchesLink,
	caretInLink,
}: LinkPopupTriggerInput): "new" | "edit" | null
{
	if (!collapsed)
	{
		return selectionTouchesLink ? null : "new";
	}
	return caretInLink ? "edit" : null;
}

/** The anchor in `root` whose first plain-text unit is `start`. */
function anchorAt(root: HTMLElement, start: number): HTMLAnchorElement | null
{
	for (const anchor of root.querySelectorAll("a"))
	{
		if (unitsBefore(root, anchor, 0) === start)
		{
			return anchor;
		}
	}
	return null;
}

/**
 * Make plain-text units `start`..`end` of `root` a link to `href` showing `text`: a new anchor around the range, or,
 * for `existing`, the anchor that starts at `start` rewritten. Returns the caret upstream leaves: the OLD end + 1.
 */
function applyLinkToElement(
	root: HTMLElement,
	{
		start,
		end,
		text,
		href,
		existing,
	}:
	{
		start: number;
		end: number;
		text: string;
		href: string;
		existing: boolean;
	},
): number
{
	const anchor = existing ? anchorAt(root, start) : null;
	if (anchor === null)
	{
		const range = rangeAtTextOffsets(root, start, end);
		range.deleteContents();
		const created = document.createElement("a");
		created.className = "contentLink";
		created.target = "_blank";
		created.rel = "noreferrer";
		created.setAttribute("href", href);
		created.textContent = text;
		range.insertNode(created);
	}
	else
	{
		anchor.setAttribute("href", href);
		anchor.textContent = text;
	}
	return end + 1;
}

/** Unwrap the anchor that starts at plain-text unit `start` of `root`, keeping its content. */
function unlinkInElement(root: HTMLElement, start: number): void
{
	const anchor = anchorAt(root, start);
	anchor?.replaceWith(...anchor.childNodes);
}

/** `applyLinkToElement` over stored html; the result is stored html. */
export function applyLinkToHtml(
	html: string,
	start: number,
	end: number,
	text: string,
	href: string,
	existing: boolean,
):
{
	html: string;
	caret: number;
}
{
	const root = document.createElement("div");
	root.innerHTML = html;
	const caret = applyLinkToElement(
		root,
		{
			start,
			end,
			text,
			href,
			existing,
		},
	);
	return {
		html: storeAnchors(root.innerHTML),
		caret,
	};
}

/** `unlinkInElement` over stored html. */
export function unlinkInHtml(html: string, start: number): string
{
	const root = document.createElement("div");
	root.innerHTML = html;
	unlinkInElement(root, start);
	return root.innerHTML;
}
