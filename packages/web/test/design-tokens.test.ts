import {describe, expect, it} from "vite-plus/test";
import {readdirSync, readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {cssBlock, cssBlockText} from "./helpers/css-block.js";

const styles = readFileSync(fileURLToPath(new URL("../src/client/styles.css", import.meta.url)), "utf8");

// Values copied verbatim from upstream themes_design / themes_default / themes_dark (2026-10-01 dumps);
// hex case and rgba() spacing follow the formatter, which normalises both in styles.css.
const PALETTE: Record<string, string> =
{
	"--wf-red-300": "#fdcacf",
	"--wf-red-500": "#f74e5d",
	"--wf-red-700": "#de4854",
	"--wf-red-800": "#cd5c5c",
	"--wf-blue-200": "#c1e1f2",
	"--wf-blue-300": "#49baf2",
	"--wf-blue-400": "#4baddf",
	"--wf-blue-500": "#3a97c5",
	"--wf-dark-blue-100": "#006699",
	"--wf-dark-blue-300": "#336677",
	"--wf-dark-blue-400": "#3c88af",
	"--wf-dark-blue-500": "#18475f",
	"--wf-green-300": "#d5f3e5",
	"--wf-green-500": "#72d7a7",
	"--wf-green-700": "#6ace9f",
	"--wf-yellow-100": "#ffff99",
	"--wf-yellow-200": "#f8c476",
	"--wf-yellow-300": "#df9f2e",
	"--wf-yellow-700": "#7c623b",
	"--wf-dark-gray-100": "#ffffff",
	"--wf-dark-gray-200": "#d9dbdb",
	"--wf-dark-gray-300": "#9ea1a2",
	"--wf-dark-gray-400": "#7c7f81",
	"--wf-dark-gray-500": "#5c6062",
	"--wf-dark-gray-600": "#42484b",
	"--wf-dark-gray-700": "#353c3f",
	"--wf-dark-gray-800": "#2a3135",
	"--wf-white-opaque-10": "rgba(255, 255, 255, 0.1)",
	"--wf-white-opaque-20": "rgba(255, 255, 255, 0.2)",
	"--wf-black-opaque-5": "rgba(0, 0, 0, 0.05)",
	"--wf-black-opaque-20": "rgba(0, 0, 0, 0.2)",
	"--wf-black-opaque-30": "rgba(0, 0, 0, 0.3)",
	"--wf-black-opaque-60": "rgba(0, 0, 0, 0.6)",
	"--wf-black-opaque-70": "rgba(0, 0, 0, 0.7)",
	"--wf-drop-line-z-index": "400",
	"--safe-area-inset-top": "env(safe-area-inset-top, 0px)",
	"--safe-area-inset-right": "env(safe-area-inset-right, 0px)",
	"--safe-area-inset-bottom": "env(safe-area-inset-bottom, 0px)",
	"--safe-area-inset-left": "env(safe-area-inset-left, 0px)",
};

const LIGHT_SEMANTIC: Record<string, string> =
{
	"--wf-background-primary": "var(--wf-gray-0)",
	"--wf-background-secondary": "var(--wf-gray-100)",
	"--wf-background-tertiary": "var(--wf-gray-300)",
	"--wf-background-quaternary": "var(--wf-gray-300)",
	"--wf-background-tint": "var(--wf-blue-300)",
	"--wf-background-danger": "var(--wf-red-500)",
	"--wf-background-warning": "var(--wf-yellow-200)",
	"--wf-background-success": "var(--wf-green-700)",
	"--wf-background-info": "var(--wf-blue-200)",
	"--wf-background-selected": "var(--wf-blue-200)",
	"--wf-background-shared": "var(--wf-blue-200)",
	"--wf-background-found": "var(--wf-yellow-100)",
	"--wf-background-ambient": "var(--wf-gray-0)",
	"--wf-background-mentioned": "#eefaff",
	"--wf-background-added": "#bcf0db",
	"--wf-background-moved": "#dcd7fe",
	"--wf-background-completed": "#e2e8f0",
	"--wf-background-edited": "#fef6bc",
	"--wf-background-red": "#fbd5d5",
	"--wf-background-orange": "#fcd9bd",
	"--wf-background-yellow": "#fce96a",
	"--wf-background-green": "#bcf0da",
	"--wf-background-blue": "#c3ddfd",
	"--wf-background-purple": "#dcd7fe",
	"--wf-background-gray": "#e2e8f0",
	"--wf-background-teal": "#bcf0f0",
	"--wf-background-sky": "#bae6fd",
	"--wf-background-pink": "#fbd7fe",
	"--wf-text-primary": "var(--wf-gray-800)",
	"--wf-text-secondary": "var(--wf-gray-700)",
	"--wf-text-tertiary": "var(--wf-gray-500)",
	"--wf-text-quaternary": "var(--wf-gray-700)",
	"--wf-text-quinary": "var(--wf-gray-300)",
	"--wf-text-on-color": "var(--wf-gray-0)",
	"--wf-text-tint": "var(--wf-blue-300)",
	"--wf-text-success": "var(--wf-green-700)",
	"--wf-text-danger": "var(--wf-red-500)",
	"--wf-text-warning": "var(--wf-yellow-200)",
	"--wf-text-spark": "var(--wf-yellow-200)",
	"--wf-text-mentioned": "#38bdf8",
	"--wf-text-added": "#31c48d",
	"--wf-text-moved": "#ac94fa",
	"--wf-text-completed": "#97a6ba",
	"--wf-text-edited": "#e3a008",
	"--wf-text-red": "#e02424",
	"--wf-text-orange": "#d03801",
	"--wf-text-yellow": "#9f580a",
	"--wf-text-green": "#057a55",
	"--wf-text-blue": "#1c64f2",
	"--wf-text-purple": "#7e3af2",
	"--wf-text-gray": "#64748b",
	"--wf-text-teal": "#108190",
	"--wf-text-sky": "#007ab8",
	"--wf-text-pink": "#d60bc1",
	"--wf-border-primary": "var(--wf-gray-300)",
	"--wf-border-secondary": "var(--wf-gray-200)",
	"--wf-border-tint": "var(--wf-blue-300)",
	"--wf-border-danger": "var(--wf-red-500)",
	"--wf-border-warning": "var(--wf-yellow-200)",
	"--wf-border-success": "var(--wf-green-700)",
};

const DARK_SEMANTIC: Record<string, string> =
{
	"--wf-background-primary": "var(--wf-dark-gray-800)",
	"--wf-background-secondary": "var(--wf-dark-gray-700)",
	"--wf-background-tertiary": "var(--wf-dark-gray-500)",
	"--wf-background-quaternary": "var(--wf-dark-gray-600)",
	"--wf-background-tint": "var(--wf-dark-blue-400)",
	"--wf-background-danger": "var(--wf-red-500)",
	"--wf-background-warning": "var(--wf-yellow-200)",
	"--wf-background-success": "var(--wf-green-700)",
	"--wf-background-info": "var(--wf-dark-blue-300)",
	"--wf-background-selected": "var(--wf-dark-blue-300)",
	"--wf-background-shared": "var(--wf-dark-blue-300)",
	"--wf-background-found": "var(--wf-dark-blue-100)",
	"--wf-background-ambient": "var(--wf-dark-gray-800)",
	"--wf-background-mentioned": "#28424d",
	"--wf-background-added": "#2e6046",
	"--wf-background-moved": "#584080",
	"--wf-background-completed": "#475569",
	"--wf-background-edited": "#534b2f",
	"--wf-background-red": "#773b3b",
	"--wf-background-orange": "#784c3c",
	"--wf-background-yellow": "#8c7146",
	"--wf-background-green": "#40806b",
	"--wf-background-blue": "#405580",
	"--wf-background-purple": "#584080",
	"--wf-background-gray": "#475569",
	"--wf-background-teal": "#397886",
	"--wf-background-sky": "#496b92",
	"--wf-background-pink": "#7f4080",
	"--wf-text-primary": "var(--wf-dark-gray-100)",
	"--wf-text-secondary": "var(--wf-dark-gray-200)",
	"--wf-text-tertiary": "var(--wf-dark-gray-300)",
	"--wf-text-quaternary": "var(--wf-dark-gray-200)",
	"--wf-text-quinary": "var(--wf-dark-gray-500)",
	"--wf-text-on-color": "var(--wf-dark-gray-100)",
	"--wf-text-tint": "var(--wf-dark-blue-400)",
	"--wf-text-success": "var(--wf-green-700)",
	"--wf-text-danger": "var(--wf-red-500)",
	"--wf-text-warning": "var(--wf-yellow-200)",
	"--wf-text-spark": "var(--wf-yellow-200)",
	"--wf-text-mentioned": "#007ab8",
	"--wf-text-added": "#057a55",
	"--wf-text-moved": "#9f580a",
	"--wf-text-completed": "#64748b",
	"--wf-text-edited": "#9f580a",
	"--wf-text-red": "#f98080",
	"--wf-text-orange": "#ff8a4c",
	"--wf-text-yellow": "#e3a008",
	"--wf-text-green": "#31c48d",
	"--wf-text-blue": "#76a9fa",
	"--wf-text-purple": "#ac94fa",
	"--wf-text-gray": "#97a6ba",
	"--wf-text-teal": "#2dd4bf",
	"--wf-text-sky": "#38bdf8",
	"--wf-text-pink": "#f472b6",
	"--wf-border-primary": "var(--wf-dark-gray-500)",
	"--wf-border-secondary": "var(--wf-dark-gray-600)",
	"--wf-border-tint": "var(--wf-dark-blue-400)",
	"--wf-border-danger": "var(--wf-red-500)",
	"--wf-border-warning": "var(--wf-yellow-200)",
	"--wf-border-success": "var(--wf-green-700)",
};

// Every --wf-* name declared by upstream across all sheets and themes (dumps/design-tokens-upstream-dark.json).
const UPSTREAM_WF_NAMES = [
	"--wf-ai-background",
	"--wf-ai-beta-tag-color",
	"--wf-background-added",
	"--wf-background-ambient",
	"--wf-background-blue",
	"--wf-background-completed",
	"--wf-background-danger",
	"--wf-background-edited",
	"--wf-background-found",
	"--wf-background-gray",
	"--wf-background-green",
	"--wf-background-info",
	"--wf-background-mentioned",
	"--wf-background-moved",
	"--wf-background-orange",
	"--wf-background-pink",
	"--wf-background-primary",
	"--wf-background-purple",
	"--wf-background-quaternary",
	"--wf-background-red",
	"--wf-background-secondary",
	"--wf-background-selected",
	"--wf-background-shared",
	"--wf-background-sky",
	"--wf-background-success",
	"--wf-background-teal",
	"--wf-background-tertiary",
	"--wf-background-tint",
	"--wf-background-warning",
	"--wf-background-yellow",
	"--wf-black-opaque-20",
	"--wf-black-opaque-30",
	"--wf-black-opaque-5",
	"--wf-black-opaque-60",
	"--wf-black-opaque-70",
	"--wf-blue-200",
	"--wf-blue-300",
	"--wf-blue-400",
	"--wf-blue-500",
	"--wf-border-ambient",
	"--wf-border-danger",
	"--wf-border-primary",
	"--wf-border-secondary",
	"--wf-border-subtle",
	"--wf-border-success",
	"--wf-border-tint",
	"--wf-border-warning",
	"--wf-border-width-l",
	"--wf-border-width-m",
	"--wf-border-width-ms",
	"--wf-border-width-s",
	"--wf-box-shadow-m",
	"--wf-button-background-danger-active",
	"--wf-content-padding-bottom",
	"--wf-content-padding-top",
	"--wf-dark-blue-100",
	"--wf-dark-blue-300",
	"--wf-dark-blue-400",
	"--wf-dark-blue-500",
	"--wf-dark-gray-100",
	"--wf-dark-gray-200",
	"--wf-dark-gray-300",
	"--wf-dark-gray-400",
	"--wf-dark-gray-500",
	"--wf-dark-gray-600",
	"--wf-dark-gray-700",
	"--wf-dark-gray-800",
	"--wf-drop-line-z-index",
	"--wf-font-family",
	"--wf-font-family-brand",
	"--wf-font-family-mono",
	"--wf-font-size-2xl",
	"--wf-font-size-3xl",
	"--wf-font-size-4xl",
	"--wf-font-size-base",
	"--wf-font-size-l",
	"--wf-font-size-m",
	"--wf-font-size-s",
	"--wf-font-size-xl",
	"--wf-font-size-xs",
	"--wf-font-weight-bold",
	"--wf-font-weight-light",
	"--wf-font-weight-regular",
	"--wf-font-weight-semibold",
	"--wf-gray-0",
	"--wf-gray-100",
	"--wf-gray-200",
	"--wf-gray-300",
	"--wf-gray-400",
	"--wf-gray-500",
	"--wf-gray-700",
	"--wf-gray-800",
	"--wf-gray-900",
	"--wf-green-300",
	"--wf-green-500",
	"--wf-green-700",
	"--wf-header-height",
	"--wf-image-ambient",
	"--wf-item-line-height",
	"--wf-lime-green-100",
	"--wf-lime-green-200",
	"--wf-lime-green-300",
	"--wf-lime-green-400",
	"--wf-lime-green-500",
	"--wf-lime-green-600",
	"--wf-lime-green-700",
	"--wf-lime-green-800",
	"--wf-line-height-base",
	"--wf-line-height-s",
	"--wf-radius-circle",
	"--wf-radius-l",
	"--wf-radius-m",
	"--wf-radius-pill",
	"--wf-radius-s",
	"--wf-radius-xs",
	"--wf-red-300",
	"--wf-red-500",
	"--wf-red-700",
	"--wf-red-800",
	"--wf-shadow-elevated",
	"--wf-space-2xl",
	"--wf-space-3xl",
	"--wf-space-4xl",
	"--wf-space-5xl",
	"--wf-space-6xl",
	"--wf-space-l",
	"--wf-space-m",
	"--wf-space-ml",
	"--wf-space-s",
	"--wf-space-xl",
	"--wf-space-xs",
	"--wf-text-added",
	"--wf-text-blue",
	"--wf-text-completed",
	"--wf-text-danger",
	"--wf-text-edited",
	"--wf-text-gray",
	"--wf-text-green",
	"--wf-text-mentioned",
	"--wf-text-moved",
	"--wf-text-on-color",
	"--wf-text-orange",
	"--wf-text-pink",
	"--wf-text-primary",
	"--wf-text-purple",
	"--wf-text-quaternary",
	"--wf-text-quinary",
	"--wf-text-red",
	"--wf-text-secondary",
	"--wf-text-sky",
	"--wf-text-spark",
	"--wf-text-success",
	"--wf-text-teal",
	"--wf-text-tertiary",
	"--wf-text-tint",
	"--wf-text-warning",
	"--wf-text-yellow",
	"--wf-white-opaque-10",
	"--wf-white-opaque-20",
	"--wf-yellow-100",
	"--wf-yellow-200",
	"--wf-yellow-300",
	"--wf-yellow-700",
];

// Names upstream references but never defines, on purpose; declaring them locally would paint what upstream does not.
const UPSTREAM_UNDEFINED = [
	"--wf-icon-primary",
	"--wf-icon-secondary",
	"--wf-menu-text",
	"--wf-border-tertiary",
	"--wf-header-text-primary",
	"--wf-radius-sm",
	"--wf-mobile-font-size-base",
	"--wf-animation-duration",
	"--wf-border-ambient",
	"--wf-image-ambient",
];

// Local-only --wf-* declarations, each with a written justification. Empty: local invents none.
const LOCAL_EXTRA: string[] = [];

const LEGACY_ALIASES: Record<string, string> =
{
	"--color-bg": "var(--wf-background-primary)",
	"--color-bg-secondary": "var(--wf-background-secondary)",
	"--color-bg-hover": "var(--wf-background-secondary)",
	"--color-bg-selected": "var(--wf-background-selected)",
	"--color-bg-overlay": "var(--wf-black-opaque-60)",
	"--color-text": "var(--wf-text-primary)",
	"--color-text-secondary": "var(--wf-text-secondary)",
	"--color-text-muted": "var(--wf-text-tertiary)",
	"--color-text-faint": "var(--wf-text-tertiary)",
	"--color-text-placeholder": "var(--wf-text-quinary)",
	"--color-border": "var(--wf-border-secondary)",
	"--color-border-light": "var(--wf-border-primary)",
	"--color-border-focus": "var(--wf-border-tint)",
	"--color-accent": "var(--wf-text-tint)",
	"--color-accent-hover": "var(--wf-blue-400)",
	"--color-accent-bg": "var(--wf-background-selected)",
	"--color-error": "var(--wf-text-danger)",
	"--color-warning": "var(--wf-text-warning)",
	"--color-success": "var(--wf-text-success)",
	"--color-icon": "var(--wf-text-tertiary)",
};

function sourceFiles(directory: string): string[]
{
	return readdirSync(
		directory,
		{
			withFileTypes: true,
		},
	).flatMap((entry) =>
	{
		const full = `${directory}/${entry.name}`;
		if (entry.isDirectory())
		{
			return sourceFiles(full);
		}
		return /\.(tsx?|css)$/u.test(entry.name) && !entry.name.startsWith("wf-tailwind") ? [full] : [];
	});
}

function declaredNames(css: string, prefix: string): string[]
{
	const stripped = css.replaceAll(/\/\*[\s\S]*?\*\//gu, "");
	return [...new Set([...stripped.matchAll(new RegExp(`(${prefix}[\\w-]+)\\s*:`, "gu"))].map((match) => match[1]))];
}

function pick(block: Record<string, string>, keys: string[]): Record<string, string>
{
	return Object.fromEntries(keys.filter((key) => key in block).map((key) => [key, block[key]]));
}

describe("design tokens", () =>
{
	it("defines the upstream palette on :root", () =>
	{
		expect(pick(cssBlock(styles, ":root"), Object.keys(PALETTE))).toStrictEqual(PALETTE);
	});

	it("defines the light semantic tokens under the body class ._theme-default", () =>
	{
		expect(pick(cssBlock(styles, "._theme-default"), Object.keys(LIGHT_SEMANTIC))).toStrictEqual(LIGHT_SEMANTIC);
	});

	it("defines the dark semantic tokens under the body class ._theme-dark", () =>
	{
		expect(pick(cssBlock(styles, "._theme-dark"), Object.keys(DARK_SEMANTIC))).toStrictEqual(DARK_SEMANTIC);
	});

	it("keeps semantic tokens and aliases off :root, like upstream's html", () =>
	{
		const root = cssBlock(styles, ":root");
		const offenders = Object.entries(root)
			.filter(
				([name, value]) =>
					/^--wf-(background|text)-/u.test(name) ||
					/^--wf-border-(primary|secondary|tint|danger|warning|success)$/u.test(name) ||
					name === "--wf-shadow-elevated" ||
					value.includes("var(--wf-"),
			)
			.map(([name]) => name);
		expect(offenders).toStrictEqual([]);
	});

	it("declares the elevated shadow on body", () =>
	{
		expect(cssBlock(styles, "body")["--wf-shadow-elevated"]).toBe(
			"0px 3px 3px -2px rgba(0, 0, 0, 0.2), 0px 3px 4px 0px rgba(0, 0, 0, 0.2), 0px 1px 8px 0px rgba(0, 0, 0, 0.2)",
		);
	});

	it("has no data-theme selector left", () =>
	{
		expect(styles).not.toContain("[data-theme");
		expect(styles).not.toContain(".dark ");
	});

	it("declares each semantic name once per theme block", () =>
	{
		expect(cssBlockText(styles, "._theme-default").match(/--wf-background-tertiary\s*:/gu)?.length).toBe(1);
	});

	it("adds the missing upstream tokens", () =>
	{
		expect(
			pick(cssBlock(styles, ":root"), [
				"--wf-lime-green-100",
				"--wf-lime-green-200",
				"--wf-lime-green-300",
				"--wf-lime-green-400",
				"--wf-lime-green-500",
				"--wf-lime-green-600",
				"--wf-lime-green-700",
				"--wf-lime-green-800",
				"--wf-ai-beta-tag-color",
				"--wf-content-padding-bottom",
			]),
		).toStrictEqual(
			{
				"--wf-lime-green-100": "#00ff00",
				"--wf-lime-green-200": "#00ee00",
				"--wf-lime-green-300": "#009900",
				"--wf-lime-green-400": "#006600",
				"--wf-lime-green-500": "#005500",
				"--wf-lime-green-600": "#003300",
				"--wf-lime-green-700": "#002200",
				"--wf-lime-green-800": "#000000",
				"--wf-ai-beta-tag-color": "#073751",
				"--wf-content-padding-bottom": "unset",
			},
		);
		expect(cssBlock(styles, "._theme-default")["--wf-ai-background"]).toBe(
			"linear-gradient(90deg, #edf9ff 7.9%, #fff2fd 99.15%)",
		);
		expect(cssBlock(styles, "._theme-dark")["--wf-ai-background"]).toBe("linear-gradient(90deg, #1f3540, #362a3c)");
		expect(cssBlock(styles, ".children, .draggableNameClone")).toStrictEqual(
			{
				"--wf-content-padding-top": "var(--font-descendant-padding-top)",
				"--wf-content-padding-bottom": "unset",
			},
		);
		expect(cssBlock(styles, ".name > .content")["--wf-item-line-height"]).toBe("var(--font-default-line-height)");
		expect(cssBlock(styles, ".name--main > .content")["--wf-item-line-height"]).toBe(
			"var(--font-selected-name-line-height)",
		);
	});

	it("declares only upstream --wf-* names", () =>
	{
		const allowed = new Set([...UPSTREAM_WF_NAMES, ...LOCAL_EXTRA]);
		expect(declaredNames(styles, "--wf-").filter((name) => !allowed.has(name))).toStrictEqual([]);
	});

	it("references only declared --wf-* tokens, or ones upstream leaves undefined", () =>
	{
		const declared = new Set(declaredNames(styles, "--wf-"));
		const allowed = new Set([...declared, ...UPSTREAM_UNDEFINED]);
		const sources = sourceFiles(fileURLToPath(new URL("../src/client", import.meta.url)));
		const unknown = sources.flatMap((file) =>
			[...readFileSync(file, "utf8").matchAll(/var\((--wf-[\w-]+)/gu)]
				.map((match) => match[1])
				.filter((name) => !name.endsWith("-") && !allowed.has(name))
				.map((name) => `${file.split("/src/client/")[1]}: ${name}`),
		);
		expect(unknown).toStrictEqual([]);
	});

	it("leaves the names upstream deliberately never defines undeclared", () =>
	{
		const declared = new Set(declaredNames(styles, "--wf-"));
		expect(UPSTREAM_UNDEFINED.filter((name) => declared.has(name))).toStrictEqual([]);
	});

	it("aliases the legacy --color-* layer to semantic tokens on body only", () =>
	{
		const body = cssBlock(styles, "body");
		expect(pick(body, Object.keys(LEGACY_ALIASES))).toStrictEqual(LEGACY_ALIASES);
		expect(new Set(declaredNames(styles, "--color-"))).toStrictEqual(new Set(Object.keys(LEGACY_ALIASES)));
		expect(declaredNames(styles, "--shadow-")).toStrictEqual(["--shadow-modal"]);
	});

	it("keeps the modal shadow per theme", () =>
	{
		expect([
			cssBlock(styles, "._theme-default")["--shadow-modal"],
			cssBlock(styles, "._theme-dark")["--shadow-modal"],
		]).toStrictEqual([
			"0 4px 24px rgba(0, 0, 0, 0.2), 0 0 0 1px rgba(0, 0, 0, 0.05)",
			"0 4px 24px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.1)",
		]);
	});

	it("matches upstream's --wf-font-family text", () =>
	{
		expect(cssBlock(styles, ":root")["--wf-font-family"]).toBe(
			'-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol"',
		);
	});

	it("reads --wf-text-secondary for bullets", () =>
	{
		expect(cssBlock(styles, ".bullet").color).toBe("var(--wf-text-secondary)");
	});

	it("ports the row-text selection color and the main name border color", () =>
	{
		expect(cssBlock(styles, ".content::selection, .content ::selection")).toStrictEqual(
			{
				"background-color": "#c1e1f2b3",
			},
		);
		expect(cssBlock(styles, ".name.name--main")["border-color"]).toBe("#aaa");
		expect(styles.indexOf(".content::selection,")).toBeLessThan(
			styles.indexOf(".notes > .content > .innerContentContainer::selection"),
		);
	});

	it.each([
		[
			"._theme-default .wf-header",
			{
				"--wf-background-primary": "var(--wf-gray-0)",
				"--wf-text-primary": "var(--wf-gray-500)",
				"--wf-border-primary": "var(--wf-gray-200)",
			},
		],
		[
			"._theme-default .wf-menu",
			{
				"--wf-text-primary": "var(--wf-gray-700)",
				"--wf-border-secondary": "var(--wf-gray-400)",
			},
		],
		[
			"._theme-default .wf-helper",
			{
				"--wf-background-primary": "var(--wf-gray-100)",
			},
		],
		[
			"._theme-dark .wf-header",
			{
				"--wf-text-primary": "var(--wf-dark-gray-300)",
				"--wf-border-primary": "var(--wf-dark-gray-600)",
			},
		],
		[
			"._theme-dark .wf-menu",
			{
				"--wf-text-primary": "var(--wf-dark-gray-200)",
				"--wf-border-primary": "var(--wf-dark-gray-600)",
				"--wf-border-secondary": "var(--wf-dark-gray-500)",
			},
		],
		[
			"._theme-dark .wf-helper",
			{
				"--wf-background-primary": "var(--wf-gray-700)",
			},
		],
		[
			".wf-menu, .wf-header, .wf-helper",
			{
				color: "var(--wf-text-primary)",
			},
		],
	])("scopes %s overrides like upstream", (selector, expected) =>
	{
		expect(cssBlock(styles, selector)).toStrictEqual(expected);
	});
});
