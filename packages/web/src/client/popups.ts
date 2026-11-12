/** Upstream's registered popup ids (`WF.Popups`) that have a local surface. */
export type PopupId =
	| "CTX_MENU_POPUP"
	| "TAG_COLOR_TEASER_POPUP"
	| "TAG_COLORS_POPUP"
	| "COLORS_POPUP"
	| "LINK_POPUP"
	| "suggest"
	| "date.autocomplete";

export interface PopupSnapshot
{
	id: PopupId | undefined;
	locked: boolean;
}

interface Current
{
	id: PopupId;
	target: unknown;
}

/**
 * Upstream's `WF.Popups`: one slot, so at most one registered popup is open. Surfaces ask this instead of
 * guessing from the DOM, where upstream's always-mounted hidden flyouts look like open popups.
 */
let current: Current | undefined;
let locked = false;
let closeTimer: ReturnType<typeof setTimeout> | undefined;
let snap: PopupSnapshot =
{
	id: undefined,
	locked: false,
};

function clearTimer(): void
{
	if (closeTimer !== undefined)
	{
		clearTimeout(closeTimer);
		closeTimer = undefined;
	}
}

function changed(): void
{
	snap =
	{
		id: current?.id,
		locked,
	};
}

export function snapshot(): PopupSnapshot
{
	return snap;
}

/** Open `id`, replacing whatever is current. */
export function pop(id: PopupId, target?: unknown): void
{
	clearTimer();
	current =
	{
		id,
		target,
	};
	locked = false;
	changed();
}

/** Open `id` unless a different popup is current. */
export function tryPop(id: PopupId, target?: unknown): boolean
{
	if (current !== undefined && current.id !== id)
	{
		return false;
	}
	pop(id, target);
	return true;
}

/** Clear the slot when `id` is omitted or current; returns whether it cleared. */
export function unpop(id?: PopupId): boolean
{
	if (current === undefined || (id !== undefined && current.id !== id))
	{
		return false;
	}
	clearTimer();
	current = undefined;
	locked = false;
	changed();
	return true;
}

/** Clear `id` after `ms`, unless it is locked or the slot changed in between. */
export function requestClose(id: PopupId, ms = 0): void
{
	clearTimer();
	const target = current;
	closeTimer = setTimeout(() =>
	{
		closeTimer = undefined;
		if (!locked && current !== undefined && current === target && current.id === id)
		{
			unpop(id);
		}
	}, ms);
}

export function lock(id: PopupId): void
{
	if (current?.id === id)
	{
		locked = true;
		changed();
	}
}

export function is(id: PopupId): boolean
{
	return current?.id === id;
}

export function isVisible(): boolean
{
	return current !== undefined;
}

/** Another registered popup, not `id`, is open. */
export function anotherPopupOpened(id: PopupId): boolean
{
	return isVisible() && !is(id);
}

export function resetPopupsForTests(): void
{
	clearTimer();
	current = undefined;
	locked = false;
	changed();
}
