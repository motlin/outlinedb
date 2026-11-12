import {describe, expect, it} from "vite-plus/test";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {cssBlock} from "./helpers/css-block.js";

const styles = readFileSync(fileURLToPath(new URL("../src/client/styles.css", import.meta.url)), "utf8");

describe("tag CSS parity with upstream wf-base", () =>
{
	it("styles .content .contentTag like upstream", () =>
	{
		expect(cssBlock(styles, ".content .contentTag")).toStrictEqual(
			{
				color: "var(--wf-text-tertiary)",
				"word-break": "normal",
				padding: "0 1px",
				margin: "0 -1px",
				"border-radius": "3px",
				cursor: "pointer",
			},
		);
	});

	it("neutralizes inline formatting inside a tag", () =>
	{
		expect(cssBlock(styles, ".content .contentTag b")).toStrictEqual(
			{
				"font-weight": "inherit",
			},
		);
		expect(cssBlock(styles, ".content .contentTag i")).toStrictEqual(
			{
				"font-style": "inherit",
			},
		);
		expect(cssBlock(styles, ".content .contentTag u")).toStrictEqual(
			{
				"text-decoration": "none",
			},
		);
	});

	it("highlights a hovered tag with the tertiary background", () =>
	{
		expect(cssBlock(styles, ".content .contentTag:hover")).toStrictEqual(
			{
				background: "var(--wf-background-tertiary)",
			},
		);
	});

	it("underlines only the tag text, not the #", () =>
	{
		expect(cssBlock(styles, ".content .contentTag .contentTagText")).toStrictEqual(
			{
				"text-decoration": "underline",
			},
		);
		expect(cssBlock(styles, ".content .contentTag")["text-decoration"]).toBeUndefined();
	});

	it("carries the delete-hover, selection and tapped states", () =>
	{
		expect(cssBlock(styles, ".content .contentTag.contentTagDelete:hover")).toStrictEqual(
			{
				"background-color": "#f4666633",
			},
		);
		expect(cssBlock(styles, ".content .contentTag.contentTagDeleteHover:hover")).toStrictEqual(
			{
				color: "#f4666666",
			},
		);
		expect(cssBlock(styles, ".content .contentTag.contentTagDeleteHover:hover .contentTagNub")).toStrictEqual(
			{
				display: "none",
			},
		);
		expect(cssBlock(styles, ".project.addedToSelection .content .contentTag:hover")).toStrictEqual(
			{
				background: "none",
			},
		);
		expect(cssBlock(styles, ".contentTag.tapped")).toStrictEqual(
			{
				background: "var(--wf-background-tertiary)",
			},
		);
	});

	it("has no legacy .tag-link or .innerContentContainer .contentTag selectors", () =>
	{
		expect(styles.includes(".tag-link")).toBe(false);
		expect(styles.includes(".innerContentContainer .contentTag")).toBe(false);
	});
});

describe("tag color teaser glyph", () =>
{
	it("is a 15px circle (default content-box 13px plus border) in the inherited color", () =>
	{
		const glyph = cssBlock(styles, ".tag-color-teaser-glyph");
		expect(glyph["box-sizing"]).toBeUndefined();
		expect(glyph.color).toBe("inherit");
		expect(JSON.stringify(glyph)).not.toContain("--wf-text-link");
	});
});

describe("mention CSS parity with upstream wf-base", () =>
{
	it("shows the @ sign after the at-sign span", () =>
	{
		expect(cssBlock(styles, ".mention .at-sign::after")).toStrictEqual(
			{
				content: '"@"',
			},
		);
	});

	it("sizes the @ sign in notes", () =>
	{
		expect(cssBlock(styles, ".notes .mention .at-sign")).toStrictEqual(
			{
				"font-size": "12px",
			},
		);
		expect(cssBlock(styles, ".root > .notes .mention .at-sign")).toStrictEqual(
			{
				"font-size": "inherit",
			},
		);
	});
});
