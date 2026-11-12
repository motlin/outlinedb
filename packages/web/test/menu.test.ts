import {describe, expect, it, vi} from "vite-plus/test";
import {Fragment, createElement} from "react";
import type {ReactNode} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {MenuBody, menuMaxHeight} from "../src/client/components/flyout/menu.js";
import type {MenuBodyProps} from "../src/client/components/flyout/menu.js";
import
{
	MenuItem,
	MenuSeparator,
	MenuSectionHeader,
	menuItemClassName,
	menuItemClick,
	menuItemMouseDown,
} from "../src/client/components/flyout/menu-item.js";
import type {MenuItemProps} from "../src/client/components/flyout/menu-item.js";
import {claimEscape, closeOnEscape} from "../src/client/menu-escape.js";
import {menuFocusStep, menuKeyboard} from "../src/client/components/flyout/menu-keyboard.js";
import type
{
	MenuFocusable,
	MenuFocusKey,
	MenuFocusStep,
	MenuKeyboardEvent,
	MenuKeyboardOptions,
	MenuKeyboardResult,
	MenuKeyboardState,
} from "../src/client/components/flyout/menu-keyboard.js";
import {formatMenuTimestamp} from "../src/client/menu-timestamp.js";

describe("menu body", () =>
{
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
});

describe("menu escape", () =>
{
	function key(name: string):
	{
		key: string;
		preventDefault: () => void;
		prevented: () => boolean;
	}
	{
		let prevented = false;
		return {
			key: name,
			preventDefault: () =>
			{
				prevented = true;
			},
			prevented: () => prevented,
		};
	}

	describe("closeOnEscape", () =>
	{
		it("claims Escape when it closes, so the window search Escape skips it as upstream's menus do", () =>
		{
			const close = vi.fn<() => void>();
			const escape = key("Escape");
			closeOnEscape(close)(escape);
			expect(
				{
					closed: close.mock.calls.length,
					prevented: escape.prevented(),
				},
			).toStrictEqual(
				{
					closed: 1,
					prevented: true,
				},
			);
		});

		it("ignores other keys", () =>
		{
			const close = vi.fn<() => void>();
			const enter = key("Enter");
			closeOnEscape(close)(enter);
			expect(
				{
					closed: close.mock.calls.length,
					prevented: enter.prevented(),
				},
			).toStrictEqual(
				{
					closed: 0,
					prevented: false,
				},
			);
		});
	});

	describe("claimEscape", () =>
	{
		it("claims Escape only when the menu was open and closed, as a popup's close callback reports", () =>
		{
			const open = key("Escape");
			const shut = key("Escape");
			claimEscape(open, () => true);
			claimEscape(shut, () => false);
			expect([open.prevented(), shut.prevented()]).toStrictEqual([true, false]);
		});
	});
});

describe("menu item", () =>
{
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
});

describe("menu keyboard", () =>
{
	const fresh: MenuKeyboardState =
	{
		index: -1,
		hidden: false,
		keyboardMode: false,
	};
	const at = (index: number): MenuKeyboardState => (
	{
		index,
		hidden: false,
		keyboardMode: true,
	});
	const defaults: MenuKeyboardOptions =
	{
		count: 3,
		cyclic: false,
		selectOnTab: true,
		stopPropagation: false,
	};
	const key = (k: string, extra: Partial<MenuKeyboardEvent> = {}): MenuKeyboardEvent => (
	{
		key: k,
		ctrlKey: false,
		shiftKey: false,
		composing: false,
		...extra,
	});
	const moved = (state: MenuKeyboardState, stopImmediate = false): MenuKeyboardResult => (
	{
		state,
		action: "move",
		preventDefault: true,
		stopImmediate,
	});
	const selected = (state: MenuKeyboardState, preventDefault = true, stopImmediate = false): MenuKeyboardResult => (
	{
		state,
		action: "select",
		preventDefault,
		stopImmediate,
	});
	const none = (state: MenuKeyboardState, preventDefault = false, stopImmediate = false): MenuKeyboardResult => (
	{
		state,
		action: "none",
		preventDefault,
		stopImmediate,
	});

	const cases: [string, MenuKeyboardState, MenuKeyboardEvent, Partial<MenuKeyboardOptions>, MenuKeyboardResult][] = [
		["ArrowDown from -1 selects the first item", fresh, key("ArrowDown"), {}, moved(at(0))],
		[
			"Ctrl+N from -1 selects the first item",
			fresh,
			key(
				"n",
				{
					ctrlKey: true,
				},
			),
			{},
			moved(at(0)),
		],
		["ArrowDown advances", at(0), key("ArrowDown"), {}, moved(at(1))],
		["ArrowDown clamps at the last item", at(2), key("ArrowDown"), {}, moved(at(2))],
		[
			"cyclic ArrowDown wraps to the first item",
			at(2),
			key("ArrowDown"),
			{
				cyclic: true,
			},
			moved(at(0)),
		],
		["ArrowUp from -1 selects the last item", fresh, key("ArrowUp"), {}, moved(at(2))],
		[
			"Ctrl+P from -1 selects the last item",
			fresh,
			key(
				"p",
				{
					ctrlKey: true,
				},
			),
			{},
			moved(at(2)),
		],
		["ArrowUp moves back", at(2), key("ArrowUp"), {}, moved(at(1))],
		[
			"ArrowUp below 0 hides the selection",
			at(0),
			key("ArrowUp"),
			{},
			moved(
				{
					index: -1,
					hidden: true,
					keyboardMode: false,
				},
			),
		],
		[
			"cyclic ArrowUp wraps to the last item",
			at(0),
			key("ArrowUp"),
			{
				cyclic: true,
			},
			moved(at(2)),
		],
		[
			"count 0 ArrowDown highlights nothing (index 0 of no items)",
			fresh,
			key("ArrowDown"),
			{
				count: 0,
			},
			moved(at(0)),
		],
		[
			"count 0 ArrowUp from -1 hides",
			fresh,
			key("ArrowUp"),
			{
				count: 0,
			},
			moved(
				{
					index: -1,
					hidden: true,
					keyboardMode: true,
				},
			),
		],
		[
			"stopPropagation stops arrows when an item is selected",
			at(0),
			key("ArrowDown"),
			{
				stopPropagation: true,
			},
			moved(at(1), true),
		],
		[
			"stopPropagation does not stop arrows from -1",
			fresh,
			key("ArrowDown"),
			{
				stopPropagation: true,
			},
			moved(at(0)),
		],
		[
			"stopPropagation does not stop arrows while hidden",
			{
				index: 1,
				hidden: true,
				keyboardMode: true,
			},
			key("ArrowDown"),
			{
				stopPropagation: true,
			},
			moved(at(2)),
		],
		[
			"Ctrl+other key does nothing",
			at(0),
			key(
				"ArrowDown",
				{
					ctrlKey: true,
				},
			),
			{},
			none(at(0)),
		],
		[
			"composing ignores ArrowDown",
			at(0),
			key(
				"ArrowDown",
				{
					composing: true,
				},
			),
			{},
			none(at(0)),
		],
		[
			"composing ignores ArrowUp",
			at(1),
			key(
				"ArrowUp",
				{
					composing: true,
				},
			),
			{},
			none(at(1)),
		],
		["Enter selects the current index", at(1), key("Enter"), {}, selected(at(1))],
		[
			"Enter stops propagation when asked",
			at(1),
			key("Enter"),
			{
				stopPropagation: true,
			},
			selected(at(1), true, true),
		],
		["Enter at -1 does nothing", fresh, key("Enter"), {}, none(fresh)],
		[
			"composing ignores Enter",
			at(1),
			key(
				"Enter",
				{
					composing: true,
				},
			),
			{},
			none(at(1)),
		],
		["Tab selects by default", at(1), key("Tab"), {}, selected(at(1))],
		["Tab at -1 prevents default but selects nothing", fresh, key("Tab"), {}, none(fresh, true)],
		[
			"Tab without selectOnTab moves down",
			at(0),
			key("Tab"),
			{
				selectOnTab: false,
			},
			moved(at(1)),
		],
		[
			"Shift+Tab without selectOnTab moves up",
			at(1),
			key(
				"Tab",
				{
					shiftKey: true,
				},
			),
			{
				selectOnTab: false,
			},
			moved(at(0)),
		],
		[
			"Tab without selectOnTab stops propagation whenever asked",
			fresh,
			key("Tab"),
			{
				selectOnTab: false,
				stopPropagation: true,
			},
			moved(at(0), true),
		],
		[
			"composing ignores Tab",
			at(1),
			key(
				"Tab",
				{
					composing: true,
				},
			),
			{},
			none(at(1)),
		],
		["other keys do nothing", at(1), key("a"), {}, none(at(1))],
	];

	describe("menuKeyboard", () =>
	{
		it.each(cases)("%s", (_name, state, event, opts, expected) =>
		{
			expect(
				menuKeyboard(
					state,
					event,
					{
						...defaults,
						...opts,
					},
				),
			).toStrictEqual(expected);
		});
	});

	describe("menuFocusStep", () =>
	{
		// The date popup's order: input, three presets, a focus scope (header, day, last-row day), Range, Format.
		const items: MenuFocusable[] = [
			{
				menuItem: false,
			},
			{
				menuItem: true,
			},
			{
				menuItem: true,
			},
			{
				menuItem: true,
			},
			{
				menuItem: false,
				scope: 0,
			},
			{
				menuItem: false,
				scope: 0,
			},
			{
				menuItem: false,
				scope: 0,
				enterFromAfter: true,
			},
			{
				menuItem: true,
			},
			{
				menuItem: true,
			},
		];
		const focusCases: [string, number, number, MenuFocusKey, MenuFocusStep][] = [
			[
				"ArrowDown from the focused input selects the first row",
				0,
				-1,
				"ArrowDown",
				{
					kind: "select",
					menuIndex: 0,
				},
			],
			[
				"ArrowDown between rows is a plain move",
				-1,
				0,
				"ArrowDown",
				{
					kind: "move",
				},
			],
			[
				"ArrowDown from the last preset focuses the first scope button",
				-1,
				2,
				"ArrowDown",
				{
					kind: "focus",
					index: 4,
				},
			],
			[
				"ArrowDown from inside a scope selects the row after it",
				5,
				-1,
				"ArrowDown",
				{
					kind: "select",
					menuIndex: 3,
				},
			],
			[
				"ArrowDown from the last row is a plain move",
				-1,
				4,
				"ArrowDown",
				{
					kind: "move",
				},
			],
			[
				"ArrowUp into a scope focuses its enter-from-after button",
				-1,
				3,
				"ArrowUp",
				{
					kind: "focus",
					index: 6,
				},
			],
			[
				"ArrowUp from inside a scope selects the row before it",
				4,
				-1,
				"ArrowUp",
				{
					kind: "select",
					menuIndex: 2,
				},
			],
			[
				"ArrowUp from the focused input does nothing",
				0,
				-1,
				"ArrowUp",
				{
					kind: "none",
				},
			],
			[
				"ArrowUp between rows is a plain move",
				-1,
				1,
				"ArrowUp",
				{
					kind: "move",
				},
			],
			[
				"Tab from the focused input selects the first row",
				0,
				-1,
				"Tab",
				{
					kind: "select",
					menuIndex: 0,
				},
			],
			[
				"Tab from the last preset focuses the next button",
				-1,
				2,
				"Tab",
				{
					kind: "focus",
					index: 4,
				},
			],
			[
				"Tab inside a scope focuses the next button",
				4,
				-1,
				"Tab",
				{
					kind: "focus",
					index: 5,
				},
			],
			[
				"Shift+Tab from a scope button selects the row before it",
				4,
				-1,
				"ShiftTab",
				{
					kind: "select",
					menuIndex: 2,
				},
			],
			[
				"Tab with nothing focused focuses the input",
				-1,
				-1,
				"Tab",
				{
					kind: "focus",
					index: 0,
				},
			],
			[
				"Tab past the end does nothing",
				-1,
				4,
				"Tab",
				{
					kind: "none",
				},
			],
		];
		it.each(focusCases)("%s", (_name, focused, selectedRow, step, expected) =>
		{
			expect(menuFocusStep(items, focused, selectedRow, step, false)).toStrictEqual(expected);
		});

		it("wraps Tab past the end when cyclic", () =>
		{
			expect(menuFocusStep(items, -1, 4, "Tab", true)).toStrictEqual(
				{
					kind: "focus",
					index: 0,
				},
			);
		});
	});
});

describe("menu timestamp", () =>
{
	function localSeconds(year: number, month: number, day: number, hour: number, minute: number): number
	{
		return new Date(year, month - 1, day, hour, minute).getTime() / 1000;
	}

	const now = new Date(2026, 9, 23, 3, 44);
	const defaults =
	{
		dateFormat: "ddd, MMM D",
		timeFormat: "h:mma",
	};
	const isoStyle =
	{
		dateFormat: "YYYY-MM-DD ddd",
		timeFormat: "HH:mm",
	};

	const stamps = (formats: {dateFormat: string; timeFormat: string}) => [
		formatMenuTimestamp(localSeconds(2026, 10, 23, 3, 44), now, formats),
		formatMenuTimestamp(localSeconds(2026, 10, 21, 21, 25), now, formats),
		formatMenuTimestamp(localSeconds(2025, 3, 5, 9, 7), now, formats),
	];

	describe("formatMenuTimestamp", () =>
	{
		it("formats today, an earlier day this year and a day in another year with the account formats", () =>
		{
			expect(stamps(isoStyle)).toStrictEqual([
				"Today at 03:44",
				"2026-10-21 Wed at 21:25",
				"2025-03-05 Wed at 09:07",
			]);
		});

		it("uses the default formats, adding the year only for another year", () =>
		{
			expect(stamps(defaults)).toStrictEqual([
				"Today at 3:44am",
				"Wed, Oct 21 at 9:25pm",
				"Wed, Mar 5, 2025 at 9:07am",
			]);
		});

		it("keeps midnight on the same day as Today", () =>
		{
			expect(formatMenuTimestamp(localSeconds(2026, 10, 23, 0, 0), now, isoStyle)).toBe("Today at 00:00");
		});
	});
});
