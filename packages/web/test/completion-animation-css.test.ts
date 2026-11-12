import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vite-plus/test";
import {cssBlock} from "./helpers/css-block.js";

const styles = readFileSync(fileURLToPath(new URL("../src/client/styles.css", import.meta.url)), "utf8");

describe("completion slideUp CSS", () =>
{
	it("contains upstream's slideUp declarations on .project.completing-slide-up", () =>
	{
		expect(cssBlock(styles, ".project.completing-slide-up")).toStrictEqual(
			{
				"transform-origin": "0 0",
				"will-change": "transform, opacity",
				transition: "opacity 120ms, transform 120ms",
				opacity: "0",
				transform: "scale(0.2, 0)",
			},
		);
	});
});

describe("show completed slideDown CSS", () =>
{
	it("animates .project.completed-slide-down from the top-left corner for 120ms", () =>
	{
		expect(cssBlock(styles, ".project.completed-slide-down")).toStrictEqual(
			{
				"transform-origin": "0 0",
				animation: "completed-slide-down 120ms",
			},
		);
	});

	it("defines the completed-slide-down keyframes", () =>
	{
		expect(styles).toContain(
			"@keyframes completed-slide-down\n{\n\tfrom\n\t{\n\t\topacity: 0;\n\t\ttransform: scale(0.2, 0);\n\t}\n\tto\n\t{\n\t\topacity: 1;\n\t\ttransform: scale(1, 1);\n\t}\n}",
		);
	});
});

describe("expand slideDown CSS", () =>
{
	it("lets notes under a row whose children are sliding down use their inherited line clamp", () =>
	{
		expect(cssBlock(styles, ".project.animatingShowChildren .noted > .notes > .content")).toStrictEqual(
			{
				"-webkit-line-clamp": "inherit",
			},
		);
	});
});
