// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {applyTheme, clearPrepaintBackground, storedTheme} from "../src/client/theme-apply.js";
import {fileURLToPath} from "node:url";
import {themeFromAccount} from "../src/client/hooks/use-right-bar-sync.js";
import {cssBlock} from "./helpers/css-block.js";

describe("theme apply", () => {
	const html = readFileSync(join(import.meta.dirname, "../src/client/index.html"), "utf8");

	function stubColors(): void {
		vi.spyOn(globalThis, "getComputedStyle").mockReturnValue({
			getPropertyValue: (name: string) => (name === "--wf-background-primary" ? " #2a3135 " : " #5c6062 "),
		} as CSSStyleDeclaration);
	}

	beforeEach(() => {
		document.body.className = "is-desktop font-system _theme-space";
		document.body.removeAttribute("style");
		localStorage.clear();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("applyTheme", () => {
		it("swaps the body theme class, appends it last, and records the loading colors", () => {
			stubColors();
			const effective = applyTheme("wood", false);
			expect({
				effective,
				className: document.body.className,
				cookie: localStorage.getItem("wire_theme_current"),
				background: localStorage.getItem("loadingBackground"),
				foreground: localStorage.getItem("loadingForeground"),
				dataTheme: document.documentElement.dataset.theme,
			}).toStrictEqual({
				effective: "wood",
				className: "is-desktop font-system _theme-wood",
				cookie: "wood",
				background: "#2a3135",
				foreground: "#5c6062",
				dataTheme: "light",
			});
		});

		it("strips every theme class wherever it sits and keeps single spaces", () => {
			document.body.className = "is-desktop _theme-foo font-system";
			applyTheme("dark", false);
			expect(document.body.className).toBe("is-desktop font-system _theme-dark");
		});

		it("resolves system from the OS preference and falls back to default for unknown names", () => {
			const results = [applyTheme("system", true), applyTheme("system", false), applyTheme("bogus", true)];
			expect({results, className: document.body.className}).toStrictEqual({
				results: ["dark", "default", "default"],
				className: "is-desktop font-system _theme-default",
			});
		});

		it("marks the document dark for dark themes", () => {
			applyTheme("space", false);
			expect(document.documentElement.dataset.theme).toBe("dark");
		});
	});

	describe("clearPrepaintBackground", () => {
		it("removes the inline pre-paint background", () => {
			document.body.style.background = "#2a3135";
			applyTheme("dark", true);
			clearPrepaintBackground();
			expect(document.body.style.background).toBe("");
		});
	});

	describe("storedTheme", () => {
		it("migrates light to default and keeps registered names", () => {
			expect(["light", "dark", "system", "hacker", "bogus", null].map((raw) => storedTheme(raw))).toStrictEqual([
				"default",
				"dark",
				"system",
				"hacker",
				"system",
				"system",
			]);
		});
	});

	/** Run the inline script; happy-dom does not execute script elements. */
	function runScript(script: string): void {
		// oxlint-disable-next-line no-implied-eval
		new Function(script)();
	}

	describe("index.html pre-paint script", () => {
		const script = /<body[^>]*>\s*<script>([\s\S]*?)<\/script>/u.exec(html)?.[1] ?? "";

		it("is the first body script and names the stored keys", () => {
			expect(
				["loadingBackground", "loadingForeground", "wire_theme_current"].map((key) => script.includes(key)),
			).toStrictEqual([true, true, true]);
		});

		it("adds the stored theme class and the stored background", () => {
			localStorage.setItem("wire_theme_current", "dark");
			localStorage.setItem("loadingBackground", "#2a3135");
			localStorage.setItem("loadingForeground", "#5c6062");
			document.body.className = "is-desktop font-system";
			runScript(script);
			expect({className: document.body.className, background: document.body.style.background}).toStrictEqual({
				className: "is-desktop font-system _theme-dark",
				background: "#2a3135",
			});
		});

		it("resolves the OS preference on a first visit", () => {
			document.body.className = "is-desktop font-system";
			vi.stubGlobal("matchMedia", () => ({matches: true}));
			runScript(script);
			expect(document.body.className).toBe("is-desktop font-system _theme-dark");
			vi.unstubAllGlobals();
		});
	});
});

describe("theme following", () => {
	function read(path: string): string {
		return readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
	}

	const ladder = read("../src/client/ladder.css");
	const styles = read("../src/client/styles.css");

	describe("account theme adoption", () => {
		it("adopts any registered account theme and ignores unknown or missing ones", () => {
			expect(
				["space", "default", "system", "one_dark", "bogus", null].map((name) => themeFromAccount(name)),
			).toStrictEqual(["space", "default", "system", "one_dark", null, null]);
		});
	});

	describe("ladder palette", () => {
		it("follows the chosen theme rather than the OS colour scheme", () => {
			expect({
				mediaQuery: ladder.includes("prefers-color-scheme"),
				darkPaper: cssBlock(ladder, ':root[data-theme="dark"] .ladder-page')["--paper"],
			}).toStrictEqual({mediaQuery: false, darkPaper: "#12171a"});
		});
	});

	describe("dead theme selector css", () => {
		it("is gone, with the old settings theme buttons", () => {
			expect([styles.includes(".theme-selector"), styles.includes(".settings-theme-button")]).toStrictEqual([
				false,
				false,
			]);
		});
	});
});
