/**
 * Upstream's capture-phase click handler for `a.contentLink` (`cx4`): an internal link opens in a pane on ⌘-click (mac;
 * ⌃-click elsewhere) or ⌥-click, and a plain click inside a side pane navigates that pane.
 */
import {parseLocationHash} from "./location.js";
import {paneClickModifier} from "./pane-click-routing.js";

const WORKFLOWY_HOSTS: ReadonlySet<string> = new Set(["workflowy.com", "dev.workflowy.com", "beta.workflowy.com"]);

/** The item id an internal link names (`workflowy.com/#/<id>` or this app's own `/#/<id>`); null for anything else. */
export function internalLinkId(href: string, origin: string): string | null
{
	let url: URL;
	try
	{
		url = new URL(href, origin);
	}
	catch
	{
		return null;
	}
	const internal = url.origin === origin || (/^https?:$/u.test(url.protocol) && WORKFLOWY_HOSTS.has(url.hostname));
	return internal ? parseLocationHash(url.hash).id : null;
}

export interface LinkLocation
{
	id: string | null;
	query: string | null;
}

export type ContentLinkPlan =
	|
	  {
			kind: "open_in_pane";
			loc: LinkLocation;
	  }
	|
	  {
			kind: "navigate_pane";
			loc: LinkLocation;
	  }
	|
	  {
			kind: "navigate";
			loc: LinkLocation;
	  }
	|
	  {
			kind: "search";
			query: string;
	  }
	|
	  {
			kind: "open";
			href: string;
	  }
	| null;

interface LinkClick
{
	metaKey: boolean;
	ctrlKey: boolean;
	altKey: boolean;
	shiftKey: boolean;
	button: number;
}

function internalLocation(href: string, origin: string): LinkLocation | null
{
	let url: URL;
	try
	{
		url = new URL(href, origin);
	}
	catch
	{
		return null;
	}
	const internal = url.origin === origin || (/^https?:$/u.test(url.protocol) && WORKFLOWY_HOSTS.has(url.hostname));
	if (!internal)
	{
		return null;
	}
	const {id, query} = parseLocationHash(url.hash);
	return {
		id,
		query,
	};
}

/**
 * What a left click on a content link does. ⌥ alone, or the platform's primary modifier alone, opens an internal link
 * in a pane; a plain (or ⇧) click navigates in-app, or the side pane it sits in. `search:` links search, and every
 * other link, or any other modifier combo, opens the href in a new tab.
 */
export function planContentLinkClick(
	href: string,
	event: LinkClick,
	ctx:
	{
		isMac: boolean;
		inSidePane: boolean;
		origin: string;
	},
): ContentLinkPlan
{
	if (event.button !== 0)
	{
		return null;
	}
	if (href.startsWith("search:"))
	{
		return {
			kind: "search",
			query: safeDecode(href.slice("search:".length)),
		};
	}
	const loc = internalLocation(href, ctx.origin);
	if (loc === null)
	{
		return {
			kind: "open",
			href,
		};
	}
	if (paneClickModifier(event, ctx.isMac) === "open")
	{
		return {
			kind: "open_in_pane",
			loc,
		};
	}
	if (event.altKey || event.ctrlKey || event.metaKey)
	{
		return {
			kind: "open",
			href,
		};
	}
	return {
		kind: ctx.inSidePane ? "navigate_pane" : "navigate",
		loc,
	};
}

function safeDecode(value: string): string
{
	try
	{
		return decodeURIComponent(value);
	}
	catch
	{
		return value;
	}
}

function onContentLinkContextMenu(event: Event): void
{
	const anchor = event.target instanceof Element ? event.target.closest("a.contentLink") : null;
	if (anchor === null)
	{
		return;
	}
	anchor.setAttribute("contenteditable", "false");
	setTimeout(() =>
	{
		anchor.removeAttribute("contenteditable");
	}, 0);
}

/**
 * Upstream's right-click fix for links inside an editing row: the anchor is briefly `contenteditable="false"` while the
 * native context menu opens, so the browser offers its link items (Open link in new tab, Copy link address). Returns
 * the uninstall function; the default is never prevented.
 */
export function installContentLinkContextMenu(doc: Document): () => void
{
	doc.addEventListener("contextmenu", onContentLinkContextMenu);
	return () =>
	{
		doc.removeEventListener("contextmenu", onContentLinkContextMenu);
	};
}

/**
 * Upstream's Alt+Enter (`In4`): with a collapsed caret inside a link of `editor`, open that link and report it handled.
 * An internal or `search:` link goes through the document's click routing, anything else through `window.open`. With a
 * selection, or outside a link, nothing happens and the key falls through.
 */
export function openLinkAtCaret(editor: HTMLElement): boolean
{
	const selection = globalThis.getSelection();
	if (selection === null || selection.rangeCount === 0 || !selection.isCollapsed)
	{
		return false;
	}
	const node = selection.anchorNode;
	const element = node instanceof Element ? node : (node?.parentElement ?? null);
	const anchor = element?.closest("a[href]") ?? null;
	const href = anchor?.getAttribute("href");
	if (anchor === null || href === null || href === undefined || !editor.contains(anchor))
	{
		return false;
	}
	if (href.startsWith("search:") || internalLinkId(href, globalThis.location.origin) !== null)
	{
		anchor.dispatchEvent(
			new MouseEvent(
				"click",
				{
					bubbles: true,
					cancelable: true,
					button: 0,
				},
			),
		);
	}
	else
	{
		globalThis.open(href);
	}
	return true;
}
