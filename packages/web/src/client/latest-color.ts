import {useQuery, useQueryClient} from "@tanstack/react-query";
import {useEffect, useSyncExternalStore} from "react";
import type {ColorName} from "../color-palette.js";
import {fetchPreferences, preferenceKeys, setPreferences} from "./hooks/use-preferences.js";
import {toggleColor} from "./rich-text.js";
import type {ColorChoice, ColorKind} from "./rich-text.js";

/**
 * Upstream's `latestColor` (`WF.CoreKv`): the color the toolbar's font button and Shift+Cmd+H reapply. It
 * lives in the account's root metadata (`/api/v1/preferences` `latestColor`), so every device shares it.
 */

type Persist = (choice: ColorChoice) => Promise<void>;

let latest: ColorChoice | undefined;
let persist: Persist | undefined;
let toggleOff = false;
const listeners = new Set<() => void>();

function emit(): void {
	for (const listener of listeners) {
		listener();
	}
}

/** The latest color, or undefined before any was picked. */
export function get(): ColorChoice | undefined {
	return latest;
}

/** Upstream's `be.change`: a color becomes the latest; `null` sets a one-shot removal and keeps the latest. */
export function change(kind: ColorKind, color: ColorName | null): void {
	if (color === null) {
		toggleOff = true;
		return;
	}
	toggleOff = false;
	latest = {kind, color};
	emit();
	persist?.(latest).catch(() => {
		// Without the internal API the color still applies for this session.
	});
}

/** Take the account's latest color (null when unset) without writing it back. */
export function adopt(choice: ColorChoice | null): void {
	const next = choice ?? undefined;
	if (next?.kind === latest?.kind && next?.color === latest?.color) {
		return;
	}
	latest = next;
	emit();
}

/** Where a picked color is saved; the app wires it to `/api/v1/preferences`. */
export function setLatestColorPersister(replacement: Persist | undefined): void {
	persist = replacement;
}

/** Upstream's `be.applyToCaret` on stored HTML: toggles the latest color, or clears the range once after a removal. */
export function planApply(html: string, start: number, end: number): string {
	const current = get();
	if (current === undefined) {
		return html;
	}
	const clear = toggleOff;
	toggleOff = false;
	return toggleColor(html, start, end, current.kind, clear ? null : current.color);
}

/** The latest color's class (`c-X` or `bc-X`), or "" before any was picked. */
export function swatchClass(): string {
	const current = get();
	return current === undefined ? "" : `${current.kind === "text" ? "c" : "bc"}-${current.color}`;
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** The toolbar font button's color class, kept current as the latest color changes. */
export function useLatestColorClass(): string {
	return useSyncExternalStore(subscribe, swatchClass, () => "");
}

/** Adopt the account's latest color whenever preferences load, and save picks back to the account. */
export function useLatestColorSync(): void {
	const queryClient = useQueryClient();
	const {data} = useQuery({queryKey: preferenceKeys.all, queryFn: fetchPreferences});
	const account = data?.available === true ? data.preferences.latestColor : undefined;
	useEffect(() => {
		if (account !== undefined) {
			adopt(account);
		}
	}, [account]);
	useEffect(() => {
		setLatestColorPersister(async (latestColor) => setPreferences(queryClient, {latestColor}));
		return () => {
			setLatestColorPersister(undefined);
		};
	}, [queryClient]);
}

export function resetLatestColorForTests(): void {
	latest = undefined;
	persist = undefined;
	toggleOff = false;
	emit();
}
