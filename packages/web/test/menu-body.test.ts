import {describe, expect, it, vi} from "vite-plus/test";
import {Fragment, createElement} from "react";
import type {ReactNode} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {MenuBody, menuMaxHeight} from "../src/client/components/flyout/menu.js";
import type {MenuBodyProps} from "../src/client/components/flyout/menu.js";
import {MenuItem, MenuSeparator} from "../src/client/components/flyout/menu-item.js";
import type {MenuItemProps} from "../src/client/components/flyout/menu-item.js";

function scrollerClass(borderLine: string): string
{
	return `
          scroller overflow-y-auto
          desktop:max-h-[min(var(--menu-max-h),calc(100vh-50px))]
          mobile:max-h-[min(var(--menu-max-h),50vh)]
          ${borderLine}
          [&>*:first-child]:mt-xs [&>*:last-child]:mb-xs
        `
		.replaceAll("&", "&amp;")
		.replaceAll(">", "&gt;");
}

function render(props: Omit<MenuBodyProps, "children">, ...children: ReactNode[]): string
{
	return renderToStaticMarkup(
		createElement(
			MenuBody,
			{
				...props,
				unwrapped: true,
			},
			...children,
		),
	);
}

const plain = createElement(
	"div",
	{
		key: "x",
	},
	"x",
);

describe("menuMaxHeight", () =>
{
	it("maps number, px string and absent", () =>
	{
		expect([
			menuMaxHeight(700),
			menuMaxHeight("240px"),
			menuMaxHeight(undefined),
			menuMaxHeight("50vh"),
		]).toStrictEqual(["700px", "240px", "calc(100vh - 50px)", "calc(100vh - 50px)"]);
	});
});

describe("MenuBody scroller", () =>
{
	it("renders a Fragment child (upstream item-type picker) as-is, without treating it as a row", () =>
	{
		expect(
			render(
				{},
				createElement(
					Fragment,
					{
						key: "f",
					},
					plain,
				),
			),
		).toBe(`<div style="--menu-max-h:calc(100vh - 50px)" class="${scrollerClass("")}"><div>x</div></div>`);
	});

	it("renders maxHeight 700 as px", () =>
	{
		expect(
			render(
				{
					maxHeight: 700,
				},
				plain,
			),
		).toBe(`<div style="--menu-max-h:700px" class="${scrollerClass("")}"><div>x</div></div>`);
	});

	it("keeps a px string", () =>
	{
		expect(
			render(
				{
					maxHeight: "240px",
				},
				plain,
			),
		).toBe(`<div style="--menu-max-h:240px" class="${scrollerClass("")}"><div>x</div></div>`);
	});

	it("defaults to the viewport cap", () =>
	{
		expect(render({}, plain)).toBe(
			`<div style="--menu-max-h:calc(100vh - 50px)" class="${scrollerClass("")}"><div>x</div></div>`,
		);
	});

	it("renders bottomSticky items after the scroller and borders the scroller", () =>
	{
		const sticky = renderToStaticMarkup(
			createElement(
				MenuItem,
				{
					label: "Sticky",
					isInKeyboardMode: false,
					isSelected: false,
				},
			),
		);
		expect(
			render(
				{},
				plain,
				createElement(
					MenuItem,
					{
						key: "s",
						label: "Sticky",
						bottomSticky: true,
					},
				),
			),
		).toBe(
			`<div style="--menu-max-h:calc(100vh - 50px)" class="${scrollerClass("border-b border-primary")}"><div>x</div></div>${sticky}`,
		);
	});
});

describe("MenuBody children", () =>
{
	it("marks the initialSelect item in keyboard mode, counting only enabled menu items", () =>
	{
		const markup = render(
			{
				keyboardMode: true,
				initialSelect: 1,
			},
			createElement(
				MenuItem,
				{
					key: "a",
					label: "A",
				},
			),
			createElement(
				MenuSeparator,
				{
					key: "sep",
				},
			),
			createElement(
				MenuItem,
				{
					key: "b",
					label: "B",
					disabled: true,
				},
			),
			createElement(
				MenuItem,
				{
					key: "c",
					label: "C",
				},
			),
		);
		const activeLabels = [...markup.matchAll(/<a [^>]*class="[^"]* active [^"]*"[^>]*>[\s\S]*?<\/a>/gu)].map(
			(match) => match[0].replaceAll(/<[^>]+>/gu, ""),
		);
		expect(activeLabels).toStrictEqual(["C"]);
	});

	it("selects nothing by default and leaves hover enabled", () =>
	{
		const markup = render(
			{},
			createElement(
				MenuItem,
				{
					key: "a",
					label: "A",
				},
			),
		);
		expect([markup.includes(" active "), markup.includes("canHover")]).toStrictEqual([false, true]);
	});

	it("wraps onSelect so exit runs unless the original returns truthy", () =>
	{
		const seen: MenuItemProps[] = [];
		function Probe(props: MenuItemProps)
		{
			seen.push(props);
			return null;
		}
		Probe.componentType = "menuItem" as const;
		const exit = vi.fn<() => void>();
		const keepOpen = vi.fn<() => boolean>(() => true);
		const close = vi.fn<() => undefined>(() => {});
		render(
			{
				exit,
			},
			createElement(
				Probe,
				{
					key: "keep",
					onSelect: keepOpen,
				},
			),
			createElement(
				Probe,
				{
					key: "close",
					onSelect: close,
				},
			),
			createElement(
				Probe,
				{
					key: "bare",
				},
			),
		);
		seen[0].onSelect?.();
		const afterKeep = exit.mock.calls.length;
		seen[1].onSelect?.();
		const afterClose = exit.mock.calls.length;
		seen[2].onSelect?.();
		expect([
			afterKeep,
			afterClose,
			exit.mock.calls.length,
			keepOpen.mock.calls.length,
			close.mock.calls.length,
		]).toStrictEqual([0, 1, 2, 1, 1]);
	});
});
