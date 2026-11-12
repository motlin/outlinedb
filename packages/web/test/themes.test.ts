import {describe, expect, it} from "vite-plus/test";
import {THEMES, currentTheme, effectiveTheme, isDarkTheme} from "../src/client/themes.js";

describe("theme registry", () =>
{
	it("lists upstream's 16 themes in dropdown order", () =>
	{
		expect(THEMES.map((theme) => [theme.name, theme.prettyName, theme.dark ?? false])).toStrictEqual([
			["default", "Light", false],
			["dark", "Dark", true],
			["system", "System", false],
			["vintage", "Vintage", false],
			["catppuccin", "Catppuccin", true],
			["chocolate", "Chocolate", false],
			["glass", "Glass", false],
			["hacker", "Hacker", true],
			["matcha", "Matcha", false],
			["moon", "Moon", false],
			["neo", "Neo", true],
			["robot", "Robot", true],
			["space", "Space", true],
			["steel", "Steel", false],
			["wood", "Wood", false],
			["one_dark", "One Dark", true],
		]);
	});

	it("falls back to the first theme for an unknown name", () =>
	{
		expect([currentTheme("bogus"), currentTheme("space"), currentTheme(null)]).toStrictEqual([
			"default",
			"space",
			"default",
		]);
	});

	it("resolves system from the OS preference and leaves other names alone", () =>
	{
		expect([
			effectiveTheme("system", true),
			effectiveTheme("system", false),
			effectiveTheme("wood", true),
			effectiveTheme("bogus", true),
		]).toStrictEqual(["dark", "default", "wood", "default"]);
	});

	it("knows which themes are dark", () =>
	{
		expect([
			isDarkTheme("one_dark"),
			isDarkTheme("vintage"),
			isDarkTheme("default"),
			isDarkTheme("bogus"),
		]).toStrictEqual([true, false, false, false]);
	});
});
