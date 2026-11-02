import {parseLocationHash, shortId} from "./location.js";

/** A navigable location; `id` is a short id (or null for home) so full and short URLs compare equal. */
export interface Loc
{
	id: string | null;
	query: string | null;
}

/** Upstream's in-app Back/Forward stacks, independent of browser history. */
export interface NavState
{
	current: Loc | null;
	back: Loc[];
	forward: Loc[];
}

export type NavAction =
	|
	  {
			type: "navigate";
			loc: Loc;
	  }
	|
	  {
			type: "back";
	  }
	|
	  {
			type: "forward";
	  }
	|
	  {
			type: "popstate";
			loc: Loc;
	  }
	|
	  {
			type: "replace";
			loc: Loc;
	  };

export const BACK_STACK_CAP = 100;

export const initialNavState: NavState =
{
	current: null,
	back: [],
	forward: [],
};

export function locEquals(a: Loc | null, b: Loc | null): boolean
{
	return a !== null && b !== null && a.id === b.id && a.query === b.query;
}

export function locFromHash(hash: string): Loc
{
	const {id, query} = parseLocationHash(hash);
	return {
		id: id === null ? null : shortId(id),
		query,
	};
}

function pushCapped(stack: Loc[], loc: Loc | null): Loc[]
{
	return loc === null ? stack : [...stack, loc].slice(-BACK_STACK_CAP);
}

/**
 * `navigate` pushes the current location onto `back` and clears `forward` (no-op
 * when already there); `back`/`forward` move one step between the stacks;
 * `popstate` (browser Back/Forward) and `replace` (a replaced history entry) set the current location only.
 */
export function navReducer(state: NavState, action: NavAction): NavState
{
	switch (action.type)
	{
		case "navigate":
		{
			if (locEquals(state.current, action.loc))
			{
				return state;
			}
			return {
				current: action.loc,
				back: pushCapped(state.back, state.current),
				forward: [],
			};
		}
		case "back":
		{
			const target = state.back.at(-1);
			if (target === undefined)
			{
				return state;
			}
			return {
				current: target,
				back: state.back.slice(0, -1),
				forward: pushCapped(state.forward, state.current),
			};
		}
		case "forward":
		{
			const target = state.forward.at(-1);
			if (target === undefined)
			{
				return state;
			}
			return {
				current: target,
				back: pushCapped(state.back, state.current),
				forward: state.forward.slice(0, -1),
			};
		}
		case "popstate":
		case "replace":
		{
			break;
		}
	}
	return {
		...state,
		current: action.loc,
	};
}

/**
 * Upstream's `W2.state.mainPaneHistory`: the main pane's own Back/Forward while panes are open, separate from the app
 * stacks. `forward[0]` is the next location forward.
 */
export interface MainPaneHistory
{
	back: Loc[];
	forward: Loc[];
}

export const emptyMainPaneHistory: MainPaneHistory =
{
	back: [],
	forward: [],
};

/**
 * Upstream's `rememberMainPaneNavigation`: a main pane move to another node records the location left (capped) and
 * clears forward; a search-only change, a move from no location, or staying put returns `history` unchanged.
 */
export function rememberMainPaneMove(history: MainPaneHistory, from: Loc | null, to: Loc | null): MainPaneHistory
{
	if (from === null || to === null || from.id === to.id)
	{
		return history;
	}
	return {
		back: pushCapped(history.back, from),
		forward: [],
	};
}

/**
 * Upstream's `navigateMainPaneHistory`: step one location back or forward from `current`, or null when that stack is
 * empty or there is no current location.
 */
export function stepMainPaneHistory(
	history: MainPaneHistory,
	current: Loc | null,
	direction: "back" | "forward",
):
{
	history: MainPaneHistory;
	target: Loc;
} | null
{
	if (current === null)
	{
		return null;
	}
	if (direction === "back")
	{
		const target = history.back.at(-1);
		return target === undefined
			? null
			:
				{
					target,
					history:
					{
						back: history.back.slice(0, -1),
						forward: [current, ...history.forward],
					},
				};
	}
	const [target, ...forward] = history.forward;
	return target === undefined
		? null
		:
			{
				target,
				history:
				{
					back: pushCapped(history.back, current),
					forward,
				},
			};
}
