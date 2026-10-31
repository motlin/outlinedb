/**
 * Upstream's account `font` setting (`ZY` list, `AppSettings.change({font})`): saved on the server and shown as
 * body class `font-<name>`, which `fonts.css` scopes to rows and left-bar rows through their `font-custom` class.
 */

/** Upstream's Font dropdown options (`ZY`), in order, as `[name, prettyName]`. */
export const FONT_OPTIONS = [
	["system", "System"],
	["helvetica", "Sans-serif"],
	["times", "Serif"],
	["lucidagrande", "Interface"],
	["atkinsonHyperlegible", "Atkinson Hyperlegible"],
	["helvetica_bold", "Bold"],
	["courierNew", "Courier New"],
	["etBook", "ET Book"],
	["firaCode", "Fira Code"],
	["geistMono", "Geist Mono"],
	["ibmPlexMono", "IBM Plex Mono"],
	["inter", "Inter"],
	["jetbrainsMono", "JetBrains Mono"],
	["junicode", "Junicode"],
	["lexend", "Lexend"],
	["helvetica_light", "Light"],
	["openDyslexic", "Open Dyslexic"],
	["openSans", "Open Sans"],
	["andale", "Terminal"],
	["courier", "Typewriter"],
] as const;

const FONT_CLASSES = new Set(FONT_OPTIONS.map(([name]) => `font-${name}`));

/** Swap the body's `font-<name>` class for `font-<name>` of the chosen font, leaving unrelated `font-*` classes. */
export function applyFont(name: string): void {
	const {classList} = document.body;
	classList.remove(...[...classList].filter((className) => FONT_CLASSES.has(className)));
	classList.add(`font-${name}`);
}
