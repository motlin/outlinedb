/**
 * Upstream's `gui-emoji.options` (`Fe0` / `oA2`): the emoji style lives in root metadata
 * `emoji.options.selected`, is mirrored to `localStorage.emoji_options__selected` so the next load
 * applies it before preferences arrive, and is shown as body class `emoji-<name>`.
 */

import type {PreferencesState} from "./hooks/use-preferences.js";

const EMOJI_STORAGE_KEY = "emoji_options__selected";

/** Upstream's Emojis dropdown options, in order. */
export const EMOJI_OPTIONS = [
	["system", "System"],
	["noto", "Noto Emoji"],
] as const;

/** This browser's saved emoji style, `system` when unset or unreadable. */
export function storedEmoji(): string
{
	try
	{
		return localStorage.getItem(EMOJI_STORAGE_KEY) ?? "system";
	}
	catch
	{
		return "system";
	}
}

/** Remember `name` in this browser and swap the body's `emoji-*` class for `emoji-<name>`. */
export function applyEmoji(name: string): void
{
	try
	{
		localStorage.setItem(EMOJI_STORAGE_KEY, name);
	}
	catch
	{
		// Storage can be blocked; the style still applies for this page load.
	}
	const {classList} = document.body;
	classList.remove(...[...classList].filter((className) => className.startsWith("emoji-")));
	classList.add(`emoji-${name}`);
}

/** The account's `emojiSelected` once preferences load; null while loading, unavailable or unset. */
export function serverEmoji(state: PreferencesState | undefined): string | null
{
	return state?.available === true ? state.preferences.emojiSelected : null;
}
