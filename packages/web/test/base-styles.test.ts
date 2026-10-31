import {describe, expect, it} from "vite-plus/test";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {cssBlock, cssPreludes, hasSelector} from "./helpers/css-block.js";
import {FONT_OPTIONS} from "../src/client/font-apply.js";

function readSource(relative: string): string {
	return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

const styles = readSource("../src/client/styles.css");
const indexHtml = readSource("../src/client/index.html");
const fonts = readSource("../src/client/fonts.css");

const SYSTEM_FONT_STACK =
	'-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif, var(--emoji-font, "Apple Color Emoji"), "Segoe UI Emoji", "Segoe UI Symbol"';

const CHROME_LINKS = ".wf-header a, .leftBar a, .wf-menu a, .wf-helper a";
const CHROME_LINKS_HOVER = ".wf-header a:hover, .leftBar a:hover, .wf-menu a:hover, .wf-helper a:hover";

function stripComments(css: string): string {
	return css.replaceAll(/\/\*[\s\S]*?\*\//gu, "");
}

describe("upstream base styles", () => {
	it("uses upstream's system font stack on body and --wf-font-family", () => {
		expect(cssBlock(styles, "body")["font-family"]).toBe(SYSTEM_FONT_STACK);
		expect(cssBlock(styles, ":root")["--wf-font-family"]).toBe(
			SYSTEM_FONT_STACK.replace("var(--emoji-font, ", "").replace('"Apple Color Emoji")', '"Apple Color Emoji"'),
		);
	});

	it("paints body from the semantic tokens", () => {
		const body = cssBlock(styles, "body");
		expect({color: body.color, background: body.background}).toStrictEqual({
			color: "var(--wf-text-primary)",
			background: "var(--wf-background-primary)",
		});
		expect(body["background-color"]).toBeUndefined();
	});

	it("ports design.css's input color and time-picker rules", () => {
		expect(cssBlock(styles, "input")).toStrictEqual({color: "var(--wf-text-primary)"});
		expect(cssBlock(styles, 'input[type="time"]::-webkit-calendar-picker-indicator')).toStrictEqual({
			background: "none",
			display: "none",
		});
	});

	it("leaves body line-height to the reset (1)", () => {
		expect(cssBlock(styles, "body")["line-height"]).toBeUndefined();
	});

	it("defines the font-custom variable scope verbatim", () => {
		expect(cssBlock(styles, ".font-system .font-custom, .font-default .font-custom")).toStrictEqual({
			"--font-default-line-height": "24px",
			"--font-descendant-padding-top": "4px",
			"--expand-collapse--top": "6px",
			"--bullet--top": "7px",
			"--item-menu--top": "4px",
			"--item-menu-root--top": "7px",
			"--font-ui-font-size": "13px",
			"--font-default-font-size": "16px",
			"--font-descendant-note-font-size": "13px",
			"--font-selected-name-font-size": "27px",
			"--font-selected-name-line-height": "34px",
			"--font-minimal-document-height": "27px",
			"--font-help-text-font-size": "12px",
		});
	});

	it("resets anchors inside chrome only", () => {
		expect(cssBlock(styles, CHROME_LINKS)).toStrictEqual({
			"text-decoration": "none",
			color: "inherit",
			cursor: "pointer",
		});
		expect(cssBlock(styles, CHROME_LINKS_HOVER)).toStrictEqual({"text-decoration": "underline"});
	});

	it("ports FontAwesome svg-core sizing", () => {
		expect(cssBlock(styles, ".svg-inline--fa")).toStrictEqual({
			display: "inline-block",
			height: "1em",
			overflow: "visible",
			"vertical-align": "-0.125em",
		});
		expect(cssBlock(styles, ".fa-1x")).toStrictEqual({"font-size": "1em"});
		expect(cssBlock(styles, ".fa-lg")).toStrictEqual({
			"font-size": "1.25em",
			"line-height": "0.05em",
			"vertical-align": "-0.075em",
		});
		expect(cssBlock(styles, ".fa-xs")).toStrictEqual({
			"font-size": "0.75em",
			"line-height": "0.0833333337em",
			"vertical-align": "0.125em",
		});
		expect(cssBlock(styles, ".fa-sm")).toStrictEqual({
			"font-size": "0.875em",
			"line-height": "0.0714285718em",
			"vertical-align": "0.0535714295em",
		});
		expect(cssBlock(styles, ".svg-inline--fa.fa-lg")).toStrictEqual({"vertical-align": "-0.2em"});
		expect(cssBlock(styles, ".svg-inline--fa.fa-xs")).toStrictEqual({"vertical-align": "0"});
		expect(cssBlock(styles, ".svg-inline--fa.fa-sm")).toStrictEqual({"vertical-align": "-0.0714285705em"});
		expect(cssBlock(styles, ".fa-fw")).toStrictEqual({"text-align": "center", width: "1.25em"});
		expect(cssBlock(styles, ".svg-inline--fa.fa-fw")).toStrictEqual({width: "1.25em"});
	});

	it("ports upstream .button", () => {
		expect(cssBlock(styles, ".button")).toStrictEqual({
			display: "inline-block",
			position: "relative",
			"-webkit-appearance": "none",
			appearance: "none",
			border: "none",
			outline: "none",
			"box-sizing": "border-box",
			"border-radius": "var(--wf-radius-pill)",
			padding: "var(--wf-space-s) var(--wf-space-l)",
			"font-weight": "var(--wf-font-weight-regular)",
			"line-height": "var(--wf-line-height-s)",
			"font-family": "inherit",
			"font-size": "var(--wf-font-size-s)",
			background: "var(--wf-background-tertiary)",
			"text-align": "center",
			"text-decoration": "none",
			color: "var(--wf-text-primary)",
			cursor: "pointer",
			"-webkit-tap-highlight-color": "transparent",
		});
		expect(cssBlock(styles, ".button:focus, .button:hover, .button:active")).toStrictEqual({
			"text-decoration": "none",
			"background-color": "color-mix(in srgb, var(--wf-background-quaternary) 85%, black)",
		});
	});

	it("does not add a bare button rule", () => {
		// A selector that starts with `button` would restyle every local <button>; descendants like `.x button` are fine.
		expect(/(^|[{},;])\s*button\s*[,{:]/u.test(stripComments(styles))).toBe(false);
	});

	it("ports upstream scrollbar styling", () => {
		expect(cssBlock(styles, "::-webkit-scrollbar")).toStrictEqual({width: "7px", height: "7px"});
		expect(cssBlock(styles, "::-webkit-scrollbar-track")).toStrictEqual({"background-color": "unset"});
		expect(cssBlock(styles, "::-webkit-scrollbar-thumb")).toStrictEqual({
			"background-color": "color-mix(in srgb, currentColor 20%, transparent)",
			"border-radius": "4px",
		});
		expect(cssBlock(styles, "::-webkit-scrollbar-thumb:hover")).toStrictEqual({
			"background-color": "color-mix(in srgb, currentColor 30%, transparent)",
		});
	});

	it("ports upstream .content word-break so long URLs wrap", () => {
		expect(cssBlock(styles, ".content")).toStrictEqual({
			"word-break": "break-word",
			position: "relative",
			"-webkit-user-select": "text",
			"user-select": "text",
			"min-width": "0",
		});
	});

	it("styles content links with upstream's .contentLink cursor and underline, leaving color to the injected sheet", () => {
		expect(cssBlock(styles, ".contentLink")).toStrictEqual({
			cursor: "pointer",
			"text-decoration": "underline",
		});
		expect(hasSelector(styles, /\.content a\b/u)).toBe(false);
	});

	it("prints content links blue and underlined (LID5)", () => {
		expect(styles).toContain(
			"@media print {\n\t.contentLink {\n\t\tcolor: #00f;\n\t\ttext-decoration: underline;\n\t}\n}",
		);
	});

	it("tints a tapped content link like upstream (LID4)", () => {
		expect(cssBlock(styles, ".contentLink.tapped")).toStrictEqual({background: "var(--wf-background-tertiary)"});
	});

	it("marks the body as a desktop system-font page", () => {
		expect(indexHtml).toContain('<body class="is-desktop font-system">');
	});
});

describe("upstream button variants and duotone icons", () => {
	it("styles .button.primary / .button.secondary like upstream's .primary / .secondary", () => {
		expect({
			primary: cssBlock(styles, ".button.primary"),
			primaryHover: cssBlock(styles, ".button.primary:focus, .button.primary:hover, .button.primary:active"),
			secondary: cssBlock(styles, ".button.secondary"),
			secondaryHover: cssBlock(
				styles,
				".button.secondary:focus, .button.secondary:hover, .button.secondary:active",
			),
		}).toStrictEqual({
			primary: {background: "var(--wf-background-tint)", color: "var(--wf-text-on-color)"},
			primaryHover: {"background-color": "color-mix(in srgb, var(--wf-background-tint) 85%, black)"},
			secondary: {background: "transparent", color: "var(--gray-3)"},
			secondaryHover: {"background-color": "color-mix(in srgb, var(--wf-background-quaternary) 85%, black)"},
		});
	});

	it("colors duotone layers from FontAwesome's custom properties", () => {
		expect({
			primary: cssBlock(styles, ".svg-inline--fa .fa-primary"),
			secondary: cssBlock(styles, ".svg-inline--fa .fa-secondary"),
		}).toStrictEqual({
			primary: {fill: "var(--fa-primary-color, currentColor)", opacity: "var(--fa-primary-opacity, 1)"},
			secondary: {fill: "var(--fa-secondary-color, currentColor)", opacity: "var(--fa-secondary-opacity, 0.4)"},
		});
	});

	it("styles inline code with upstream's global code rule", () => {
		expect(cssBlock(styles, "code")).toStrictEqual({
			padding: "0 var(--wf-space-s)",
			background: "var(--wf-background-secondary)",
			border: "var(--wf-border-width-s) solid var(--wf-border-primary)",
			"border-radius": "var(--wf-radius-s)",
			"font-family": "var(--font-code-font-family, var(--wf-font-family-mono))",
			"line-height": "var(--wf-line-height-s)",
			"font-size": "var(--font-code-block-font-size, 95%) !important",
		});
		expect(cssBlock(styles, ".font-andale code")).toStrictEqual({padding: "0", "font-size": "100%"});
		expect(hasSelector(styles, /^\s*\.innerContentContainer code\s*$/u)).toBe(false);
	});

	it("keeps other code rules from setting absolute code sizes", () => {
		const allowed = new Set(["code", ".addedToSelection code", ".font-andale code"]);
		const offenders = cssPreludes(stripComments(styles))
			.map((prelude) => prelude.replace(/^[\s}]*/u, "").trim())
			.filter((prelude) => prelude.endsWith("code") && !allowed.has(prelude));
		expect(offenders).toStrictEqual([]);
	});
});

describe("fonts.css", () => {
	it("scopes every non-system font to font-custom rows", () => {
		const preludes = new Set(cssPreludes(stripComments(fonts)).map((prelude) => prelude.trim()));
		const missing = FONT_OPTIONS.filter(
			([name]) => name !== "system" && !preludes.has(`.font-${name} .font-custom`),
		);
		expect(missing).toStrictEqual([]);
	});

	it("ports upstream's ET Book rule verbatim", () => {
		expect(cssBlock(fonts, ".font-etBook .font-custom")).toStrictEqual({
			"font-family":
				'ET Book, serif, var(--emoji-font, "Apple Color Emoji"), "Segoe UI Emoji", "Segoe UI Symbol"',
			"font-weight": "normal",
			"--font-default-line-height": "26px",
			"--font-descendant-padding-top": "4px",
			"--expand-collapse--top": "6px",
			"--bullet--top": "7px",
			"--item-menu--top": "4px",
			"--item-menu-root--top": "7px",
			"--font-ui-font-size": "13px",
			"--font-default-font-size": "18px",
			"--font-descendant-note-font-size": "15px",
			"--font-selected-name-font-size": "27px",
			"--font-selected-name-line-height": "34px",
			"--font-minimal-document-height": "23px",
			"--font-help-text-font-size": "12px",
			"--font-code-block-font-size": "15px",
		});
	});
});
