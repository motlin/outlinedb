import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vite-plus/test";
import {cssBlock, cssPreludes} from "./helpers/css-block.js";

const styles = readFileSync(fileURLToPath(new URL("../src/client/styles.css", import.meta.url)), "utf8");
const preludes = cssPreludes(styles.replaceAll(/\/\*[\s\S]*?\*\//gu, "")).map((prelude) =>
	prelude.replaceAll(/\s+/gu, " ").trim(),
);

describe("heading typography", () =>
{
	it("scopes the heading font to the row's own .name, never descending to the inner span", () =>
	{
		const leaking = preludes.filter((prelude) =>
			/\.header[123][^,{]*\s\.(innerContentContainer|content-editable)/u.test(prelude),
		);
		expect(leaking).toStrictEqual([]);
	});

	it("sizes each heading on its .name with upstream's tokens", () =>
	{
		expect([
			cssBlock(styles, ".header1:not(.root) > .name")["font-size"],
			cssBlock(styles, ".header2:not(.root) > .name")["font-size"],
			cssBlock(styles, ".header3:not(.root) > .name")["font-size"],
		]).toStrictEqual(["var(--wf-font-size-xl)", "var(--wf-font-size-l)", "var(--wf-font-size-m)"]);
	});

	it("makes headings bold with a 1.375em line height and an 8px desktop margin", () =>
	{
		expect(
			cssBlock(styles, ".header1:not(.root) > .name, .header2:not(.root) > .name, .header3:not(.root) > .name"),
		).toStrictEqual(
			{
				"font-weight": "700",
				"--line-height": "1.375em",
			},
		);
		expect(
			cssBlock(
				styles,
				".is-desktop .header1:not(.root) > .name, .is-desktop .header2:not(.root) > .name, .is-desktop .header3:not(.root) > .name",
			),
		).toStrictEqual(
			{
				"margin-top": "var(--wf-space-m)",
				"margin-bottom": "var(--wf-space-m)",
			},
		);
	});

	it("passes the line height to the name's direct children", () =>
	{
		const selector = [1, 2, 3]
			.flatMap((level) =>
				["expand", "menu", "prefix", "bullet", "content"].map(
					(child) => `.header${level}:not(.root) > .name > .${child}`,
				),
			)
			.join(", ");
		expect(cssBlock(styles, selector)).toStrictEqual(
			{
				"line-height": "var(--line-height)",
				"font-size": "inherit",
			},
		);
	});
});

describe("block layout rules", () =>
{
	it("styles the code block box with upstream's tokens", () =>
	{
		expect(cssBlock(styles, ".code-block > .name .content")).toStrictEqual(
			{
				"box-sizing": "border-box",
				"max-width": "100%",
				padding: "var(--wf-space-l) var(--wf-space-l)",
				"overflow-wrap": "break-word",
				background: "var(--wf-background-secondary)",
				border: "var(--wf-border-width-s) solid var(--wf-border-primary)",
				"border-radius": "var(--wf-radius-s)",
				"font-family": "var(--font-code-font-family, var(--wf-font-family-mono))",
			},
		);
	});

	it("draws the quote bar on the inner container", () =>
	{
		expect(cssBlock(styles, ".quote-block > .name > .content .innerContentContainer")).toStrictEqual(
			{
				"border-left": "solid var(--wf-border-width-l) var(--wf-border-primary)",
				padding: "0 var(--wf-space-l)",
			},
		);
	});

	it("draws an empty quote's bar as tall as the item line", () =>
	{
		expect(cssBlock(styles, ".quote-block > .name > .content:empty:before")).toStrictEqual(
			{
				content: '""',
				display: "block",
				height: "var(--wf-item-line-height, 0)",
				position: "relative",
				left: "calc(var(--wf-space-ml) * -1)",
				"border-left": "solid var(--wf-border-width-l) var(--wf-border-primary)",
			},
		);
	});

	it("defines the item line height on rows and the zoom root", () =>
	{
		expect([
			cssBlock(styles, ".name > .content")["--wf-item-line-height"],
			cssBlock(styles, ".name--main > .content")["--wf-item-line-height"],
		]).toStrictEqual(["var(--font-default-line-height)", "var(--font-selected-name-line-height)"]);
	});

	it("pads a paragraph's children", () =>
	{
		expect(cssBlock(styles, ".paragraph:not(.root) > .children")).toStrictEqual(
			{
				"padding-top": "var(--wf-space-s)",
			},
		);
	});

	it("hides the bullet until hover on bullet-on-hover rows", () =>
	{
		expect(cssBlock(styles, ".project--bullet-on-hover > .name > .bullet")).toStrictEqual(
			{
				opacity: "0.00000001 !important",
			},
		);
	});

	it("keeps the old guessed block rules out", () =>
	{
		const guessed = preludes.filter(
			(prelude) =>
				(/\.bulletHalo/u.test(prelude) && /header[123]|divider|checkmark/u.test(prelude)) ||
				(/\.(code-block|quote-block|divider)/u.test(prelude) && /\.outline-node/u.test(prelude)),
		);
		expect(guessed).toStrictEqual([]);
		expect(/\.(code-block|quote-block)[^{]*\{[^}]*--wf-gray-/u.test(styles)).toBe(false);
	});
});
