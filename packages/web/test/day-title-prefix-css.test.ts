import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vite-plus/test";
import {cssBlock} from "./helpers/css-block.js";

const styles = readFileSync(fileURLToPath(new URL("../src/client/styles.css", import.meta.url)), "utf8");

describe("friendly day prefix box model", () =>
{
	it("is default content-box with line-height 1 like upstream, so a listed row's span is 28px tall", () =>
	{
		expect(cssBlock(styles, ".name > span.whitespace-nowrap.pr-m")).toStrictEqual(
			{
				"line-height": "1",
			},
		);
	});
});
