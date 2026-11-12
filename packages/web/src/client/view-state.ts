import {parseLocationHash, shortId} from "./location.js";

/** A caret or range in one of a row's two text fields. */
export interface SavedEditing
{
	nodeId: string;
	field: "name" | "note";
	start: number;
	end: number;
	reversed: boolean;
}

/** What upstream's `saveClientViewState` keeps per location: the caret (or range) and the window scroll. */
export interface SavedViewState
{
	editing: SavedEditing | null;
	scrollY: number;
}

/** A location's key: its short id (empty for home), `?`, then its query. */
export function viewStateKey(loc: {id: string | null; query: string | null}): string
{
	return `${loc.id ?? ""}?${loc.query ?? ""}`;
}

export interface ViewStateMap
{
	get: (key: string) => SavedViewState | undefined;
	set: (key: string, value: SavedViewState) => void;
	clear: () => void;
	readonly size: number;
}

/** Upstream's `StdLruMap.create(100)`: reading or re-setting a key makes it the newest, the oldest goes past `cap`. */
export function createViewStateMap(cap = 100): ViewStateMap
{
	const map = new Map<string, SavedViewState>();
	return {
		get(key)
		{
			const value = map.get(key);
			if (value !== undefined)
			{
				map.delete(key);
				map.set(key, value);
			}
			return value;
		},
		set(key, value)
		{
			map.delete(key);
			map.set(key, value);
			for (const oldest of map.keys())
			{
				if (map.size <= cap)
				{
					break;
				}
				map.delete(oldest);
			}
		},
		clear()
		{
			map.clear();
		},
		get size()
		{
			return map.size;
		},
	};
}

/** Every location's last view state, saved as the location is left. */
export const viewStates = createViewStateMap();

export interface ViewRestoreView
{
	query: string | null;
	renderedIds: ReadonlySet<string>;
	firstVisibleChildId: string | null;
	zoomedId: string | null;
}

export interface ViewRestorePlan
{
	focus: SavedEditing | null;
	scrollY: number;
	clearSelection: boolean;
}

/**
 * Upstream's `Wq` / `restoreClientViewState`: a saved location refocuses its caret when that row is rendered (no
 * fallback when it is not), returns to its scroll and clears the item selection; an unsaved one focuses the first
 * visible child (the zoom title when there are none) at offset 0 and scrolls to the top, except a search location,
 * which gets no focus.
 */
export function planViewRestore(saved: SavedViewState | undefined, view: ViewRestoreView): ViewRestorePlan
{
	if (saved !== undefined)
	{
		const editing = saved.editing;
		return {
			focus: editing !== null && view.renderedIds.has(editing.nodeId) ? editing : null,
			scrollY: saved.scrollY,
			clearSelection: true,
		};
	}
	const target = view.query === null ? (view.firstVisibleChildId ?? view.zoomedId) : null;
	return {
		focus:
			target === null
				? null
				:
					{
						nodeId: target,
						field: "name",
						start: 0,
						end: 0,
						reversed: false,
					},
		scrollY: 0,
		clearSelection: false,
	};
}

/** The location a restoring navigation (Back/Forward, popstate, a link click) owes a view-state restore. */
let pending:
	|
	  {
			id: string | null;
			query: string | null;
	  }
	| undefined;

export function oweViewRestore(loc: {id: string | null; query: string | null}): void
{
	pending =
	{
		id: loc.id === null ? null : shortId(loc.id),
		query: loc.query,
	};
}

export function oweViewRestoreForHash(hash: string): void
{
	const {id, query} = parseLocationHash(hash);
	oweViewRestore(
		{
			id,
			query,
		},
	);
}

/** A zoom that is not restoring (bullet, crumb, ⌘./⌘,) drops any restore owed. */
export function dropViewRestore(): void
{
	pending = undefined;
}

/** The restore owed to `shownRootId`'s view (null for home), taken once. */
export function takeViewRestore(shownRootId: string | null):
	|
	  {
			id: string | null;
			query: string | null;
	  }
	| undefined
{
	const owed = pending;
	if (owed === undefined || owed.id !== (shownRootId === null ? null : shortId(shownRootId)))
	{
		return undefined;
	}
	pending = undefined;
	return owed;
}
