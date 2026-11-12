import {useSyncExternalStore} from "react";
import type {ColorName} from "../color-palette.js";
import {pop, unpop} from "./popups.js";
import type {ColorKind} from "./rich-text.js";

/** The text/highlight popup opened for an item selection (upstream's `openForItems`). */
export interface ItemColorPopupRequest
{
	/** Viewport left and bottom of the last selected item's content. */
	left: number;
	top: number;
	/** A swatch was picked; `null` removes the color. */
	onPick: (kind: ColorKind, color: ColorName | null) => void;
}

let current: ItemColorPopupRequest | undefined;
const listeners = new Set<() => void>();

function emit(): void
{
	for (const listener of listeners)
	{
		listener();
	}
}

export function openItemColorPopup(request: ItemColorPopupRequest): void
{
	current = request;
	pop("COLORS_POPUP");
	emit();
}

export function closeItemColorPopup(): void
{
	if (current === undefined)
	{
		return;
	}
	current = undefined;
	unpop("COLORS_POPUP");
	emit();
}

function subscribe(listener: () => void): () => void
{
	listeners.add(listener);
	return () =>
	{
		listeners.delete(listener);
	};
}

function snapshot(): ItemColorPopupRequest | undefined
{
	return current;
}

export function useItemColorPopup(): ItemColorPopupRequest | undefined
{
	return useSyncExternalStore(subscribe, snapshot, snapshot);
}
