import {createElement} from "react";
import type {ReactNode, ReactPortal} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {describe, expect, it, vi} from "vite-plus/test";

vi.mock(import("react-dom"), async (importOriginal) => (
{
	...(await importOriginal()),
	createPortal: (node: ReactNode): ReactPortal => node as ReactPortal,
}));
vi.stubGlobal(
	"document",
	{
		body: {},
	},
);
const closeHooks = vi.hoisted(() => [] as (() => void)[]);
vi.mock(import("../src/client/hooks/use-close-on-location-change.js"), () => (
{
	useCloseOnLocationChange: (close: () => void) =>
	{
		closeHooks.push(close);
	},
}));

const {TagColorPicker, swatchClick} = await import("../src/client/components/tag-color-picker.js");

const noop = () =>
{
};

function render(currentColor?: string, onClose: () => void = noop): string
{
	return renderToStaticMarkup(
		createElement(
			TagColorPicker,
			{
				currentColor,
				left: 148,
				top: 165,
				onSelect: noop,
				onRemove: noop,
				onClose,
			},
		),
	);
}

/** Each swatch's title and class tokens, in document order. */
function swatches(html: string):
{
	title: string;
	classes: string[];
}[]
{
	return [...html.matchAll(/<div title="([^"]*)" class="([^"]*)"/gu)].map((m) => (
	{
		title: m[1],
		classes: m[2].split(/\s+/u).filter(Boolean),
	}));
}

const SWATCH_BASE = [
	"box-border",
	"h-[24px]",
	"w-[24px]",
	"flex",
	"items-center",
	"justify-center",
	"relative",
	"cursor-pointer",
	"bg-inherit",
	"rounded-s",
	"mobile:h-[36px]",
	"mobile:w-[36px]",
	"mobile:flex-shrink-0",
];

describe("TagColorPicker", () =>
{
	it("renders upstream's remove swatch then the ten color swatches, selecting only the current color", () =>
	{
		expect(swatches(render("green"))).toStrictEqual([
			{
				title: "remove color",
				classes: [...SWATCH_BASE, "border", "border-primary", "border-solid", "hover:border-strong", "cancel"],
			},
			...["Red", "Orange", "Yellow", "Green", "Teal", "Sky", "Blue", "Purple", "Pink", "Gray"].map((title) => (
			{
				title,
				classes: [
					...SWATCH_BASE,
					...(title === "Green"
						? ["border", "border-solid", "border-strong"]
						: ["border", "border-solid", "border-primary", "hover:border-strong"]),
					...(title === "Gray" ? ["mobile:mr-l"] : []),
					`bc-${title.toLowerCase()}`,
				],
			})),
		]);
	});

	it("never selects the remove swatch when the tag is uncolored", () =>
	{
		expect(swatches(render()).filter((swatch) => swatch.classes.includes("border-strong"))).toStrictEqual([]);
	});

	it("draws FontAwesome's far font glyph instead of an A text node", () =>
	{
		const html = render("green");
		expect(
			{
				textA: html.includes(">A<"),
				fontIcons: html.match(/data-prefix="far" data-icon="font"[^>]*viewBox="0 0 448 512"/gu)?.length,
			},
		).toStrictEqual(
			{
				textA: false,
				fontIcons: 10,
			},
		);
	});

	it("wraps the swatch row in upstream's flyout markup at tag.left / tag.bottom with a 4px margin", () =>
	{
		const html = render("green");
		const outer =
			/^<div class="([^"]*)" style="([^"]*)"><div><div class="w-full box-border p-s"><div class="flex flex-col gap-ml px-m pt-m"><div class="mobile:mb-l"><div class="([^"]*)"><div class="flex gap-m mobile:gap-ml mobile:pl-l mobile:min-w-max"><div title="remove color"/u.exec(
				html,
			);
		expect(outer?.slice(1)).toStrictEqual([
			"wf-menu flex flex-col border border-solid border-primary font-normal text-xs rounded-md bg-primary shadow-md overflow-x-hidden [transition:200ms_opacity] print:hidden flyout !pt-0 !pb-0 overflow-hidden tag-color-picker",
			"pointer-events:auto;z-index:300;max-width:384px;margin-top:4px;position:fixed;left:148px;top:165px",
			"w-full mobile:overflow-x-auto scrollbar-hide [&amp;::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]",
		]);
	});
});

describe("TagColorPicker location change", () =>
{
	it("closes through onClose when the location changes, as upstream's flyout does", () =>
	{
		closeHooks.length = 0;
		const onClose = () =>
		{
		};
		render("green", onClose);
		expect(closeHooks).toStrictEqual([onClose]);
	});
});

describe("swatchClick", () =>
{
	it("removes the color when the selected swatch is clicked again", () =>
	{
		expect(swatchClick("green", "green")).toBeNull();
	});

	it("picks the clicked color otherwise", () =>
	{
		expect([swatchClick("green", "red"), swatchClick(undefined, "red")]).toStrictEqual(["red", "red"]);
	});
});
