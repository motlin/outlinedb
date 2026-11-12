import {describe, expect, it} from "vite-plus/test";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {cssPreludes} from "./helpers/css-block.js";

function readSource(relative: string): string
{
	return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

const styles = readSource("../src/client/styles.css");
const ladder = readSource("../src/client/ladder.css");

function stripComments(css: string): string
{
	return css.replaceAll(/\/\*[\s\S]*?\*\//gu, "");
}

const LOCAL_SURFACES = [
	".ladder-page",
	".ladder-ghost",
	".ladder-preview",
	".ladder-tree-panel",
	".related-nodes-panel",
	".error-notifications",
	".inline-loading",
	".loading-spinner",
	".presentation-overlay",
	".changes-page",
	".settings-row",
];

describe("global box-sizing reset (upstream has none: every element is content-box)", () =>
{
	it("has no universal box-sizing rule", () =>
	{
		const universal = cssPreludes(stripComments(styles))
			.map((prelude) => prelude.trim())
			.filter((prelude) => /(^|,)\s*\*(::before|::after)?\s*(,|$)/u.test(prelude));
		expect(universal).toStrictEqual([]);
	});

	it("keeps border-box for local-only surfaces through a zero-specificity scope", () =>
	{
		const scope = `:where(${LOCAL_SURFACES.join(",")})`;
		const expected = [scope, `${scope}*`, `${scope}*::before`, `${scope}*::after`];
		const match =
			/((?::where\([^)]*\)\s*\*?(?:::before|::after)?\s*,\s*){3}:where\([^)]*\)\s*\*::after)\s*\{([^}]*)\}/u.exec(
				stripComments(styles),
			);
		expect(
			{
				selectors: (match?.[1] ?? "").replaceAll(/\s+/gu, "").split(/,(?=:where)/u),
				declarations: (match?.[2] ?? "").replaceAll(/\s+/gu, ""),
			},
		).toStrictEqual(
			{
				selectors: expected,
				declarations: "box-sizing:border-box;",
			},
		);
	});

	it("drops the scoped content-box workarounds the global reset needed", () =>
	{
		const bodies = [...stripComments(styles).matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
			.filter((match) => /box-sizing:\s*content-box/u.test(match[2]))
			.map((match) => match[1].trim());
		expect(bodies).toStrictEqual([]);
	});

	it("keeps ladder.css free of box-sizing so the scope above owns it", () =>
	{
		expect(ladder).not.toMatch(/box-sizing/u);
	});
});
