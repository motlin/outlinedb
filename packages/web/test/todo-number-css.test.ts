import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vite-plus/test";
import {cssBlock} from "./helpers/css-block.js";

const styles = readFileSync(fileURLToPath(new URL("../src/client/styles.css", import.meta.url)), "utf8");

describe("prefix slot and checkbox CSS", () =>
{
	it("clones upstream's prefix and checkbox rules", () =>
	{
		expect(
			{
				hiddenWhenEmpty: cssBlock(styles, ".name > .prefix:empty"),
				prefix: cssBlock(styles, ".prefix"),
				content: cssBlock(styles, ".prefix + .content"),
				checkbox: cssBlock(styles, ".item-checkbox"),
				input: cssBlock(styles, ".item-checkbox > input"),
				bg: cssBlock(styles, ".checkbox-bg"),
				hover: cssBlock(styles, ".item-checkbox:hover > .checkbox-bg, .item-checkbox:checked > .checkbox-bg"),
			},
		).toStrictEqual(
			{
				hiddenWhenEmpty:
				{
					display: "none",
				},
				prefix:
				{
					height: "var(--line-height)",
					"margin-right": "calc(var(--line-height) * 0.3)",
					"padding-top": "var(--wf-content-padding-top)",
				},
				content:
				{
					"max-width": "calc(100% - 2 * var(--prefix-count) * var(--line-height))",
				},
				checkbox:
				{
					background: "none",
					color: "var(--wf-text-primary)",
					cursor: "pointer",
					display: "inline-flex",
					"align-items": "center",
					position: "relative",
					"justify-content": "center",
				},
				input:
				{
					position: "absolute",
					height: "0",
					width: "0",
					opacity: "0",
					cursor: "pointer",
				},
				bg:
				{
					position: "absolute",
					top: "1px",
					right: "1px",
					bottom: "1px",
					left: "1px",
					background: "var(--wf-background-primary)",
					"border-radius": "var(--wf-radius-xs)",
				},
				hover:
				{
					background: "var(--wf-background-quaternary)",
				},
			},
		);
	});

	it("no longer hides the bullet of a to-do row", () =>
	{
		expect(styles.includes(".checkmark")).toBe(false);
	});
});
