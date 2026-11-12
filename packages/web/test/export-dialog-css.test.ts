import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vite-plus/test";
import {cssBlock, hasSelector} from "./helpers/css-block.js";

const styles = readFileSync(fileURLToPath(new URL("../src/client/styles.css", import.meta.url)), "utf8");

describe("export dialog button styles", () =>
{
	it("gives .wf-dialog buttons upstream's bare button base, .primary and .large at zero specificity", () =>
	{
		expect(
			{
				base: cssBlock(styles, ":where(.wf-dialog) button"),
				hover: cssBlock(
					styles,
					":where(.wf-dialog) button:focus, :where(.wf-dialog) button:hover, :where(.wf-dialog) button:active",
				),
				primary: cssBlock(styles, ":where(.wf-dialog) .primary"),
				primaryHover: cssBlock(
					styles,
					":where(.wf-dialog) .primary:focus, :where(.wf-dialog) .primary:hover, :where(.wf-dialog) .primary:active",
				),
				large: cssBlock(styles, ":where(.wf-dialog) .large"),
			},
		).toStrictEqual(
			{
				base:
				{
					display: "inline-block",
					position: "relative",
					"-webkit-appearance": "none",
					appearance: "none",
					border: "none",
					outline: "none",
					"box-sizing": "border-box",
					"border-radius": "var(--wf-radius-pill)",
					padding: "var(--wf-space-s) var(--wf-space-l)",
					"font-weight": "var(--wf-font-weight-regular)",
					"line-height": "var(--wf-line-height-s)",
					"font-family": "inherit",
					"font-size": "var(--wf-font-size-s)",
					background: "var(--wf-background-tertiary)",
					"text-align": "center",
					"text-decoration": "none",
					color: "var(--wf-text-primary)",
					cursor: "pointer",
					"-webkit-tap-highlight-color": "transparent",
				},
				hover:
				{
					"text-decoration": "none",
					"background-color": "color-mix(in srgb, var(--wf-background-quaternary) 85%, black)",
				},
				primary:
				{
					background: "var(--wf-background-tint)",
					color: "var(--wf-text-on-color)",
				},
				primaryHover:
				{
					"background-color": "color-mix(in srgb, var(--wf-background-tint) 85%, black)",
				},
				large:
				{
					"border-radius": "var(--wf-radius-pill)",
					padding: "var(--wf-space-m) var(--wf-space-l)",
				},
			},
		);
	});

	it("scopes light tokens to ._theme-default so the preview stays light in the dark theme", () =>
	{
		expect(cssBlock(styles, "._theme-default")["--wf-background-primary"]).toBe("var(--wf-gray-0)");
	});

	it("drops the local .export-dialog-* rules", () =>
	{
		expect(hasSelector(styles, /\.export-dialog/u)).toBe(false);
	});
});
