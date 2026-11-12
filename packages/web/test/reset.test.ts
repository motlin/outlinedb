import {describe, expect, it} from "vite-plus/test";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {cssBlock} from "./helpers/css-block.js";

describe("reset css", () => {
	function readSource(relative: string): string {
		return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
	}

	const reset = readSource("../src/client/reset.css");
	const styles = readSource("../src/client/styles.css");
	const app = readSource("../src/client/app.tsx");

	const RESET_ELEMENTS = [
		"html, body, div, span, applet, object, iframe,",
		"h1, h2, h3, h4, h5, h6, p, blockquote, pre,",
		"a, abbr, acronym, address, big, cite, code,",
		"del, dfn, em, font, img, ins, kbd, q, s, samp,",
		"small, strike, strong, sub, sup, tt, var,",
		"b, u, i, center,",
		"dl, dt, dd, ol, ul, li,",
		"fieldset, form, label, legend,",
		"table, caption, tbody, tfoot, thead, tr, th, td",
	].join(" ");

	describe("upstream reset.css (css_reset.11b989919d8b.css)", () => {
		it("resets margin, padding, outline, font-size, vertical-align and background on every listed element", () => {
			expect(cssBlock(reset, RESET_ELEMENTS)).toStrictEqual({
				margin: "0",
				padding: "0",
				border: "0",
				outline: "0",
				"font-size": "100%",
				"vertical-align": "baseline",
				background: "transparent",
			});
		});

		it("sets body line-height 1, no list markers, no quotes and no focus outline", () => {
			expect(cssBlock(reset, "body")).toStrictEqual({"line-height": "1"});
			expect(cssBlock(reset, "ol, ul")).toStrictEqual({"list-style": "none"});
			expect(cssBlock(reset, "blockquote, q")).toStrictEqual({quotes: "none"});
			expect(cssBlock(reset, ":focus")).toStrictEqual({outline: "0"});
			expect(cssBlock(reset, "ins")).toStrictEqual({"text-decoration": "none"});
			expect(cssBlock(reset, "del")).toStrictEqual({"text-decoration": "line-through"});
			expect(cssBlock(reset, "table")).toStrictEqual({"border-collapse": "collapse", "border-spacing": "0"});
		});

		it("loads before tailwind so utilities win ties", () => {
			expect(app.indexOf('import "./reset.css";')).toBeGreaterThan(-1);
			expect(app.indexOf('import "./reset.css";')).toBeLessThan(app.indexOf('import "./wf-tailwind.css";'));
		});

		it("is not duplicated in styles.css", () => {
			expect(styles.includes("applet,")).toBe(false);
		});

		it("leaves the bullet without a local focus ring", () => {
			expect(/\.bullet:focus\s*\{/u.test(styles)).toBe(false);
		});

		it("drops the body line-height override and the scoped line-height workarounds", () => {
			expect(cssBlock(styles, "body")["line-height"]).toBeUndefined();
			expect(styles.includes(":where([data-calendar-layout])")).toBe(false);
			expect(cssBlock(styles, ".related-nodes-panel")["line-height"]).toBe("1.5");
		});
	});
});

describe("reset local surfaces", () => {
	function readSource(relative: string): string {
		return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
	}

	const styles = readSource("../src/client/styles.css");
	const ladder = readSource("../src/client/ladder.css");

	// The upstream reset zeroes margins and list markers; local-only surfaces keep their old browser-default look.
	describe("local-only surfaces keep their pre-reset spacing", () => {
		it.each([
			[".related-nodes-panel-hint, .related-nodes-panel-status, .related-nodes-panel-empty"],
			[".related-nodes-panel-error"],
		])("%s has the paragraph margin", (selector) => {
			expect(cssBlock(styles, selector).margin).toBe("1em 0");
		});

		it("gives the ladder tree dialog paragraphs, lists and nested lists their old spacing", () => {
			expect(cssBlock(ladder, ".ladder-tree-empty").margin).toBe("1em 0");
			expect(cssBlock(ladder, ":where(.ladder-tree-body) p")).toStrictEqual({margin: "1em 0"});
			expect(cssBlock(ladder, ".ladder-tree-body ul")).toStrictEqual({
				margin: "1em 0",
				"padding-left": "22px",
				"list-style": "disc",
			});
			expect(cssBlock(ladder, ".ladder-tree-body li > ul")).toStrictEqual({margin: "0", "list-style": "circle"});
		});
	});
});
