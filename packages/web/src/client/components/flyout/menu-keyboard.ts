export interface MenuKeyboardState
{
	index: number;
	hidden: boolean;
	keyboardMode: boolean;
}

export interface MenuKeyboardEvent
{
	key: string;
	ctrlKey: boolean;
	shiftKey: boolean;
	composing: boolean;
}

export interface MenuKeyboardOptions
{
	count: number;
	cyclic: boolean;
	selectOnTab: boolean;
	stopPropagation: boolean;
}

export interface MenuKeyboardResult
{
	state: MenuKeyboardState;
	action: "none" | "select" | "move";
	preventDefault: boolean;
	stopImmediate: boolean;
}

/** Upstream `z24` move: from -1 jump to an end, otherwise step, clamp or wrap, and hide below 0. */
function move(state: MenuKeyboardState, delta: 1 | -1, {count, cyclic}: MenuKeyboardOptions): MenuKeyboardState
{
	if (state.index === -1)
	{
		const index = delta === -1 ? count - 1 : 0;
		return {
			index,
			hidden: index === -1,
			keyboardMode: true,
		};
	}
	let next = state.index + delta;
	if (cyclic && next === -1)
	{
		next = count - 1;
	}
	const index = cyclic && next > count - 1 ? 0 : Math.min(count - 1, next);
	return {
		index,
		hidden: next === -1,
		keyboardMode: next > -1,
	};
}

/** Pure clone of the upstream DomKit Menu (`z24`) window keydown handler, unwrapped (no Flyout focusables). */
export function menuKeyboard(
	state: MenuKeyboardState,
	event: MenuKeyboardEvent,
	opts: MenuKeyboardOptions,
): MenuKeyboardResult
{
	const stopWhenSelected = !state.hidden && state.index !== -1 && opts.stopPropagation;
	const none = (preventDefault = false): MenuKeyboardResult => (
	{
		state,
		action: "none",
		preventDefault,
		stopImmediate: false,
	});
	const moved = (delta: 1 | -1, stopImmediate: boolean): MenuKeyboardResult => (
	{
		state: move(state, delta, opts),
		action: "move",
		preventDefault: true,
		stopImmediate,
	});
	const select = (): MenuKeyboardResult => (
	{
		state,
		action: "select",
		preventDefault: true,
		stopImmediate: stopWhenSelected,
	});

	if (event.ctrlKey)
	{
		if (event.key === "p")
		{
			return moved(-1, stopWhenSelected);
		}
		if (event.key === "n")
		{
			return moved(1, stopWhenSelected);
		}
		return none();
	}
	switch (event.key)
	{
		case "ArrowUp":
			return event.composing ? none() : moved(-1, stopWhenSelected);
		case "ArrowDown":
			return event.composing ? none() : moved(1, stopWhenSelected);
		case "Enter":
			return event.composing || state.index < 0 ? none() : select();
		case "Tab":
			if (event.composing)
			{
				return none();
			}
			if (!opts.selectOnTab)
			{
				return moved(event.shiftKey ? -1 : 1, opts.stopPropagation);
			}
			return state.index >= 0 ? select() : none(true);
		default:
			return none();
	}
}

/** One of the wrapped menu's focusables: `input, .menuItem, button:not([disabled]), [tabindex]:not([tabindex="-1"])`. */
export interface MenuFocusable
{
	menuItem: boolean;
	/** Which `[data-keyboard-focus-scope]` the element sits in, if any. */
	scope?: number;
	/** Carries `data-keyboard-focus-enter-from-after`: ArrowUp into its scope lands here. */
	enterFromAfter?: boolean;
}

export type MenuFocusKey = "ArrowUp" | "ArrowDown" | "Tab" | "ShiftTab";

/** `focus` moves DOM focus and clears the row; `select` blurs and selects a row; `move` falls back to the pure step. */
export type MenuFocusStep =
	|
	  {
			kind: "focus";
			index: number;
	  }
	|
	  {
			kind: "select";
			menuIndex: number;
	  }
	|
	  {
			kind: "move";
	  }
	|
	  {
			kind: "none";
	  };

function landOn(items: readonly MenuFocusable[], index: number): MenuFocusStep
{
	const target = items[index];
	if (!target)
	{
		return {
			kind: "none",
		};
	}
	if (!target.menuItem)
	{
		return {
			kind: "focus",
			index,
		};
	}
	return {
		kind: "select",
		menuIndex: items.slice(0, index).filter((item) => item.menuItem).length,
	};
}

function wrapIndex(index: number, length: number, cyclic: boolean): number
{
	if (!cyclic)
	{
		return index;
	}
	if (index < 0)
	{
		return length - 1;
	}
	return index >= length ? 0 : index;
}

/**
 * Upstream DomKit Menu (`z24`) wrapped-form ArrowUp/ArrowDown and Tab (`S1`) over its focusables.
 * `focused` is the focused element's index (-1 when focus is outside), `selected` the active row (-1 for none).
 */
export function menuFocusStep(
	items: readonly MenuFocusable[],
	focused: number,
	selected: number,
	key: MenuFocusKey,
	cyclic: boolean,
): MenuFocusStep
{
	const rows = items.flatMap((item, index) => (item.menuItem ? [index] : []));
	const selectedAt = selected >= 0 ? rows[selected] : undefined;
	const current = selectedAt ?? (focused >= 0 ? focused : undefined);
	if (key === "Tab" || key === "ShiftTab")
	{
		const delta = key === "Tab" ? 1 : -1;
		const start = current ?? (delta === 1 ? -1 : items.length);
		return landOn(items, wrapIndex(start + delta, items.length, cyclic));
	}
	const scope = focused >= 0 ? items[focused]?.scope : undefined;
	const inScope = items.flatMap((item, index) => (scope !== undefined && item.scope === scope ? [index] : []));
	let target: number;
	if (key === "ArrowDown")
	{
		const last = inScope.at(-1);
		target = wrapIndex((last !== undefined && selected === -1 ? last : (current ?? -1)) + 1, items.length, cyclic);
	}
	else
	{
		const first = inScope[0];
		target = wrapIndex(
			(first !== undefined && selected === -1 ? first : (current ?? items.length)) - 1,
			items.length,
			cyclic,
		);
		const targetScope = items[target]?.scope;
		const entry = items.findIndex((item) => item.scope === targetScope && item.enterFromAfter === true);
		if (targetScope !== undefined && entry !== -1)
		{
			target = entry;
		}
	}
	const landing = items[target];
	if ((selected === -1 && focused >= 0) || (landing && !landing.menuItem))
	{
		return landOn(items, target);
	}
	return {
		kind: "move",
	};
}
