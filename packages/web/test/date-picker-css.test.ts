import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vite-plus/test";
import {cssBlock} from "./helpers/css-block.js";

const styles = readFileSync(fileURLToPath(new URL("../src/client/styles.css", import.meta.url)), "utf8");

describe("date picker calendar button styles", () =>
{
	it("gives the calendar's buttons upstream's bare `button` base at element specificity, so no browser border shows", () =>
	{
		expect(
			{
				base: cssBlock(styles, ":where([data-keyboard-focus-scope]) button"),
				hover: cssBlock(
					styles,
					":where([data-keyboard-focus-scope]) button:focus, :where([data-keyboard-focus-scope]) button:hover, :where([data-keyboard-focus-scope]) button:active",
				),
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
			},
		);
	});

	it("lets `h-s` size the 6px found-date dot over FA's 1em", () =>
	{
		expect(
			{
				dot: cssBlock(styles, ".svg-inline--fa.h-s"),
			},
		).toStrictEqual(
			{
				dot:
				{
					height: "0.375rem",
				},
			},
		);
	});
});

describe("date surface resets", () =>
{
	it("styles .tooltip-key like upstream's wf-base rule", () =>
	{
		expect(cssBlock(styles, ".tooltip-key")).toStrictEqual(
			{
				padding: "var(--wf-space-xs)",
				"border-radius": "var(--wf-radius-xs)",
				border: "var(--wf-border-width-s) solid var(--wf-border-primary)",
			},
		);
	});

	it("removes the focus ring from the date input like css_reset's :focus{outline:0}", () =>
	{
		expect(cssBlock(styles, ".date-popup-input:focus")).toStrictEqual(
			{
				outline: "0",
			},
		);
	});

	it("resets the autocomplete flyout paragraph margin and line height", () =>
	{
		expect(cssBlock(styles, ".wf-menu.flyout.text-center > p.text-xs")).toStrictEqual(
			{
				margin: "0",
				"line-height": "1",
			},
		);
	});
});
