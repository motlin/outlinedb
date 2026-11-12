import {describe, expect, it} from "vite-plus/test";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {cssBlock} from "./helpers/css-block.js";

function readSource(relative: string): string
{
	return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

const tw = readSource("../src/client/wf-tailwind.css");

// Fingerprint of upstream css_tailwind.7d94a432a83c.css after its leading comment, minus DROPPED_RULE, with
// the trailing blank line trimmed. Pinned here so the check runs without the 141 kB upstream file checked in.
const UPSTREAM_BODY =
{
	length: 140_608,
	sha256: "99a74ff87917a8fb9ccc7b8de959f9043366dccda7a5457c92a8ffa4e3ad7f19",
};

// lightningcss cannot minify this rule (an unexpanded JS template literal upstream), so the port drops it.
const DROPPED_RULE = [
	String.raw`.bg-\[var\(--wf-background-\$\{backgroundColor\}\)\] {`,
	`  background-color: var(--wf-background-\${backgroundColor})`,
	"}",
	"",
	"",
].join("\n");

const TRANSFORM =
	"translate(var(--tw-translate-x), var(--tw-translate-y)) rotate(var(--tw-rotate)) skewX(var(--tw-skew-x)) skewY(var(--tw-skew-y)) scaleX(var(--tw-scale-x)) scaleY(var(--tw-scale-y))";

const SAMPLE_RULES: Record<string, Record<string, string>> =
{
	".ml-auto":
	{
		"margin-left": "auto",
	},
	".gap-xs":
	{
		gap: "0.25rem",
	},
	".gap-m":
	{
		gap: "0.5rem",
	},
	".border-l":
	{
		"border-left-width": "1px",
	},
	".border-b":
	{
		"border-bottom-width": "1px",
	},
	".border-solid":
	{
		"border-style": "solid",
	},
	".border-primary":
	{
		"border-color": "var(--wf-border-primary)",
	},
	".bg-primary":
	{
		"background-color": "var(--wf-background-primary)",
	},
	".bg-secondary":
	{
		"background-color": "var(--wf-background-secondary)",
	},
	".bg-tint":
	{
		"background-color": "var(--wf-background-tint)",
	},
	".mx-s":
	{
		"margin-left": "0.375rem",
		"margin-right": "0.375rem",
	},
	".self-stretch":
	{
		"align-self": "stretch",
	},
	".flex-shrink-0":
	{
		"flex-shrink": "0",
	},
	".text-xs":
	{
		"font-size": "0.79rem",
	},
	".text-s":
	{
		"font-size": "0.889rem",
	},
	".leading-base":
	{
		"line-height": "1.5",
	},
	".leading-s":
	{
		"line-height": "1.375",
	},
	".truncate":
	{
		overflow: "hidden",
		"text-overflow": "ellipsis",
		"white-space": "nowrap",
	},
	".opacity-70":
	{
		opacity: "0.7",
	},
	".w-l":
	{
		width: "1rem",
	},
	".top-xs":
	{
		top: "0.25rem",
	},
	".right-xs":
	{
		right: "0.25rem",
	},
	".rounded-circle":
	{
		"border-radius": "50%",
	},
	".rounded-m":
	{
		"border-radius": "0.5rem",
	},
	".pl-xl":
	{
		"padding-left": "1.5rem",
	},
	".pt-3xl":
	{
		"padding-top": "3rem",
	},
	".mt-ml":
	{
		"margin-top": "0.75rem",
	},
	".left-2xs":
	{
		left: "0.125rem",
	},
	".hidden":
	{
		display: "none",
	},
	".text-spark":
	{
		color: "var(--wf-text-spark)",
	},
	".\\!text-spark":
	{
		color: "var(--wf-text-spark) !important",
	},
	".hover\\:\\!bg-quaternary:hover":
	{
		"background-color": "var(--wf-background-quaternary) !important",
	},
	".group:hover .group-hover\\:opacity-100":
	{
		opacity: "1",
	},
	".expanded .\\[\\.expanded_\\&\\]\\:rotate-90":
	{
		"--tw-rotate": "90deg",
		transform: TRANSFORM,
	},
	".is-desktop .desktop\\:mt-m":
	{
		"margin-top": "0.5rem",
	},
	".shadow-md":
	{
		"--tw-shadow": "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)",
		"--tw-shadow-colored": "0 4px 6px -1px var(--tw-shadow-color), 0 2px 4px -2px var(--tw-shadow-color)",
		"box-shadow": "var(--tw-ring-offset-shadow, 0 0 #0000), var(--tw-ring-shadow, 0 0 #0000), var(--tw-shadow)",
	},
	".sm\\:flex":
	{
		display: "flex",
	},
	".hover\\:bg-tint:hover":
	{
		"background-color": "var(--wf-background-tint)",
	},
	".min-h-\\[var\\(--wf-header-height\\)\\]":
	{
		"min-height": "var(--wf-header-height)",
	},
	// Still used by components/side-pane.tsx; upstream dropped them, so they live in a local appendix.
	".box-content":
	{
		"box-sizing": "content-box",
	},
	".min-w-\\[350px\\]":
	{
		"min-width": "350px",
	},
};

describe("wf-tailwind.css", () =>
{
	it.each(Object.entries(SAMPLE_RULES))("defines upstream rule %s", (selector, expected) =>
	{
		expect(cssBlock(tw, selector)).toStrictEqual(expected);
	});

	it("nests sm:flex inside the 640px media query", () =>
	{
		expect(tw).toMatch(/@media \(min-width: 640px\) \{[^@]*\n {2}\.sm\\:flex \{\n {4}display: flex\n {2}\}/u);
	});

	it("starts with the Tailwind v3 --tw-* variable defaults", () =>
	{
		expect(cssBlock(tw, "*, ::before, ::after, ::backdrop")).toStrictEqual(
			{
				"--tw-border-spacing-x": "0",
				"--tw-border-spacing-y": "0",
				"--tw-translate-x": "0",
				"--tw-translate-y": "0",
				"--tw-rotate": "0",
				"--tw-skew-x": "0",
				"--tw-skew-y": "0",
				"--tw-scale-x": "1",
				"--tw-scale-y": "1",
				"--tw-ring-inset": "",
				"--tw-ring-offset-width": "0px",
				"--tw-ring-offset-color": "#fff",
				"--tw-ring-color": "rgb(59 130 246 / 0.5)",
				"--tw-ring-offset-shadow": "0 0 #0000",
				"--tw-ring-shadow": "0 0 #0000",
				"--tw-shadow": "0 0 #0000",
				"--tw-shadow-colored": "0 0 #0000",
			},
		);
		expect(tw.indexOf("*, ::before, ::after, ::backdrop")).toBeLessThan(tw.indexOf(String.raw`.\!container`));
	});

	it("ends with the upstream file verbatim, minus its leading comment and the dropped rule", () =>
	{
		const tail = tw.slice(-UPSTREAM_BODY.length);
		expect(
			{
				start: tail.startsWith(`\n\n${String.raw`.\!container {`}`),
				dropped: tw.includes(DROPPED_RULE),
				sha256: createHash("sha256").update(tail).digest("hex"),
			},
		).toStrictEqual(
			{
				start: true,
				dropped: false,
				sha256: UPSTREAM_BODY.sha256,
			},
		);
	});
});

describe("tailwind wiring", () =>
{
	it("imports wf-tailwind.css before styles.css so local component rules win ties", () =>
	{
		const app = readSource("../src/client/app.tsx");
		const tailwindImport = app.indexOf('import "./wf-tailwind.css";');
		expect(tailwindImport).toBeGreaterThan(-1);
		expect(tailwindImport).toBeLessThan(app.indexOf('import "./styles.css";'));
	});

	it("marks the body as desktop so desktop: variants apply", () =>
	{
		expect(readSource("../src/client/index.html")).toContain('<body class="is-desktop');
	});
});
