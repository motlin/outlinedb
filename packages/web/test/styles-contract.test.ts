import {describe, expect, it} from "vite-plus/test";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {cssBlock, hasSelector} from "./helpers/css-block.js";

const styles = readFileSync(fileURLToPath(new URL("../src/client/styles.css", import.meta.url)), "utf8");

describe("flyout surface styles", () =>
{
	it("gives the portaled flyout body line-height 1 and the default content-box", () =>
	{
		expect(cssBlock(styles, ".wf-menu.flyout")).toStrictEqual(
			{
				"line-height": "1",
			},
		);
	});

	it("drops the location picker's own line-height restore, now inherited from the flyout rule", () =>
	{
		expect(hasSelector(styles, /min-w-\\\[480px\\\]\s*>\s*\.wf-menu\.flyout/u)).toBe(false);
	});
});
