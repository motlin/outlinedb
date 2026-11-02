import {createElement} from "react";
import type {ReactNode, ReactPortal} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {describe, expect, it, vi} from "vite-plus/test";
import type {InlineAttr} from "../src/client/rich-text.js";

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

const {SelectionToolbar, selectionToolbarButtons, selectionToolbarButtonsFor} =
	await import("../src/client/components/selection-toolbar.js");

interface RenderOptions
{
	inNote?: boolean;
	activeAttrs?: ReadonlySet<InlineAttr>;
	layoutMode?: string | null;
	lastColorClass?: string;
	colorActive?: boolean;
	rect?:
	{
		x: number;
		y: number;
		width: number;
	};
}

function render({
	inNote = false,
	activeAttrs = new Set(),
	layoutMode = null,
	lastColorClass,
	colorActive = false,
	rect =
	{
		x: 0,
		y: 0,
		width: 0,
	},
}: RenderOptions = {}): string
{
	return renderToStaticMarkup(
		createElement(
			SelectionToolbar,
			{
				inNote,
				activeAttrs,
				layoutMode,
				lastColorClass,
				colorActive,
				rect,
				onAction: () =>
				{
				},
			},
		),
	);
}

/** Each toolbar item's class string and its svg's data-icon and class, in document order. */
function items(html: string):
{
	item: string;
	icon: string;
	svgClass: string;
}[]
{
	return [
		...html.matchAll(
			/<div role="button" tabindex="0" class="([^"]*)"><svg[^>]*?data-icon="([^"]*)" class="([^"]*)"/gu,
		),
	].map((m) => (
	{
		item: m[1],
		icon: m[2],
		svgClass: m[3],
	}));
}

const ALL_ICONS = [
	"h1",
	"h2",
	"h3",
	"paragraph",
	"bold",
	"underline",
	"italic",
	"strikethrough",
	"code",
	"link",
	"font",
	"chevron-down",
];
const INACTIVE = "ctx-menu-item  iconButton md shape-square";
const ACTIVE = "ctx-menu-item active iconButton md shape-square";

describe("SelectionToolbar", () =>
{
	it("renders upstream's 12 items in order outside a note", () =>
	{
		expect(items(render()).map((item) => item.icon)).toStrictEqual(ALL_ICONS);
	});

	it("hides the four layout buttons in a note", () =>
	{
		expect(
			items(
				render(
					{
						inNote: true,
					},
				),
			).map((item) => item.icon),
		).toStrictEqual(ALL_ICONS.slice(4));
	});

	it("marks exactly the touching inline attributes active", () =>
	{
		expect(
			items(
				render(
					{
						activeAttrs: new Set<InlineAttr>(["u", "i", "s", "code"]),
					},
				),
			).map((item) => item.item),
		).toStrictEqual(ALL_ICONS.map((_, index) => (index >= 5 && index <= 8 ? ACTIVE : INACTIVE)));
	});

	it("marks the layout button matching the row's layout mode active", () =>
	{
		expect(
			items(
				render(
					{
						layoutMode: "h1",
					},
				),
			).map((item) => item.item),
		).toStrictEqual(ALL_ICONS.map((_, index) => (index === 0 ? ACTIVE : INACTIVE)));
		expect(
			items(
				render(
					{
						layoutMode: "p",
					},
				),
			).map((item) => item.item),
		).toStrictEqual(ALL_ICONS.map((_, index) => (index === 3 ? ACTIVE : INACTIVE)));
	});

	it("positions the menu above the selection center like upstream", () =>
	{
		const html = render(
			{
				rect:
				{
					x: 150,
					y: 194,
					width: 34,
				},
			},
		);
		const divs = [...html.matchAll(/<div style="([^"]*)"(?: class="([^"]*)")?>/gu)].map((m) => (
		{
			style: m[1],
			classes: m[2]?.split(/\s+/u).filter(Boolean),
		}));
		expect(divs).toStrictEqual([
			{
				style: "overflow:hidden;margin-top:var(--safe-area-inset-top);margin-bottom:var(--safe-area-inset-bottom)",
				classes: undefined,
			},
			{
				style: "pointer-events:auto;z-index:300;max-width:none;margin-top:4px;left:222px;top:142px;margin-left:0;transform:scale(1, 1) translateX(-50%);transform-origin:0 0;opacity:1;padding:var(--wf-space-s)",
				classes: [
					"wf-menu",
					"flex",
					"flex-col",
					"border",
					"border-solid",
					"border-primary",
					"font-normal",
					"text-xs",
					"rounded-md",
					"bg-primary",
					"shadow-md",
					"overflow-x-hidden",
					"[transition:200ms_opacity]",
					"print:hidden",
					"absolute",
					"flyout",
					"ctx-menu",
				],
			},
		]);
	});

	it("renders every svg with upstream's far icon classes, the font swatch carrying the last color", () =>
	{
		expect(
			items(
				render(
					{
						lastColorClass: "bc-yellow",
					},
				),
			).map((item) => item.svgClass),
		).toStrictEqual([
			"svg-inline--fa fa-h1 fa-1x h1",
			"svg-inline--fa fa-h2 fa-1x h2",
			"svg-inline--fa fa-h3 fa-1x h3",
			"svg-inline--fa fa-paragraph fa-1x paragraph",
			"svg-inline--fa fa-bold fa-1x ",
			"svg-inline--fa fa-underline fa-1x ",
			"svg-inline--fa fa-italic fa-1x ",
			"svg-inline--fa fa-strikethrough fa-1x ",
			"svg-inline--fa fa-code fa-1x code",
			"svg-inline--fa fa-link fa-1x ",
			"svg-inline--fa fa-font fa-1x bc-yellow !p-[3px] rounded-[3px]",
			"svg-inline--fa fa-chevron-down fa-1x show-palette",
		]);
		expect(items(render()).find((item) => item.icon === "font")?.svgClass).toBe("svg-inline--fa fa-font fa-1x ");
	});

	it("uses upstream's tooltip strings", () =>
	{
		const gap = "      ";
		expect(selectionToolbarButtons.map((button) => [button.key, button.tooltip])).toStrictEqual([
			["h1", `Heading 1${gap}⌥⌘1`],
			["h2", `Heading 2${gap}⌥⌘2`],
			["h3", `Heading 3${gap}⌥⌘3`],
			["p", `Paragraph${gap}⌥⌘4`],
			["bold", `Bold${gap}⌘B`],
			["underline", `Underline${gap}⌘U`],
			["italic", `Italic${gap}⌘I`],
			["strikethrough", `Strikethrough${gap}⇧⌘X`],
			["code-format", "Inline Code    ⇧⌘C"],
			["link", `Link${gap}⌘K`],
			["latest-color", `Text color${gap}⇧⌘H`],
			["show-palette", undefined],
		]);
	});

	it("renders nothing in a code-block row", () =>
	{
		expect(
			render(
				{
					layoutMode: "code-block",
				},
			),
		).toBe("");
	});

	it("marks the paragraph button active for the legacy stored paragraph mode", () =>
	{
		expect(
			items(
				render(
					{
						layoutMode: "paragraph",
					},
				),
			).map((item) => item.item),
		).toStrictEqual(ALL_ICONS.map((_, index) => (index === 3 ? ACTIVE : INACTIVE)));
	});

	it("marks only the font button active when a color touches the selection", () =>
	{
		expect(
			items(
				render(
					{
						colorActive: true,
					},
				),
			).map((item) => item.item),
		).toStrictEqual(ALL_ICONS.map((_, index) => (index === 10 ? ACTIVE : INACTIVE)));
	});
});

describe("selectionToolbarButtonsFor", () =>
{
	it("returns no buttons for a code-block row, all twelve otherwise, and eight in a note", () =>
	{
		expect(
			selectionToolbarButtonsFor(
				{
					inNote: false,
					layoutMode: "code-block",
				},
			),
		).toStrictEqual([]);
		expect(
			selectionToolbarButtonsFor(
				{
					inNote: false,
					layoutMode: "h1",
				},
			).map((b) => b.key),
		).toStrictEqual(selectionToolbarButtons.map((b) => b.key));
		expect(
			selectionToolbarButtonsFor(
				{
					inNote: true,
					layoutMode: null,
				},
			).map((b) => b.key),
		).toStrictEqual(selectionToolbarButtons.slice(4).map((b) => b.key));
	});
});
