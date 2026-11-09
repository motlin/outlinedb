/** Apply a theme like upstream's `gui-theme` autorun (`Ft4`), without a server-rendered cookie. */

import {effectiveTheme, isDarkTheme, isRegisteredTheme} from "./themes.js";
import type {ThemeName} from "./themes.js";

export const THEME_STORAGE_KEY = "outlinedb-theme";
/** Stands in for upstream's `wire_theme_current` cookie: the effective theme name. */
const THEME_CURRENT_KEY = "wire_theme_current";
const LOADING_BACKGROUND_KEY = "loadingBackground";
const LOADING_FOREGROUND_KEY = "loadingForeground";

/** The theme saved in this browser: `light` (the old name) becomes `default`, anything unknown is `system`. */
export function storedTheme(raw: string | null): ThemeName {
	if (raw === "light") {
		return "default";
	}
	return isRegisteredTheme(raw) ? raw : "system";
}

function remember(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		// Storage can be blocked; the theme still applies for this page load.
	}
}

/**
 * Swap the body's `_theme-*` class (new one last), then store the effective name and the theme's
 * background and foreground so the next load paints them before any CSS or JS. Returns the effective theme.
 */
export function applyTheme(selected: string, prefersDark: boolean): ThemeName {
	const effective = effectiveTheme(selected, prefersDark);
	const {body, documentElement} = document;
	if (typeof body.className !== "string") {
		// A stubbed or non-browser document has no class list to rewrite.
		return effective;
	}
	body.className = body.className
		.replaceAll(/\b_theme-\S*/gu, "")
		.replaceAll(/\s+/gu, " ")
		.trim();
	body.classList.add(`_theme-${effective}`);
	// The ladder reads this to follow the chosen theme instead of the OS.
	documentElement.dataset.theme = isDarkTheme(effective) ? "dark" : "light";
	remember(THEME_CURRENT_KEY, effective);
	const styles = getComputedStyle(body);
	remember(LOADING_BACKGROUND_KEY, styles.getPropertyValue("--wf-background-primary").trim());
	remember(LOADING_FOREGROUND_KEY, styles.getPropertyValue("--wf-text-quinary").trim());
	return effective;
}

/** Upstream's `kr1()`: once the app is ready the inline pre-paint background gives way to the theme's. */
export function clearPrepaintBackground(): void {
	document.body.style.background = "";
}
