import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vite-plus/test";
import {cssBlock} from "./helpers/css-block.js";

const styles = readFileSync(fileURLToPath(new URL("../src/client/styles.css", import.meta.url)), "utf8");

describe("done styling CSS", () =>
{
	it("drops the local completed-name rule and the completed text token usage", () =>
	{
		expect(
			[".name.completed", ".completed .innerContentContainer", "var(--wf-text-completed)"].filter((text) =>
				styles.includes(text),
			),
		).toStrictEqual([]);
	});

	it("contains upstream's done rules", () =>
	{
		expect(
			{
				content: cssBlock(styles, ".done > .name > .content"),
				dimmed: cssBlock(styles, ".done .name > .content, .name > .content.done"),
				pill: cssBlock(styles, ".done > .name > .content .monolith-pill .content-wrapper"),
				checkbox: cssBlock(
					styles,
					".item-checkbox.checked, .done .item-checkbox, .done .image-viewer, .done .embed, .done .twitter-tweet",
				),
			},
		).toStrictEqual(
			{
				content:
				{
					"text-decoration": "line-through",
				},
				dimmed:
				{
					opacity: "37%",
				},
				pill:
				{
					"text-decoration": "line-through",
				},
				checkbox:
				{
					opacity: "0.37",
				},
			},
		);
		expect(styles.includes(".todo-checkbox")).toBe(false);
	});
});
