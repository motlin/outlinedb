import {parseLocationHash, shortId} from "./location.js";

/** The part of `window` scroll restoration uses. */
export interface ScrollWindow extends EventTarget
{
	readonly scrollY: number;
	scrollTo: (x: number, y: number) => void;
	history:
	{
		readonly state: unknown;
		scrollRestoration: ScrollRestoration;
	};
	readonly location:
	{
		readonly href: string;
		readonly hash: string;
	};
	readonly sessionStorage?: Pick<Storage, "getItem" | "setItem">;
}

/** Where the saved scroll positions survive a reload, as the browser's own restoration does. */
const STORAGE_KEY = "outlinedb.scroll-positions";

/** Each history entry's last scroll position, by entry key. */
const positions = new Map<string, number>();

/**
 * Each location's last scroll position, by its short id and query: the app's own Back/Forward push a new entry for
 * the location stepped to, so its scroll is found by location rather than by entry.
 */
const locationPositions = new Map<string, number>();

/**
 * The scroll a Back/Forward owes its entry, once the outline shows the entry's location. An app step owes it before
 * pushing the entry (`key` null), and binds to the entry once the URL shows the location.
 */
let pending:
	|
	  {
			key: string | null;
			locationId: string | null;
			query: string | null;
			scrollY: number;
	  }
	| undefined;

/** A history entry's key: the router's entry key, else (an entry the router did not push) its URL. */
function entryKey(win: ScrollWindow): string
{
	const {state} = win.history;
	const key = typeof state === "object" && state !== null && "key" in state ? state.key : undefined;
	return typeof key === "string" ? key : win.location.href;
}

/** A location's key: its short id (empty for home) and query. */
function locationKey(locationId: string | null, query: string | null): string
{
	return `${locationId === null ? "" : shortId(locationId)}?${query ?? ""}`;
}

function hashLocationKey(hash: string): string
{
	const {id, query} = parseLocationHash(hash);
	return locationKey(id, query);
}

function readSaved(win: ScrollWindow): void
{
	try
	{
		const saved: unknown = JSON.parse(win.sessionStorage?.getItem(STORAGE_KEY) ?? "[]");
		if (Array.isArray(saved))
		{
			for (const entry of saved)
			{
				if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "number")
				{
					positions.set(entry[0], entry[1]);
				}
			}
		}
	}
	catch
	{
		// No saved positions: Back after a reload scrolls to the top.
	}
}

function save(win: ScrollWindow): void
{
	try
	{
		win.sessionStorage?.setItem(STORAGE_KEY, JSON.stringify([...positions]));
	}
	catch
	{
		// Storage unavailable: positions last until the reload.
	}
}

/**
 * Take over the browser's scroll restoration: it scrolls on `popstate`, while the outline still shows the view being
 * left (a view the cache lacks swaps in only after it loads), so the old rows jump before the new ones arrive. Instead
 * each entry's scroll is saved as it scrolls (and across reloads) and restored by `restorePoppedScroll` in the commit
 * that shows the entry's view. Returns the uninstall.
 */
export function installScrollRestoration(win: ScrollWindow): () => void
{
	readSaved(win);
	win.history.scrollRestoration = "manual";
	const onScroll = () =>
	{
		positions.set(entryKey(win), win.scrollY);
		locationPositions.set(hashLocationKey(win.location.hash), win.scrollY);
	};
	const oweEntryScroll = () =>
	{
		// Upstream keys the view state by location: the location's last scroll wins over this entry's own.
		oweScroll(win, locationPositions.get(hashLocationKey(win.location.hash)) ?? positions.get(entryKey(win)) ?? 0);
	};
	// A reload returns to its entry's scroll once the page's first view shows, as the browser's restoration did.
	if (positions.has(entryKey(win)))
	{
		oweEntryScroll();
	}
	const onPagehide = () =>
	{
		save(win);
	};
	win.addEventListener(
		"scroll",
		onScroll,
		{
			passive: true,
		},
	);
	win.addEventListener("popstate", oweEntryScroll);
	win.addEventListener("pagehide", onPagehide);
	return () =>
	{
		win.removeEventListener("scroll", onScroll);
		win.removeEventListener("popstate", oweEntryScroll);
		win.removeEventListener("pagehide", onPagehide);
		win.history.scrollRestoration = "auto";
		pending = undefined;
		locationPositions.clear();
	};
}

/** Owe the current entry `scrollY`, restored once the outline shows the entry's location. */
function oweScroll(win: ScrollWindow, scrollY: number): void
{
	const {id, query} = parseLocationHash(win.location.hash);
	pending =
	{
		key: entryKey(win),
		locationId: id === null ? null : shortId(id),
		query,
		scrollY,
	};
}

/**
 * Upstream's in-app Back/Forward to `loc` (a short id, null for home): call it before the step zooms and pushes the
 * entry, so the view loads rows down to the scroll that location was last left at (the top for one never scrolled)
 * and returns to it in the commit that shows it, as a browser Back/Forward restores its entry's.
 */
export function oweAppStepScroll(loc: {id: string | null; query: string | null}): void
{
	pending =
	{
		key: null,
		locationId: loc.id,
		query: loc.query,
		scrollY: locationPositions.get(locationKey(loc.id, loc.query)) ?? 0,
	};
}

/** The restore owed to `shownRootId`'s view (null for home), dropping one a navigation away from its entry left. */
function poppedFor(shownRootId: string | null, win: ScrollWindow): typeof pending
{
	if (pending?.key === null && hashLocationKey(win.location.hash) === locationKey(pending.locationId, pending.query))
	{
		pending.key = entryKey(win);
	}
	if (pending !== undefined && pending.key !== null && pending.key !== entryKey(win))
	{
		pending = undefined;
	}
	return pending?.locationId === (shownRootId === null ? null : shortId(shownRootId)) ? pending : undefined;
}

/**
 * The scroll a Back/Forward will restore once `rootId`'s view shows, else 0: the view mounts rows down to it, not just
 * a viewport's worth, so the restored position has rows to land on.
 */
export function poppedScrollY(rootId: string | null, win: ScrollWindow = globalThis.window): number
{
	return poppedFor(rootId, win)?.scrollY ?? 0;
}

/**
 * Scroll to the position a Back/Forward entry was left at, when the outline now shows `shownRootId` (null for home)
 * and that is the entry's location; call it in the layout effect of each swap, so the scroll lands in the swap's
 * frame. A navigation away from the popped entry drops its restore.
 */
export function restorePoppedScroll(shownRootId: string | null, win: ScrollWindow = globalThis.window): void
{
	const popped = poppedFor(shownRootId, win);
	if (popped !== undefined)
	{
		pending = undefined;
		win.scrollTo(0, popped.scrollY);
	}
}
