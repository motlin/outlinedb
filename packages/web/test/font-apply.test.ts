// @vitest-environment happy-dom
import {beforeEach, describe, expect, it} from "vite-plus/test";
import {FONT_OPTIONS, applyFont} from "../src/client/font-apply.js";
import {EMPTY_PREFERENCES, serverFont} from "../src/client/hooks/use-preferences.js";

beforeEach(() => {
	document.body.className = "is-desktop font-system _theme-dark emoji-system";
});

describe("FONT_OPTIONS", () => {
	it("is upstream's font list in order", () => {
		expect(FONT_OPTIONS).toStrictEqual([
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
		]);
	});
});

describe("applyFont", () => {
	it("swaps the body's font-<name> class for the chosen font, keeping other font- classes", () => {
		document.body.classList.add("font-courier", "font-custom");
		applyFont("etBook");
		expect(document.body.className).toBe("is-desktop _theme-dark emoji-system font-custom font-etBook");
	});
});

describe("serverFont", () => {
	it("is the account's font once preferences load, else null", () => {
		const loaded = {preferences: {...EMPTY_PREFERENCES, font: "times"}, available: true, error: null};
		expect([
			serverFont(loaded),
			serverFont({...loaded, preferences: EMPTY_PREFERENCES}),
			serverFont({...loaded, available: false}),
			serverFont(undefined),
		]).toStrictEqual(["times", null, null, null]);
	});
});
