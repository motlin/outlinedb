import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vite-plus/test";
import {cssBlock, cssPreludes} from "./helpers/css-block.js";
import {COLOR_ORDER, COLOR_VALUE, colorFromCss} from "../src/color-palette.js";
import {escapeCaret} from "../src/client/hooks/use-color-popup.js";

describe("color css", () => {
	const styles = readFileSync(fileURLToPath(new URL("../src/client/styles.css", import.meta.url)), "utf8");
	const COLORS = ["red", "orange", "yellow", "green", "blue", "purple", "gray", "teal", "sky", "pink"];

	describe("upstream color rules", () => {
		it("colors text with the upstream text token and keeps the decoration", () => {
			expect(COLORS.map((color) => cssBlock(styles, `.c-${color}`))).toStrictEqual(
				COLORS.map((color) => ({
					color: `var(--wf-text-${color})`,
					"text-decoration": "inherit",
					"text-decoration-color": `var(--wf-text-${color})`,
				})),
			);
		});

		it("keeps a link inside colored text in that color, underlined", () => {
			expect(cssBlock(styles, ".c-blue.c-blue > a")).toStrictEqual({
				color: "var(--wf-text-blue)",
				"text-decoration": "underline",
				"text-decoration-color": "var(--wf-text-blue)",
			});
		});

		it("highlights with the background token at double specificity, quaternary text and 2px vertical padding", () => {
			expect(cssBlock(styles, ".bc-sky.bc-sky")).toStrictEqual({
				"background-color": "var(--wf-background-sky)",
				color: "var(--wf-text-quaternary)",
				padding: "2px 0",
			});
		});

		it("underlines a highlight inside a link or a date pill and keeps links readable inside it", () => {
			expect([
				cssBlock(styles, "a > .bc-red.bc-red"),
				cssBlock(styles, "time > .bc-red.bc-red"),
				cssBlock(styles, ".bc-red.bc-red > a"),
			]).toStrictEqual([
				{color: "var(--wf-text-quaternary)", "text-decoration": "underline"},
				{
					color: "var(--wf-text-on-color)",
					"text-decoration": "underline",
					"text-decoration-color": "var(--wf-gray-300)",
				},
				{color: "var(--wf-text-quaternary)"},
			]);
		});

		it("drops the highlight padding in notes", () => {
			const notes = cssPreludes(styles)
				.map((prelude) => prelude.replaceAll(/\s+/gu, " ").trim())
				.find((prelude) => prelude.includes(".notes .bc-gray.bc-gray"));
			expect(notes?.includes(".notes .bc-pink.bc-pink")).toBe(true);
			expect(cssBlock(styles, COLORS.map((color) => `.notes .bc-${color}.bc-${color}`).join(", "))).toStrictEqual(
				{
					padding: "0",
				},
			);
		});

		it("has no .colored rule", () => {
			const preludes = cssPreludes(styles.replaceAll(/\/\*[\s\S]*?\*\//gu, ""));
			expect(preludes.filter((prelude) => prelude.includes(".colored"))).toStrictEqual([]);
		});
	});
});

describe("color palette", () => {
	describe("colorFromCss", () => {
		it("maps exact palette shades from rgb() and hex, case-insensitively", () => {
			expect([
				colorFromCss("rgb(224, 36, 36)"),
				colorFromCss("#fce96a"),
				colorFromCss("#F98080"),
				colorFromCss("rgb(1,2,3)"),
				colorFromCss("#E02425"),
				colorFromCss("red"),
			]).toStrictEqual(["red", "yellow", "red", undefined, undefined, undefined]);
		});
	});

	describe("COLOR_VALUE", () => {
		it("holds upstream's numeric values and display order", () => {
			expect({
				values: COLOR_ORDER.map((color) => COLOR_VALUE[color]),
			}).toStrictEqual({values: [0, 1, 2, 3, 7, 8, 4, 5, 9, 6]});
		});
	});
});

describe("color popup controller", () => {
	describe("escapeCaret", () => {
		it("collapses the selection to its start", () => {
			expect(escapeCaret({start: 6, end: 11})).toStrictEqual({start: 6, end: 6});
		});
	});
});
