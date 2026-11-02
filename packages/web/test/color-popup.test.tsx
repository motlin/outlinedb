// @vitest-environment happy-dom
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {createElement} from "react";
import type {ReactNode, ReactPortal} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {afterEach, beforeAll, describe, expect, it, vi} from "vite-plus/test";
import type {Root} from "react-dom/client";

vi.mock(import("react-dom"), async (importOriginal) => (
{
	...(await importOriginal()),
	createPortal: (node: ReactNode): ReactPortal => node as ReactPortal,
}));
vi.mock(import("../src/client/hooks/use-close-on-location-change.js"), () => (
{
	useCloseOnLocationChange: () =>
	{
	},
}));

declare global
{
	// React reads this to know act() wraps every update.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const {act} = await import("react");
const {createRoot} = await import("react-dom/client");
const {ColorPopup, popupCentered} = await import("../src/client/components/color-popup.js");

const DUMP = resolve(import.meta.dirname, "fixtures/upstream-color-popup-dom.html");

const noop = () =>
{
};

type ColorKind = "text" | "highlight";
type ColorName = string;

function markup(
	selected:
	{
		text?: "red";
		highlight?: "yellow";
	} = {},
): string
{
	return renderToStaticMarkup(
		createElement(
			ColorPopup,
			{
				left: 191.5,
				top: 296.5,
				selected,
				onSelect: noop,
				onClose: noop,
			},
		),
	);
}

function parsed(html: string): Document
{
	return new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
}

function rows(html: string):
{
	row: string;
	titles: string[];
	classes: string[];
}[]
{
	return [...parsed(html).querySelectorAll(".picker-text, .picker-background")].map((row) =>
	{
		const swatches = [...row.querySelectorAll("[title]")];
		return {
			row: row.className,
			titles: swatches.map((swatch) => swatch.getAttribute("title") ?? ""),
			classes: swatches.map((swatch) => swatch.className.split(/\s+/u).at(-1) ?? ""),
		};
	});
}

describe("ColorPopup markup", () =>
{
	it("renders a Text row and a Highlight row of 11 swatches in display order", () =>
	{
		const titles = [
			"remove color",
			"Red",
			"Orange",
			"Yellow",
			"Green",
			"Teal",
			"Sky",
			"Blue",
			"Purple",
			"Pink",
			"Gray",
		];
		const colors = ["red", "orange", "yellow", "green", "teal", "sky", "blue", "purple", "pink", "gray"];
		expect(rows(markup())).toStrictEqual([
			{
				row: "mobile:mb-l picker-text",
				titles,
				classes: ["cancel", ...colors.map((color) => `c-${color}`)],
			},
			{
				row: "mobile:mb-l picker-background",
				titles,
				classes: ["cancel", ...colors.map((color) => `bc-${color}`)],
			},
		]);
	});

	it("puts mobile:mr-l before the color class on Gray", () =>
	{
		expect(markup()).toContain("hover:border-strong mobile:mr-l c-gray");
	});

	it("marks only the selected swatch with the strong border", () =>
	{
		const strong = [
			...parsed(
				markup(
					{
						highlight: "yellow",
					},
				),
			).querySelectorAll("[class*='border-strong']"),
		].filter((element) => element.className.includes("border border-solid border-strong"));
		expect(strong.map((element) => element.getAttribute("title"))).toStrictEqual(["Yellow"]);
		expect(strong.map((element) => element.className.includes("bc-yellow"))).toStrictEqual([true]);
	});

	it("shows the upstream footer", () =>
	{
		const footer = parsed(markup()).querySelector(".bg-secondary");
		expect([...(footer?.children ?? [])].map((child) => child.textContent)).toStrictEqual([
			"Style text/apply style",
			"⌘⇧H",
		]);
	});

	it("places the flyout at the given left and top", () =>
	{
		expect(markup()).toContain("left:191.5px;top:296.5px");
	});

	it("matches upstream's live DOM apart from style values and svg paths", () =>
	{
		const upstream = readFileSync(DUMP, "utf8");
		const normalize = (html: string) =>
			html
				.replace(/^<!--[\s\S]*?-->/u, "")
				.replaceAll(/\sstyle="[^"]*"/gu, "")
				.replaceAll(/<path[^>]*><\/path>/gu, "<path/>")
				.replaceAll(/<path[^>]*\/>/gu, "<path/>")
				.replaceAll("<line", "<line")
				.replaceAll("></line>", "/>")
				.replaceAll(/\s+/gu, " ")
				.replaceAll('" >', '">')
				.replaceAll(/<\/(div|svg|path)> </gu, "</$1><")
				.trim();
		expect(normalize(markup())).toBe(normalize(upstream));
	});
});

describe("popupCentered", () =>
{
	it("centers the flyout when it would overflow the viewport", () =>
	{
		expect([popupCentered(191.5, 1272), popupCentered(900, 1272), popupCentered(888, 1272)]).toStrictEqual([
			false,
			true,
			false,
		]);
	});
});

describe("ColorPopup clicks", () =>
{
	let root: Root | undefined;
	let host: HTMLElement | undefined;

	beforeAll(() =>
	{
		globalThis.IS_REACT_ACT_ENVIRONMENT = true;
	});

	afterEach(async () =>
	{
		await act(async () =>
		{
			root?.unmount();
			await Promise.resolve();
		});
		host?.remove();
		document.body.innerHTML = "";
	});

	async function show(
		selected:
		{
			text?: "red";
			highlight?: "yellow";
		},
		onSelect: (kind: ColorKind, color: ColorName | null) => void,
	): Promise<void>
	{
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		await act(async () =>
		{
			root?.render(
				createElement(
					ColorPopup,
					{
						left: 10,
						top: 20,
						selected,
						onSelect,
						onClose: noop,
					},
				),
			);
			await Promise.resolve();
		});
	}

	function click(selector: string): void
	{
		const element = document.querySelector<HTMLElement>(selector);
		element?.dispatchEvent(
			new MouseEvent(
				"click",
				{
					bubbles: true,
				},
			),
		);
	}

	it("reports the picked color, and null for the selected swatch and for remove color", async () =>
	{
		const onSelect = vi.fn<(kind: string, color: string | null) => void>();
		await show(
			{
				text: "red",
			},
			onSelect,
		);
		await act(async () =>
		{
			click(".picker-text [title=Blue]");
			click(".picker-text [title=Red]");
			click(".picker-background [title='remove color']");
			await Promise.resolve();
		});
		expect(onSelect.mock.calls).toStrictEqual([
			["text", "blue"],
			["text", null],
			["highlight", null],
		]);
	});
});
