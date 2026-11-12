import {describe, expect, it} from "vite-plus/test";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {cssBlock} from "./helpers/css-block.js";

function readSource(relative: string): string
{
	return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

const styles = readSource("../src/client/styles.css");
const ladder = readSource("../src/client/ladder.css");

// The upstream reset zeroes margins and list markers; local-only surfaces keep their old browser-default look.
describe("local-only surfaces keep their pre-reset spacing", () =>
{
	it.each([
		[".related-nodes-panel-hint, .related-nodes-panel-status, .related-nodes-panel-empty"],
		[".related-nodes-panel-error"],
	])("%s has the paragraph margin", (selector) =>
	{
		expect(cssBlock(styles, selector).margin).toBe("1em 0");
	});

	it("gives the ladder tree dialog paragraphs, lists and nested lists their old spacing", () =>
	{
		expect(cssBlock(ladder, ".ladder-tree-empty").margin).toBe("1em 0");
		expect(cssBlock(ladder, ":where(.ladder-tree-body) p")).toStrictEqual(
			{
				margin: "1em 0",
			},
		);
		expect(cssBlock(ladder, ".ladder-tree-body ul")).toStrictEqual(
			{
				margin: "1em 0",
				"padding-left": "22px",
				"list-style": "disc",
			},
		);
		expect(cssBlock(ladder, ".ladder-tree-body li > ul")).toStrictEqual(
			{
				margin: "0",
				"list-style": "circle",
			},
		);
	});
});
