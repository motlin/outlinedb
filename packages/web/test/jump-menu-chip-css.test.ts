import {readFileSync} from "node:fs";
import {describe, expect, it} from "vite-plus/test";

const tailwind = readFileSync(new URL("../src/client/wf-tailwind.css", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");

/** The declarations of the first rule whose selector is exactly `selector`, whitespace-normalized. */
function declarations(css: string, selector: string): string | undefined
{
	// wf-tailwind.css is a verbatim upstream copy with same-line braces; styles.css puts braces on their own line.
	const start = Math.max(css.indexOf(`\n${selector} {`), css.indexOf(`\n${selector}\n{`));
	if (start === -1)
	{
		return undefined;
	}
	const open = css.indexOf("{", start);
	return css
		.slice(open + 1, css.indexOf("}", open))
		.replaceAll(/\s+/gu, " ")
		.trim();
}

describe("jump-menu chip utilities", () =>
{
	it.each([
		[String.raw`.\!px-xs`, ["padding-left: 0.25rem !important", "padding-right: 0.25rem !important"]],
		[String.raw`.\!py-xs`, ["padding-top: 0.25rem !important", "padding-bottom: 0.25rem !important"]],
		[String.raw`.\!text-xs`, ["font-size: 0.79rem !important"]],
		[String.raw`.\!rounded-pill`, ["border-radius: 9999px !important"]],
		[String.raw`.\!gap-xs`, ["gap: 0.25rem !important"]],
		[".gap-xs", ["gap: 0.25rem"]],
		[".shrink-0", ["flex-shrink: 0"]],
	])("%s is defined", (selector, expected) =>
	{
		const body = declarations(tailwind, selector);
		expect(expected.every((declaration) => body?.includes(declaration))).toBe(true);
	});

	it("keeps .button.secondary transparent", () =>
	{
		expect(declarations(styles, ".button.secondary")).toContain("background: transparent");
	});
});
