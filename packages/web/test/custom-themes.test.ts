import {describe, expect, it} from "vite-plus/test";
import {THEME_PROPS, isValidHex, isValidThemeName, parseCustomThemes} from "../src/client/custom-themes.js";
import type {CustomNode} from "../src/client/keys/custom-hotkeys.js";

const n = (name: string, children: CustomNode[] = [], completed = false): CustomNode => (
{
	name,
	completed,
	children,
});
const prop = (name: string, hex: string): CustomNode => n(name, [n(hex)]);

describe("validators", () =>
{
	it("accepts 3, 4, 6 and 8 digit hex only", () =>
	{
		expect(
			["#abc", "#abcd", "#aabbcc", "#aabbccdd", "abc", "#abcde", " #abc", "#ggg"].map(isValidHex),
		).toStrictEqual([true, true, true, true, false, false, false, false]);
	});

	it("rejects empty, over-long and punctuated theme names", () =>
	{
		expect(["", "a".repeat(101), "a.b", "My Theme-2_x"].map(isValidThemeName)).toStrictEqual([
			false,
			false,
			false,
			true,
		]);
	});

	it("has 124 property names", () =>
	{
		expect(THEME_PROPS.size).toBe(124);
	});
});

describe("parseCustomThemes", () =>
{
	it("builds the theme list and stylesheet text", () =>
	{
		const themes = n("Themes", [
			n("My Theme", [
				n("main", [prop("background-primary", "#EEEEEE"), prop("foo", "#111")]),
				n("menu", [prop("text-primary", "#111")]),
			]),
		]);
		expect(parseCustomThemes([themes])).toStrictEqual(
			{
				themes:
				{
					My_Theme:
					{
						name: "My_Theme",
						prettyName: "My Theme",
						free: true,
					},
				},
				css:
				{
					My_Theme:
						"._theme-My_Theme {\n  --wf-background-primary: #EEEEEE;\n}\n._theme-My_Theme .wf-menu {\n  --wf-text-primary: #111;\n}\n",
				},
			},
		);
	});

	it("drops a theme without main properties, a completed theme and an invalid hex", () =>
	{
		const themes = n("Themes", [
			n("Menu Only", [n("menu", [prop("text-primary", "#111")])]),
			n("Done", [n("main", [prop("text-primary", "#111")])], true),
			n("Bad", [n("main", [prop("text-primary", "111")])]),
		]);
		expect(parseCustomThemes([themes])).toStrictEqual(
			{
				themes: {},
				css: {},
			},
		);
	});
});
