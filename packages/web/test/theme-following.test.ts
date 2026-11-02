// @vitest-environment happy-dom
import {describe, expect, it} from "vite-plus/test";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {themeFromAccount} from "../src/client/hooks/use-right-bar-sync.js";
import {cssBlock} from "./helpers/css-block.js";

function read(path: string): string
{
	return readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
}

const ladder = read("../src/client/ladder.css");
const styles = read("../src/client/styles.css");

describe("account theme adoption", () =>
{
	it("adopts any registered account theme and ignores unknown or missing ones", () =>
	{
		expect(
			["space", "default", "system", "one_dark", "bogus", null].map((name) => themeFromAccount(name)),
		).toStrictEqual(["space", "default", "system", "one_dark", null, null]);
	});
});

describe("ladder palette", () =>
{
	it("follows the chosen theme rather than the OS colour scheme", () =>
	{
		expect(
			{
				mediaQuery: ladder.includes("prefers-color-scheme"),
				darkPaper: cssBlock(ladder, ':root[data-theme="dark"] .ladder-page')["--paper"],
			},
		).toStrictEqual(
			{
				mediaQuery: false,
				darkPaper: "#12171a",
			},
		);
	});
});

describe("dead theme selector css", () =>
{
	it("is gone, with the old settings theme buttons", () =>
	{
		expect([styles.includes(".theme-selector"), styles.includes(".settings-theme-button")]).toStrictEqual([
			false,
			false,
		]);
	});
});
