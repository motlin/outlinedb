import {describe, expect, it} from "vite-plus/test";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";

const styles = readFileSync(fileURLToPath(new URL("../src/client/styles.css", import.meta.url)), "utf8");
const uncommented = styles.replaceAll(/\/\*[\s\S]*?\*\//gu, "");
const selectors = [...uncommented.matchAll(/([^{}]+)\{[^{}]*\}/gu)].map((match) =>
	match[1].trim().replaceAll(/\s+/gu, " "),
);

describe("bullet halo rules", () =>
{
	it("has no selector naming .diamond, as upstream has none", () =>
	{
		expect(selectors.filter((selector) => selector.includes(".diamond"))).toStrictEqual([]);
	});

	it("scopes the hover halo to .is-desktop and orders it after the collapsed rule", () =>
	{
		const hover = ".is-desktop .bullet:hover > .bulletHalo, .is-desktop .dragging > .bullet > .bulletHalo";
		const collapsed = ".collapsed > .name > .bullet > .bulletHalo, .bullet.bullet--show-halo > .bulletHalo";
		expect(selectors.includes(hover)).toBe(true);
		expect(selectors.indexOf(hover)).toBeGreaterThan(selectors.indexOf(collapsed));
		expect(selectors.includes(".bullet:hover > .bulletHalo")).toBe(false);
	});
});
