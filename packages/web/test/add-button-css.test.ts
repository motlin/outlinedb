import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vite-plus/test";
import {cssBlock, cssPreludes} from "./helpers/css-block.js";

const styles = readFileSync(fileURLToPath(new URL("../src/client/styles.css", import.meta.url)), "utf8").replaceAll(
	/\/\*[\s\S]*?\*\//gu,
	"",
);

const preludes = cssPreludes(styles).map((prelude) => prelude.trim());

describe("add-child button styles", () =>
{
	it("drops the legacy container and keeps only upstream's svg sizing rule", () =>
	{
		expect(
			{
				legacyContainer: preludes.filter((prelude) => prelude.includes(".add-button-container")),
				addChildSelectors: preludes.filter(
					(prelude) => prelude.includes(".addChildButton") && !prelude.includes(".dashboard-card"),
				),
				svg: cssBlock(styles, ".addChildButton svg"),
			},
		).toStrictEqual(
			{
				legacyContainer: [],
				addChildSelectors: [".addChildButton svg"],
				svg:
				{
					width: "14px",
					height: "16px",
				},
			},
		);
	});
});

describe("add-sibling button styles", () =>
{
	it("pins upstream's svg to the guide line's bottom, hidden until hovered", () =>
	{
		expect(
			{
				base: cssBlock(styles, ".addSiblingButton"),
				hover: cssBlock(styles, ".addSiblingButton:hover"),
				active: cssBlock(styles, ".addSiblingButton:active"),
			},
		).toStrictEqual(
			{
				base:
				{
					position: "absolute",
					left: "-11px",
					bottom: "3px",
					width: "20px",
					height: "20px",
					display: "block",
					opacity: "0",
					cursor: "pointer",
				},
				hover:
				{
					opacity: "0.7",
				},
				active:
				{
					opacity: "1",
				},
			},
		);
	});
});
