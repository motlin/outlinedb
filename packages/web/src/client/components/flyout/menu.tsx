import {Children, cloneElement, isValidElement, useCallback, useEffect, useMemo, useRef, useState} from "react";
import type {CSSProperties, ReactElement, ReactNode, Ref} from "react";
import type {MenuItemProps} from "./menu-item.js";
import {menuFocusStep, menuKeyboard} from "./menu-keyboard.js";
import type {MenuFocusKey, MenuFocusStep, MenuKeyboardState} from "./menu-keyboard.js";

type MenuItemElement = ReactElement<MenuItemProps>;

function isMenuItem(node: ReactNode): node is MenuItemElement
{
	if (!isValidElement(node) || typeof node.type !== "function")
	{
		return false;
	}
	return "componentType" in node.type && node.type.componentType === "menuItem";
}

function isBottomSticky(node: ReactNode): node is MenuItemElement
{
	return isMenuItem(node) && node.props.bottomSticky === true;
}

/** Each enabled menu item's place among the keyboard-navigable rows, in order. */
function navigableIndices(children: readonly ReactNode[]): number[]
{
	const indices: number[] = [];
	let next = 0;
	for (const child of children)
	{
		indices.push(next);
		if (isMenuItem(child) && child.props.disabled !== true)
		{
			next++;
		}
	}
	return indices;
}

/** Runs an item's onSelect; upstream keeps the menu open only when it returns a truthy value. */
function keepsOpen(onSelect: (() => unknown) | undefined): boolean
{
	return Boolean(onSelect?.());
}

/** Upstream `--menu-max-h`: `<n>px` for a number, a px string as-is, otherwise the viewport cap. */
export function menuMaxHeight(maxHeight: number | string | undefined): string
{
	if (maxHeight === undefined || maxHeight === "" || maxHeight === 0)
	{
		return "calc(100vh - 50px)";
	}
	if (typeof maxHeight === "number")
	{
		return `${maxHeight}px`;
	}
	return maxHeight.endsWith("px") ? maxHeight : "calc(100vh - 50px)";
}

export interface MenuBodyProps
{
	/** Upstream `__unstable_unwrapped`: ButtonMenu supplies the surface, so MenuBody renders only the scroller. */
	unwrapped?: true;
	maxHeight?: number | string;
	exit?: () => void;
	disableKeyboard?: boolean;
	cyclicNavigation?: boolean;
	selectOnTab?: boolean;
	stopKeydownEventPropagation?: boolean;
	keyboardMode?: boolean;
	initialSelect?: number;
	/** Upstream's wrapped Menu: arrows and Tab walk inputs, rows and buttons, entering `[data-keyboard-focus-scope]`s. */
	focusNavigation?: boolean;
	children?: ReactNode;
}

const FOCUSABLE_SELECTOR = 'input, .menuItem, button:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusKey(event: KeyboardEvent, selectOnTab: boolean): MenuFocusKey | undefined
{
	if (event.ctrlKey || event.isComposing)
	{
		return undefined;
	}
	if (event.key === "ArrowUp" || event.key === "ArrowDown")
	{
		return event.key;
	}
	if (event.key === "Tab" && !selectOnTab)
	{
		return event.shiftKey ? "ShiftTab" : "Tab";
	}
	return undefined;
}

/** Reads the menu's focusables from the DOM and runs upstream's wrapped-Menu step over them. */
function focusStep(
	root: HTMLElement | null,
	event: KeyboardEvent,
	selected: number,
	cyclic: boolean,
	selectOnTab: boolean,
):
	|
	  {
			result: MenuFocusStep;
			elements: HTMLElement[];
			focused: HTMLElement | undefined;
	  }
	| undefined
{
	const key = focusKey(event, selectOnTab);
	if (!root || !key)
	{
		return undefined;
	}
	const elements = [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
		(element) => !element.closest('[aria-hidden="true"]'),
	);
	const scopes = [...root.querySelectorAll("[data-keyboard-focus-scope]")];
	const items = elements.map((element) =>
	{
		const scope = element.closest("[data-keyboard-focus-scope]");
		return {
			menuItem: element.classList.contains("menuItem"),
			...(scope
				?
					{
						scope: scopes.indexOf(scope),
					}
				: {}),
			...(element.hasAttribute("data-keyboard-focus-enter-from-after")
				?
					{
						enterFromAfter: true,
					}
				: {}),
		};
	});
	const active = document.activeElement;
	const focused = active instanceof HTMLElement && root.contains(active) ? active : undefined;
	const focusedIndex = focused ? elements.indexOf(focused) : -1;
	return {
		result: menuFocusStep(items, focusedIndex, selected, key, cyclic),
		elements,
		focused,
	};
}

/** Upstream DomKit Menu (`z24`) in its unwrapped form: keyboard model, item cloning, scroller and bottomSticky. */
export function MenuBody({
	maxHeight,
	exit,
	disableKeyboard = false,
	cyclicNavigation = false,
	selectOnTab = true,
	stopKeydownEventPropagation = false,
	keyboardMode = false,
	initialSelect = -1,
	focusNavigation = false,
	children,
}: MenuBodyProps)
{
	const scroller = useRef<HTMLDivElement>(null);
	const [state, setState] = useState<MenuKeyboardState>(
		{
			index: initialSelect,
			hidden: false,
			keyboardMode,
		},
	);
	const [lastKeyMoved, setLastKeyMoved] = useState(false);
	const [mouseMovedSinceKey, setMouseMovedSinceKey] = useState(false);
	const [previous, setPrevious] = useState(
		{
			children,
			initialSelect,
		},
	);

	// Upstream resets the selection whenever children or initialSelect change, unless the last key moved it.
	if (previous.children !== children || previous.initialSelect !== initialSelect)
	{
		setPrevious(
			{
				children,
				initialSelect,
			},
		);
		if (!lastKeyMoved)
		{
			setState(
				{
					...state,
					index: initialSelect,
					hidden: false,
				},
			);
			setMouseMovedSinceKey(false);
		}
	}

	const navigable = useMemo(
		() =>
			Children.toArray(children).filter(
				(child): child is MenuItemElement => isMenuItem(child) && child.props.disabled !== true,
			),
		[children],
	);

	const selectIndex = useCallback(
		(index: number) =>
		{
			if (!keepsOpen(navigable[index]?.props.onSelect))
			{
				exit?.();
			}
		},
		[navigable, exit],
	);

	const stopWhenSelected = !state.hidden && state.index !== -1 && stopKeydownEventPropagation;

	useEffect(() =>
	{
		const onKeyDown = (event: KeyboardEvent) =>
		{
			const step = focusNavigation
				? focusStep(scroller.current, event, state.index, cyclicNavigation, selectOnTab)
				: undefined;
			if (step && step.result.kind !== "move")
			{
				event.preventDefault();
				if (stopKeydownEventPropagation)
				{
					event.stopImmediatePropagation();
				}
				setLastKeyMoved(true);
				setMouseMovedSinceKey(false);
				if (step.result.kind === "focus")
				{
					setState(
						{
							index: -1,
							hidden: false,
							keyboardMode: true,
						},
					);
					step.elements[step.result.index]?.focus();
				}
				else if (step.result.kind === "select")
				{
					step.focused?.blur();
					setState(
						{
							index: step.result.menuIndex,
							hidden: false,
							keyboardMode: true,
						},
					);
				}
				return;
			}
			const result = menuKeyboard(
				state,
				{
					key: event.key,
					ctrlKey: event.ctrlKey,
					shiftKey: event.shiftKey,
					composing: event.isComposing,
				},
				{
					count: navigable.length,
					cyclic: cyclicNavigation,
					selectOnTab,
					stopPropagation: stopKeydownEventPropagation,
				},
			);
			if (result.preventDefault)
			{
				event.preventDefault();
			}
			if (result.stopImmediate)
			{
				event.stopImmediatePropagation();
			}
			setLastKeyMoved(result.action === "move" && !event.ctrlKey);
			if (result.action === "move")
			{
				setMouseMovedSinceKey(false);
				setState(result.state);
			}
			else if (result.action === "select")
			{
				selectIndex(state.index);
			}
		};
		if (!disableKeyboard)
		{
			window.addEventListener("keydown", onKeyDown, stopWhenSelected);
		}
		return () =>
		{
			window.removeEventListener("keydown", onKeyDown, stopWhenSelected);
		};
	}, [
		disableKeyboard,
		state,
		navigable,
		cyclicNavigation,
		selectOnTab,
		stopKeydownEventPropagation,
		stopWhenSelected,
		selectIndex,
		focusNavigation,
	]);

	const items = Children.toArray(children);
	const sticky = items.filter(isBottomSticky);
	const ordered = [...items.filter((child) => !isBottomSticky(child)), ...sticky];
	const indices = navigableIndices(ordered);
	const cloneItem = (child: ReactNode, position: number): ReactNode =>
	{
		if (!isMenuItem(child))
		{
			return child;
		}
		const index = indices[position] ?? -1;
		const enabled = child.props.disabled !== true;
		return cloneElement(
			child,
			{
				isSelected: state.keyboardMode && enabled && state.index === index,
				isInKeyboardMode: state.keyboardMode,
				bottomSticky: isBottomSticky(child),
				onMouseEnter: () =>
				{
					if (mouseMovedSinceKey)
					{
						setState((current) => (
						{
							...current,
							index,
							keyboardMode: false,
						}));
					}
				},
				onSelect: () =>
				{
					if (!keepsOpen(child.props.onSelect))
					{
						exit?.();
					}
				},
			},
		);
	};

	const cloned = ordered.map(cloneItem);
	const body = cloned.slice(0, ordered.length - sticky.length);
	return (
		<>
			<MenuScroller
				ref={scroller}
				maxHeight={maxHeight}
				bordered={sticky.length > 0}
				onMouseMove={() =>
				{
					setMouseMovedSinceKey(true);
				}}
			>
				{body}
			</MenuScroller>
			{cloned.slice(ordered.length - sticky.length)}
		</>
	);
}

export interface MenuScrollerProps
{
	maxHeight?: number | string;
	/** A bottom border above bottomSticky rows. */
	bordered?: boolean;
	onMouseMove?: () => void;
	ref?: Ref<HTMLDivElement>;
	children?: ReactNode;
}

/** Upstream DomKit Menu's scroller: the rows' capped, scrollable column. */
export function MenuScroller({maxHeight, bordered = false, onMouseMove, ref, children}: MenuScrollerProps)
{
	const scrollerStyle: CSSProperties & Record<"--menu-max-h", string> =
	{
		"--menu-max-h": menuMaxHeight(maxHeight),
	};
	return (
		<div
			ref={ref}
			onMouseMove={onMouseMove}
			style={scrollerStyle}
			className={`
          scroller overflow-y-auto
          desktop:max-h-[min(var(--menu-max-h),calc(100vh-50px))]
          mobile:max-h-[min(var(--menu-max-h),50vh)]
          ${bordered ? "border-b border-primary" : ""}
          [&>*:first-child]:mt-xs [&>*:last-child]:mb-xs
        `}
		>
			{children}
		</div>
	);
}
