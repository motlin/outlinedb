import {readFileSync} from "node:fs";
import {describe, expect, it} from "vite-plus/test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

function printRules(css: string): [string, string][]
{
	const body = /@media print\s*\{([\s\S]*)\}\s*$/u.exec(css)?.[1] ?? "";
	return [...body.matchAll(/([^{}]+)\{([^{}]*)\}/gu)].map((match) => [
		match[1].trim(),
		match[2].replaceAll(/\s+/gu, " ").trim(),
	]);
}

describe("print.css", () =>
{
	it("holds upstream's remaining print rules in one @media print block", () =>
	{
		expect(printRules(read("../src/client/print.css"))).toStrictEqual([
			[
				".page",
				"border: none !important; margin-top: 0 !important; margin-bottom: 0 !important; padding: 0 !important; min-height: 10px !important; box-shadow: none !important; width: auto !important; max-width: 700px !important; margin-left: auto !important; margin-right: auto !important; left: 0 !important; transform: none !important;",
			],
			[
				".mainTreeRoot",
				"min-height: 0px !important; padding-top: 0 !important; padding-bottom: 0 !important; margin-top: 0 !important; margin-bottom: 0 !important;",
			],
			[".children", "border-left: none;"],
			["body", "color: #000; background: #fff !important;"],
			[".bullet", "color: var(--wf-text-quaternary);"],
			[String.raw`.print\:\!min-h-0`, "min-height: 0px !important;"],
		]);
	});

	it("is imported from main.tsx after the app and its styles", () =>
	{
		const main = read("../src/client/main.tsx");
		expect(main.includes('import "./print.css";')).toBe(true);
		expect(main.indexOf('import {App} from "./app.js";')).toBeLessThan(main.indexOf('import "./print.css";'));
	});

	it("prints content links blue and underlined (LID5)", () =>
	{
		const css = read("../src/client/styles.css");
		expect(
			/@media print\s*\{\s*\.contentLink\s*\{\s*color: #00f;\s*text-decoration: underline;\s*\}\s*\}/u.test(css),
		).toBe(true);
	});
});
