import {findAutoLinks, findEmails, findPhoneNumbers} from "./auto-link.js";
import {decodeSegment} from "./tag-render.js";

const ANCHOR_OPEN_PATTERN = /<a(?=[\s>/])[^>]*>/giu;
const ANCHOR_CLOSE_PATTERN = /<\/a\s*>/iu;
const HREF_PATTERN = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/iu;
const JAVASCRIPT_HREF_PATTERN = /^\s*javascript:/iu;

function escapeAttribute(value: string): string
{
	return value.replaceAll('"', "&quot;");
}

function escapeHref(value: string): string
{
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** The href of an `<a>` open tag, or "" when it has none. */
export function anchorHref(openTag: string): string
{
	const match = HREF_PATTERN.exec(openTag);
	return match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
}

/** The `<a>` open tag stored for `href`, stripped of rendering attributes. */
export function storedAnchorTag(href: string): string
{
	return `<a href="${escapeAttribute(href)}">`;
}

/**
 * Render every stored `<a>` with upstream's link markup: `class="contentLink"`,
 * `target="_blank"`, `rel="noreferrer"`, and the stored href. A `javascript:` link renders
 * as its plain text, so editing the text around it never deletes that text.
 */
export function renderLinks(html: string): string
{
	return autoLink(decorateStoredLinks(html));
}

const MAILTO_PATTERN = /^\s*mailto:/iu;
const TEL_PATTERN = /^\s*tel:/iu;

/** The plain text of an anchor's inner html. */
function anchorText(innerHtml: string): string
{
	return decodeSegment(innerHtml.replaceAll(/<[^>]*>/gu, "")).plain;
}

/**
 * The href an anchor with a `mailto:` or `tel:` href renders with, or null when it is plain text: upstream keeps such
 * an anchor only when its text is itself exactly one email or phone number, and links that text.
 */
function contactHref(href: string, text: string): string | null
{
	const trimmed = text.trim();
	if (MAILTO_PATTERN.test(href))
	{
		const [email] = findEmails(trimmed);
		return email?.start === 0 && email.end === trimmed.length ? `mailto:${trimmed}` : null;
	}
	const [phone] = findPhoneNumbers(trimmed);
	return phone?.start === 0 && phone.end === trimmed.length ? `tel:${trimmed}` : null;
}

/** `renderLinks` without the display-only auto-links: the stored anchors alone, in upstream's markup. */
export function decorateStoredLinks(html: string): string
{
	let out = "";
	let cursor = 0;
	let droppedClose:
		|
		  {
				start: number;
				end: number;
		  }
		| undefined;
	for (const match of html.matchAll(ANCHOR_OPEN_PATTERN))
	{
		if (droppedClose !== undefined && droppedClose.start < match.index)
		{
			out += html.slice(cursor, droppedClose.start);
			cursor = droppedClose.end;
			droppedClose = undefined;
		}
		out += html.slice(cursor, match.index);
		cursor = match.index + match[0].length;
		let href = anchorHref(match[0]);
		const close = ANCHOR_CLOSE_PATTERN.exec(html.slice(cursor));
		const isContact = MAILTO_PATTERN.test(href) || TEL_PATTERN.test(href);
		const contact =
			isContact && close ? contactHref(href, anchorText(html.slice(cursor, cursor + close.index))) : null;
		if (JAVASCRIPT_HREF_PATTERN.test(href) || (isContact && contact === null))
		{
			droppedClose = close
				?
					{
						start: cursor + close.index,
						end: cursor + close.index + close[0].length,
					}
				: undefined;
			continue;
		}
		href = contact ?? href;
		out += `<a class="contentLink" target="_blank" rel="noreferrer" href="${escapeAttribute(href)}">`;
	}
	if (droppedClose !== undefined)
	{
		out += html.slice(cursor, droppedClose.start);
		cursor = droppedClose.end;
	}
	return out + html.slice(cursor);
}

/** Every `<a …>` open tag in `html` back to the stored `<a href="…">`, dropping `class`, `target` and `rel`. */
export function storeAnchors(html: string): string
{
	return html.replaceAll(ANCHOR_OPEN_PATTERN, (tag) => storedAnchorTag(anchorHref(tag)));
}

const HTML_TAG_PATTERN = /<[^>]*>/gu;
const UNLINKABLE_ELEMENT_PATTERN = /^<(\/?)(a|code|time)(?=[\s>/])/iu;

interface TextRun
{
	html: string;
	htmlStart: number;
	plainStart: number;
	htmlOffsets: number[];
	linkable: boolean;
}

function textRuns(html: string):
{
	runs: TextRun[];
	plain: string;
}
{
	const runs: TextRun[] = [];
	let plain = "";
	let unlinkableDepth = 0;
	let cursor = 0;
	const pushText = (end: number): void =>
	{
		if (end > cursor)
		{
			const text = html.slice(cursor, end);
			const decoded = decodeSegment(text);
			runs.push(
				{
					html: text,
					htmlStart: cursor,
					plainStart: plain.length,
					htmlOffsets: decoded.htmlOffsets,
					linkable: unlinkableDepth === 0,
				},
			);
			plain += decoded.plain;
		}
	};
	for (const match of html.matchAll(HTML_TAG_PATTERN))
	{
		pushText(match.index);
		const element = UNLINKABLE_ELEMENT_PATTERN.exec(match[0]);
		if (element)
		{
			unlinkableDepth = element[1] === "/" ? Math.max(0, unlinkableDepth - 1) : unlinkableDepth + 1;
		}
		cursor = match.index + match[0].length;
	}
	pushText(html.length);
	return {
		runs,
		plain,
	};
}

/**
 * Wrap bare URLs, domains, emails, and phone numbers in `.contentLink` anchors, like upstream's
 * link location. They carry no marker: the next save stores them as `<a href>`. Text inside `<a>`, `<code>`, and `<time>` is
 * never linked, and a match that crosses a formatting boundary is left as text.
 */
export function autoLink(html: string): string
{
	const {runs, plain} = textRuns(html);
	const blocked = runs
		.filter((run) => !run.linkable)
		.map((run) => (
		{
			start: run.plainStart,
			end: run.plainStart + run.htmlOffsets.length - 1,
		}));
	const links = findAutoLinks(plain, blocked);
	if (links.length === 0)
	{
		return html;
	}
	let out = "";
	let cursor = 0;
	for (const link of links)
	{
		const run = runs.find(
			(candidate) =>
				candidate.linkable &&
				link.start >= candidate.plainStart &&
				link.end <= candidate.plainStart + candidate.htmlOffsets.length - 1,
		);
		if (run === undefined)
		{
			continue;
		}
		const htmlStart = run.htmlStart + (run.htmlOffsets[link.start - run.plainStart] ?? 0);
		const htmlEnd = run.htmlStart + (run.htmlOffsets[link.end - run.plainStart] ?? 0);
		out += `${html.slice(cursor, htmlStart)}<a class="contentLink" target="_blank" rel="noreferrer" href="${escapeHref(link.href)}">${html.slice(htmlStart, htmlEnd)}</a>`;
		cursor = htmlEnd;
	}
	return out + html.slice(cursor);
}
