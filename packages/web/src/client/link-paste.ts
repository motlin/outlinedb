/**
 * Pasting a URL as a link, ported from upstream's `pJ1`: a pasted URL formats the selected text as a link, replaces a
 * selection that is itself a URL, or inserts at a collapsed caret (as the target's name for an internal link).
 */
import type {QueryClient} from "@tanstack/react-query";
import {findAutoLinks} from "./auto-link.js";
import {internalLinkId} from "./content-link-click.js";
import {readNode} from "./node-cache.js";
import {escapeHtml} from "./paste/lines.js";
import {parseInline, plainText, serializeInline, splitHtml} from "./rich-text.js";

export type LinkPastePlan = {kind: "format"; href: string} | {kind: "insert"; text: string; href: string} | null;

export interface LinkPasteInput {
	clipboardText: string;
	selectionText: string;
	collapsed: boolean;
	inCode: boolean;
	/** The name of the item `href` points at ("" when blank), or null when it is not a resolvable target. */
	resolveTargetName: (href: string) => string | null;
}

function isSingleLink(text: string): boolean {
	const links = findAutoLinks(text, []);
	const [link] = links;
	return links.length === 1 && link?.start === 0 && link.end === text.length;
}

function linkHref(text: string): string {
	if (text.startsWith("message:<")) {
		return encodeURI(text);
	}
	return text.includes("://") || text.startsWith("message:") ? text : `http://${text}`;
}

export function planLinkPaste({
	clipboardText,
	selectionText,
	collapsed,
	inCode,
	resolveTargetName,
}: LinkPasteInput): LinkPastePlan {
	const text = clipboardText.trim();
	if (inCode || text === "" || !isSingleLink(text)) {
		return null;
	}
	const href = linkHref(text);
	const selected = selectionText.trim();
	if (!collapsed && selected !== "" && !isSingleLink(selected)) {
		return {kind: "format", href};
	}
	if (collapsed) {
		const name = resolveTargetName(href);
		if (name !== null) {
			return {kind: "insert", text: name === "" ? href : name, href};
		}
	}
	return {kind: "insert", text, href};
}

function anchorOpen(href: string): string {
	return `<a href="${escapeHtml(href).replaceAll('"', "&quot;")}">`;
}

/** The name html after a planned link paste over the plain-text selection `start..end`, with the caret offset. */
export function applyLinkPaste(
	html: string,
	{start, end}: {start: number; end: number},
	plan: NonNullable<LinkPastePlan>,
): {html: string; caret: number} {
	if (plan.kind === "format") {
		const model = parseInline(html);
		model.spans.push({start, end, name: "a", raw: anchorOpen(plan.href)});
		return {html: serializeInline(model), caret: end};
	}
	const {before, after} = splitHtml(html, start, end);
	return {
		html: `${before}${anchorOpen(plan.href)}${escapeHtml(plan.text)}</a>${after}`,
		caret: start + plan.text.length,
	};
}

/** The plain name of the cached item an internal link points at, or null when it is not one. */
export function cachedLinkTargetName(queryClient: QueryClient, href: string): string | null {
	const id = internalLinkId(href, globalThis.location.origin);
	const node = id === null ? undefined : readNode(queryClient, id);
	return node === undefined ? null : plainText(node.name ?? "", "\uFFFC").trim();
}

/** The html a pasted link puts in a note: `selectedText` is wrapped for a format, else the plan's text. */
export function linkPasteAnchorHtml(plan: NonNullable<LinkPastePlan>, selectedText: string): string {
	return `${anchorOpen(plan.href)}${escapeHtml(plan.kind === "format" ? selectedText : plan.text)}</a>`;
}
