import {describe, expect, it, vi} from "vite-plus/test";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import
{
	MenuItem,
	MenuSectionHeader,
	MenuSeparator,
	menuItemClassName,
	menuItemClick,
	menuItemMouseDown,
} from "../src/client/components/flyout/menu-item.js";

function tokens(className: string): string[]
{
	return className.split(/\s+/u).filter(Boolean);
}

function anchorClass(markup: string): string
{
	const match = /^<a[^>]* class="([^"]*)"/u.exec(markup);
	if (!match)
	{
		throw new Error(`No anchor class in ${markup}`);
	}
	return match[1];
}

// Copied from .llm/upstream-sync/dumps/bullet-menu-upstream-dom.html ("Open in Pane")
const UPSTREAM_ENABLED =
	"pl-l py-xs pr-l block !no-underline cursor-pointer whitespace-nowrap leading-base border-solid border-primary text-primary hover:bg-secondary mobile:border-t mobile:last:border-b mobile:py-ml mobile:landscape:pl-safe-left mobile:landscape:pr-safe-right menuItem menuItem canHover";
// Copied from .llm/upstream-sync/dumps/main-menu-upstream-dom.html ("Undo", disabled)
const UPSTREAM_DISABLED =
	"pl-l py-xs pr-l block !no-underline cursor-pointer whitespace-nowrap leading-base border-solid border-primary text-tertiary mobile:border-t mobile:last:border-b mobile:py-ml mobile:landscape:pl-safe-left mobile:landscape:pr-safe-right menuItem menuItem ";
// Copied from .llm/upstream-sync/dumps/tags-autocomplete-upstream-popup.html (keyboard-selected row)
const UPSTREAM_SELECTED =
	"pl-l py-xs pr-l block !no-underline cursor-pointer whitespace-nowrap leading-base border-solid border-primary text-primary bg-secondary mobile:border-t mobile:last:border-b mobile:py-ml mobile:landscape:pl-safe-left mobile:landscape:pr-safe-right menuItem menuItem active ";

const INNER_LABEL_CLASS =
	"grow flex items-center gap-m whitespace-nowrap\n          text-ellipsis overflow-hidden desktop:text-xs";
const SUBTEXT_CLASS =
	"text -mt-s pt-s block whitespace-nowrap text-xs\n        text-ellipsis text-tertiary overflow-hidden\n        ";

describe("menuItemClassName", () =>
{
	it("reproduces upstream's raw template for an enabled item", () =>
	{
		expect(
			menuItemClassName(
				{
					checked: null,
					disabled: false,
					isSelected: undefined,
					canHover: true,
					className: "menuItem",
				},
			),
		).toBe(
			"pl-l py-xs pr-l\n        block !no-underline cursor-pointer whitespace-nowrap leading-base\n        border-solid border-primary\n        text-primary\n         hover:bg-secondary\n        mobile:border-t mobile:last:border-b\n        mobile:py-ml mobile:landscape:pl-safe-left mobile:landscape:pr-safe-right\n        menuItem menuItem  canHover",
		);
	});
});

describe("MenuItem markup", () =>
{
	it("renders an enabled icon row like upstream's Open in Pane", () =>
	{
		const markup = renderToStaticMarkup(
			createElement(
				MenuItem,
				{
					label: "Open in Pane",
					handbook: "open_in_pane",
					icon: "fal:table-columns",
				},
			),
		);
		expect(tokens(anchorClass(markup))).toStrictEqual(tokens(UPSTREAM_ENABLED));
		expect(markup.replace(/ class="[^"]*"/u, "").replaceAll(/<path[^>]*><\/path>/gu, "")).toBe(
			`<a data-handbook="open_in_pane" data-handbook-placement="right"><span class="relative flex justify-between items-center"><span class="${INNER_LABEL_CLASS}"><div class="menuItemIcon flex items-center text-secondary"><svg aria-hidden="true" focusable="false" data-prefix="fal" data-icon="table-columns" class="svg-inline--fa fa-table-columns fa-fw fa-1x " role="img" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"></svg></div>Open in Pane</span></span></a>`,
		);
	});

	it("renders a disabled row with a shortcut like upstream's Undo", () =>
	{
		const markup = renderToStaticMarkup(
			createElement(
				MenuItem,
				{
					label: "Undo",
					handbook: "undo.undo",
					shortcut: "⌘Z",
					disabled: true,
				},
			),
		);
		expect(
			{
				classes: tokens(anchorClass(markup)),
				body: markup.replace(/^<a[^>]*>/u, ""),
			},
		).toStrictEqual(
			{
				classes: tokens(UPSTREAM_DISABLED),
				body: `<span class="relative flex justify-between items-center"><span class="${INNER_LABEL_CLASS}">Undo</span><span class="text ml-l min-w-[22px] text-xs text-tertiary">⌘Z</span></span></a>`,
			},
		);
	});

	it("renders a keyboard-selected row with bg-secondary and active but no canHover", () =>
	{
		const markup = renderToStaticMarkup(
			createElement(
				MenuItem,
				{
					label: "#taZebra",
					isSelected: true,
					isInKeyboardMode: true,
				},
			),
		);
		expect(tokens(anchorClass(markup))).toStrictEqual(tokens(UPSTREAM_SELECTED));
	});

	it("renders checked rows with pl-xl and a visible or invisible xs check", () =>
	{
		const render = (checked: boolean) =>
		{
			const markup = renderToStaticMarkup(
				createElement(
					MenuItem,
					{
						label: "Sort",
						checked,
					},
				),
			);
			return {
				classes: tokens(anchorClass(markup))[0],
				check: /<svg[^>]* class="([^"]*)"/u.exec(markup)?.[1],
			};
		};
		expect([render(true), render(false)]).toStrictEqual([
			{
				classes: "pl-xl",
				check: "svg-inline--fa fa-check fa-xs -ml-l shrink-0 grow-0 visible",
			},
			{
				classes: "pl-xl",
				check: "svg-inline--fa fa-check fa-xs -ml-l shrink-0 grow-0 invisible",
			},
		]);
	});

	it("renders subtext under an icon with ml-xl", () =>
	{
		const markup = renderToStaticMarkup(
			createElement(
				MenuItem,
				{
					label: "Copy",
					subtext: "as text",
					icon: "fal:copy",
				},
			),
		);
		expect(markup.endsWith(`</span><span class="${SUBTEXT_CLASS}ml-xl">as text</span></a>`)).toBe(true);
	});

	it("renders subtext without an icon and no ml-xl", () =>
	{
		const markup = renderToStaticMarkup(
			createElement(
				MenuItem,
				{
					label: "Copy",
					subtext: "as text",
				},
			),
		);
		expect(markup.endsWith(`</span><span class="${SUBTEXT_CLASS}">as text</span></a>`)).toBe(true);
	});

	it("renders the blue dot offset -12 unchecked and -15 checked", () =>
	{
		const dot = (checked: boolean | null) =>
			/<div style="([^"]*)" class="absolute top-1\/2 w-\[7px\] h-\[7px\] rounded-\[7px\] bg-tint -translate-y-1\/2"><\/div>/u.exec(
				renderToStaticMarkup(
					createElement(
						MenuItem,
						{
							label: "New",
							blueDot: true,
							checked,
						},
					),
				),
			)?.[1];
		expect([dot(null), dot(true)]).toStrictEqual(["left:-12px", "left:-15px"]);
	});

	it("renders pretext, clarifying text, extra and a place for an icon", () =>
	{
		const markup = renderToStaticMarkup(
			createElement(
				MenuItem,
				{
					label: "Item",
					pretext: "pre",
					clarifyingText: "(hint)",
					extra: "x",
					withPlaceForIcon: true,
					href: "/x",
				},
			),
		);
		expect(markup.replace(/ class="[^"]*"/u, "")).toBe(
			`<a data-handbook-placement="right" href="/x"><span class="pretextClass">pre</span><span class="relative flex justify-between items-center"><span class="${INNER_LABEL_CLASS}"><div class="menuItemIcon flex items-center text-secondary"></div>Item<span class="text ml-s text-tertiary">(hint)</span></span><span style="margin-left:6px">x</span></span></a>`,
		);
	});

	it("is tagged as a menuItem component", () =>
	{
		expect(MenuItem.componentType).toBe("menuItem");
	});
});

function fakeClick(
	overrides: Partial<
	{
		altKey: boolean;
		ctrlKey: boolean;
		metaKey: boolean;
		shiftKey: boolean;
		button: number;
	}> = {},
)
{
	return {
		altKey: false,
		ctrlKey: false,
		metaKey: false,
		shiftKey: false,
		button: 0,
		...overrides,
		preventDefault: vi.fn<() => void>(),
		stopPropagation: vi.fn<() => void>(),
	};
}

describe("MenuItem events", () =>
{
	function run(
		event: ReturnType<typeof fakeClick>,
		options:
		{
			href?: string;
			disabled: boolean;
			select: boolean;
		},
	)
	{
		const onSelect = vi.fn<() => void>();
		menuItemClick(
			event,
			{
				href: options.href,
				disabled: options.disabled,
				onSelect: options.select ? onSelect : undefined,
			},
		);
		return {
			preventDefault: event.preventDefault.mock.calls.length,
			stopPropagation: event.stopPropagation.mock.calls.length,
			selected: onSelect.mock.calls.length,
		};
	}

	it("selects on a plain click and prevents the default without href", () =>
	{
		expect(
			run(
				fakeClick(),
				{
					disabled: false,
					select: true,
				},
			),
		).toStrictEqual(
			{
				preventDefault: 1,
				stopPropagation: 0,
				selected: 1,
			},
		);
	});

	it("keeps the default navigation when href is set", () =>
	{
		expect(
			run(
				fakeClick(),
				{
					href: "/x",
					disabled: false,
					select: true,
				},
			),
		).toStrictEqual(
			{
				preventDefault: 0,
				stopPropagation: 0,
				selected: 1,
			},
		);
	});

	it("stops propagation and never selects when disabled", () =>
	{
		expect(
			run(
				fakeClick(),
				{
					disabled: true,
					select: true,
				},
			),
		).toStrictEqual(
			{
				preventDefault: 1,
				stopPropagation: 1,
				selected: 0,
			},
		);
	});

	it("ignores modifier and middle clicks", () =>
	{
		expect(
			[
				{
					altKey: true,
				},
				{
					ctrlKey: true,
				},
				{
					metaKey: true,
				},
				{
					shiftKey: true,
				},
				{
					button: 1,
				},
			].map((overrides) =>
				run(
					fakeClick(overrides),
					{
						disabled: false,
						select: true,
					},
				),
			),
		).toStrictEqual(
			Array.from(
				{
					length: 5,
				},
				() => (
				{
					preventDefault: 0,
					stopPropagation: 0,
					selected: 0,
				}),
			),
		);
	});

	it("prevents mousedown default so focus stays on the trigger", () =>
	{
		const event =
		{
			preventDefault: vi.fn<() => void>(),
		};
		const onMouseDown = vi.fn<() => void>();
		menuItemMouseDown(event, onMouseDown);
		expect(
			{
				prevented: event.preventDefault.mock.calls.length,
				called: onMouseDown.mock.calls.length,
			},
		).toStrictEqual(
			{
				prevented: 1,
				called: 1,
			},
		);
	});
});

describe("MenuSeparator and MenuSectionHeader", () =>
{
	it("renders upstream's separator", () =>
	{
		expect(renderToStaticMarkup(createElement(MenuSeparator))).toBe(
			'<div class="border-t border-primary border-solid my-s"></div>',
		);
	});

	it("renders upstream's section header with a trailing space for an empty className", () =>
	{
		// Copied from .llm/upstream-sync/dumps/move-reorder-upstream-moveto-dom.html
		expect(renderToStaticMarkup(createElement(MenuSectionHeader, {}, "Move To..."))).toBe(
			'<div class="py-m px-l text-tertiary text-xs uppercase bg-inherit mobile:bg-secondary menu-section-header mobile:landscape:pl-safe-left mobile:landscape:pr-safe-right ">Move To...</div>',
		);
	});
});
