import {useQuery} from "@tanstack/react-query";
import {useEffect} from "react";
import {useOutlineStore} from "../stores/outline.js";
import type {Theme} from "../stores/outline.js";
import {useCustomThemesStore} from "../stores/custom-themes.js";
import {isRegisteredTheme} from "../themes.js";
import {applyEmoji, serverEmoji} from "../emoji-apply.js";
import {applyFont} from "../font-apply.js";
import {
	fetchPreferences,
	preferenceKeys,
	serverFont,
	serverShowKeyboardShortcuts,
	serverTheme,
} from "./use-preferences.js";

/** Adopt the account's `showKeyboardShortcuts` whenever `/api/v1/preferences` reports a value. */
export function useShowKeyboardShortcutsSync(): void {
	const {data} = useQuery({queryKey: preferenceKeys.all, queryFn: fetchPreferences});
	const showKeyboardShortcuts = serverShowKeyboardShortcuts(data);
	useEffect(() => {
		if (showKeyboardShortcuts !== null) {
			useOutlineStore.getState().adoptShowKeyboardShortcuts(showKeyboardShortcuts);
		}
	}, [showKeyboardShortcuts]);
}

/** The store theme for an account theme codename, or null for a name the app does not have. */
export function themeFromAccount(name: string | null): Theme | null {
	return isRegisteredTheme(name) ? name : null;
}

/** Adopt the account's `theme` over this browser's saved one whenever `/api/v1/preferences` reports a known value. */
export function useThemeSync(): void {
	const {data} = useQuery({queryKey: preferenceKeys.all, queryFn: fetchPreferences});
	// Custom themes register late; re-resolve the account theme when they do.
	useCustomThemesStore((state) => state.themes);
	const theme = themeFromAccount(serverTheme(data));
	useEffect(() => {
		if (theme !== null && useOutlineStore.getState().theme !== theme) {
			useOutlineStore.getState().setTheme(theme);
		}
	}, [theme]);
}

/** Adopt the account's emoji style (`emoji.options.selected`) whenever `/api/v1/preferences` reports one. */
export function useEmojiSync(): void {
	const {data} = useQuery({queryKey: preferenceKeys.all, queryFn: fetchPreferences});
	const emoji = serverEmoji(data);
	useEffect(() => {
		if (emoji !== null) {
			applyEmoji(emoji);
		}
	}, [emoji]);
}

/** Adopt the account's `font` as body class `font-<name>` whenever `/api/v1/preferences` reports one. */
export function useFontSync(): void {
	const {data} = useQuery({queryKey: preferenceKeys.all, queryFn: fetchPreferences});
	const font = serverFont(data);
	useEffect(() => {
		if (font !== null) {
			applyFont(font);
		}
	}, [font]);
}
