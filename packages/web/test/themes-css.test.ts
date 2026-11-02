import {describe, expect, it} from "vite-plus/test";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {cssBlock, cssBlockText} from "./helpers/css-block.js";

function read(path: string): string
{
	return readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
}

const styles = read("../src/client/styles.css");
const app = read("../src/client/app.tsx");
const NAMES = [
	"catppuccin",
	"chocolate",
	"glass",
	"hacker",
	"matcha",
	"moon",
	"neo",
	"one_dark",
	"robot",
	"space",
	"steel",
	"vintage",
	"wood",
] as const;
const sheets = Object.fromEntries(NAMES.map((name) => [name, read(`../src/client/themes/${name}.css`)]));

const KEYS = ["--wf-background-primary", "--wf-text-primary", "--wf-text-tint", "--wf-background-ambient"];

/** Authored key tokens from upstream's sheets (bg-primary, text-primary, text-tint, background-ambient). */
const KEY_TOKENS: Record<string, [string, string, string, string]> =
{
	catppuccin: ["#1e1e2e", "#cdd6f4", "#89b4fa", "#1e1e2e"],
	chocolate: ["#ffefe2", "#281603", "#cf8752", "#ffefe2"],
	glass: ["#ffffffee", "var(--wf-gray-800)", "var(--wf-blue-300)", "#ffffff"],
	hacker: [
		"var(--wf-lime-green-800)",
		"var(--wf-lime-green-100)",
		"var(--wf-lime-green-200)",
		"var(--wf-lime-green-800)",
	],
	matcha: ["#ddeabe", "#415915", "#85ac41", "#ddeabe"],
	moon: ["#fdf6f6", "#615f7f", "#b2b1d2", "#fdf6f6"],
	neo: ["#141414", "#dcdbdb", "var(--wf-blue-300)", "#141414"],
	one_dark: ["#282c33", "#c8ccd4", "#73ade9", "#282c33"],
	robot: ["var(--robot-black)", "var(--robot-orange)", "#4ed8a3a7", "var(--robot-black)"],
	space: ["var(--wf-dark-gray-800)", "var(--wf-dark-gray-100)", "var(--wf-dark-blue-400)", "var(--wf-dark-gray-800)"],
	steel: ["var(--wf-gray-0)", "var(--wf-gray-800)", "var(--wf-blue-300)", "var(--wf-gray-0)"],
	vintage: ["var(--wf-gray-0)", "var(--wf-gray-800)", "var(--wf-blue-300)", "var(--wf-gray-200)"],
	wood: ["var(--wf-gray-0)", "var(--wf-gray-800)", "var(--wf-blue-300)", "var(--wf-gray-0)"],
};

/** The theme block's own declarations, without the nested surface re-scopes. */
function ownDeclarations(name: string): Record<string, string>
{
	const body = cssBlockText(sheets[name], `._theme-${name}`).replaceAll(/[^;{}]*\{[^{}]*\}/gu, "");
	return cssBlock(`x { ${body} }`, "x");
}

function keyTokens(name: string): Record<string, string>
{
	const block = ownDeclarations(name);
	return Object.fromEntries(KEYS.map((key) => [key, block[key].toLowerCase()]));
}

describe("ported theme sheets", () =>
{
	it.each(NAMES)("%s declares upstream's key tokens", (name) =>
	{
		expect(keyTokens(name)).toStrictEqual(
			Object.fromEntries(KEYS.map((key, index) => [key, KEY_TOKENS[name][index]])),
		);
	});

	it.each(NAMES)("%s declares the full standard token set", (name) =>
	{
		const names = Object.keys(ownDeclarations(name)).filter((key) => /^--wf-(background|text|border)-/u.test(key));
		expect(names.length).toBeGreaterThanOrEqual(55);
	});

	it.each(NAMES)("%s re-scopes the header, menu and helper", (name) =>
	{
		const body = cssBlockText(sheets[name], `._theme-${name}`);
		expect(["wf-header", "wf-menu", "wf-helper"].map((surface) => body.includes(`.${surface}`))).toStrictEqual([
			true,
			true,
			true,
		]);
	});

	it("keeps the extra ambient and robot tokens", () =>
	{
		expect(
			{
				woodBorder: ownDeclarations("wood")["--wf-border-ambient"],
				robotBlack: ownDeclarations("robot")["--robot-black"],
				limeGreen: cssBlock(styles, ":root")["--wf-lime-green-800"],
			},
		).toStrictEqual(
			{
				woodBorder: "#831",
				robotBlack: "#000000",
				limeGreen: "#000000",
			},
		);
	});

	it("points ambient images at absolute upstream URLs", () =>
	{
		expect(["space", "steel", "wood"].map((name) => ownDeclarations(name)["--wf-image-ambient"])).toStrictEqual([
			'url("https://workflowy.com/media/i/themes/space_big.5ef562c7a2eb.jpg")',
			'url("https://workflowy.com/media/i/themes/steel_big.5d7bd7450f28.jpg")',
			'url("https://workflowy.com/media/i/themes/wood_big.3a2b4487c7bb.jpg")',
		]);
	});

	it("keeps one_dark's license comment", () =>
	{
		expect(sheets.one_dark).toContain("License: MPL-2.0");
	});

	it("imports the sheets in upstream's link order after styles.css", () =>
	{
		const imports = [...app.matchAll(/import "\.\/themes\/(\w+)\.css";/gu)].map((match) => match[1]);
		expect(
			{
				imports,
				afterStyles: app.indexOf('import "./styles.css"') < app.indexOf("./themes/hacker.css"),
			},
		).toStrictEqual(
			{
				imports: [
					"hacker",
					"space",
					"steel",
					"vintage",
					"wood",
					"neo",
					"catppuccin",
					"moon",
					"robot",
					"glass",
					"chocolate",
					"matcha",
					"one_dark",
				],
				afterStyles: true,
			},
		);
	});
});
