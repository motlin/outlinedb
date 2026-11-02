import {describe, expect, it} from "vite-plus/test";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {buildTagColorCss, normalizeTagColors} from "../src/client/tag-color-styles.js";
import {cssBlock} from "./helpers/css-block.js";

const styles = readFileSync(fileURLToPath(new URL("../src/client/styles.css", import.meta.url)), "utf8");
const COLORS = ["red", "orange", "yellow", "green", "teal", "sky", "blue", "purple", "pink", "gray"];

describe("buildTagColorCss", () =>
{
	it("emits one block per color in index order, then five shared blocks over all tags", () =>
	{
		const css = buildTagColorCss(
			{
				"#b": "green",
				"#a": "red",
				"#c": "green",
			},
		);
		const blocks = css.split("}\n").filter((block) => block !== "");
		const first = (block: string) => block.slice(0, block.indexOf(" {"));
		const sel = (suffix: string, prefix = "") =>
			["#b", "#a", "#c"].map((tag) => `${prefix}.contentTag[data-val="${tag}"]${suffix}`).join(",");
		expect(blocks).toHaveLength(7);
		expect(blocks.map((block) => first(block))).toStrictEqual([
			'.contentTag[data-val="#a"]',
			'.contentTag[data-val="#b"],.contentTag[data-val="#c"]',
			sel(" span"),
			sel(":hover"),
			sel(".contentTag .contentTagText"),
			sel("", ".notes "),
			sel("", ".done "),
		]);
		expect(blocks[0]).toContain("background-color: var(--wf-background-red)!important");
		expect(blocks[1]).toContain("background-color: var(--wf-background-green)!important");
	});

	it("never emits the invented --wf-tag-bg- family", () =>
	{
		expect(
			buildTagColorCss(
				{
					"#x": "red",
				},
			),
		).not.toContain("--wf-tag-bg-");
	});

	it.each(COLORS)("paints .bc-%s from the upstream --wf-background token", (color) =>
	{
		expect(cssBlock(styles, `.bc-${color}.bc-${color}`)["background-color"]).toBe(`var(--wf-background-${color})`);
	});

	it.each(COLORS)("colors .c-%s text from the upstream --wf-text token", (color) =>
	{
		expect(cssBlock(styles, `.c-${color}`).color).toBe(`var(--wf-text-${color})`);
	});

	it("is empty without colors", () =>
	{
		expect(buildTagColorCss({})).toBe("");
	});

	it("escapes quotes and backslashes in the attribute value", () =>
	{
		expect(
			buildTagColorCss(
				{
					'#a"b\\c': "red",
				},
			).split("\n")[0],
		).toBe(String.raw`.contentTag[data-val="#a\"b\\c"] {`);
	});
});

describe("normalizeTagColors", () =>
{
	it("lowercases keys", () =>
	{
		expect(
			normalizeTagColors(
				{
					"#TaZebra": "green",
					"@Alice": "red",
				},
			),
		).toStrictEqual(
			{
				"#tazebra": "green",
				"@alice": "red",
			},
		);
	});
});
