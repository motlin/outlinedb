import {readFileSync} from "node:fs";
import {describe, expect, it} from "vite-plus/test";

const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");

function block(selector: string): string[]
{
	const start = css.lastIndexOf(`\n${selector}\n{`);
	const end = css.indexOf("}", start);
	return css
		.slice(start + selector.length + 3, end)
		.split(";")
		.map((line) => line.trim())
		.filter((line) => line !== "");
}

describe("mention popup css", () =>
{
	it("matches upstream's declarations", () =>
	{
		expect([block(".menu.mention-popup"), block(".mention-avatar")]).toStrictEqual([
			["padding-bottom: 0"],
			[
				"border: var(--wf-border-width-s) solid var(--wf-border-primary)",
				"display: flex",
				"flex-shrink: 0",
				"border-radius: 50%",
				"width: 18px",
				"height: 18px",
				"font-size: 10px",
				"align-items: center",
				"justify-content: center",
			],
		]);
	});
});
