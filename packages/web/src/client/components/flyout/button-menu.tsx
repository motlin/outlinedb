import {useImperativeHandle, useLayoutEffect, useRef, useState} from "react";
import type {CSSProperties, ReactNode, Ref} from "react";
import {createPortal} from "react-dom";
import {createButtonMenuController} from "./button-menu-controller.js";
import {MenuBody} from "./menu.js";
import {placePopper, popperTransform, popperViewport} from "./place-popper.js";
import type {PopperPlacement} from "./place-popper.js";
import {BUTTON_MENU_Z, popoverBox} from "./popover-box.js";

export interface ButtonMenuHandle
{
	focus(): void;
}

export interface ButtonMenuProps
{
	button: ReactNode;
	/** Upstream `for`: adds `button-menu-for-<for>` to body while open. */
	for?: string;
	offset?: readonly [number, number];
	minWidth?: number;
	maxWidth?: number;
	maxHeight?: number | string;
	onShow?: () => void;
	onHide?: () => void;
	className?: string;
	style?: CSSProperties;
	actOnHover?: boolean;
	expanded?: boolean;
	setExpanded?: (expanded: boolean) => void;
	placement?: PopperPlacement;
	blockCloseOnInternalClick?: boolean;
	ref?: Ref<ButtonMenuHandle>;
	children?: ReactNode;
}

const DEFAULT_OFFSET = [0, 0] as const;

/** Upstream WF.DomKit.ButtonMenu (`w24`): a focusable trigger that portals a popper-placed flyout menu while open. */
export function ButtonMenu({
	button,
	for: forId,
	offset = DEFAULT_OFFSET,
	minWidth = 0,
	maxWidth = 240,
	maxHeight,
	onShow,
	onHide,
	className = "",
	style,
	actOnHover = false,
	expanded,
	setExpanded,
	placement = "bottom",
	blockCloseOnInternalClick = false,
	ref,
	children,
}: ButtonMenuProps)
{
	const triggerRef = useRef<HTMLDivElement>(null);
	const referenceRef = useRef<HTMLDivElement>(null);
	const flyoutRef = useRef<HTMLDivElement>(null);
	const [internalExpanded, setInternalExpanded] = useState(false);
	const [position, setPosition] = useState(
		{
			x: 0,
			y: 0,
		},
	);
	// Upstream: a controlled setExpanded replaces the internal setter, and either source can open the menu.
	const open = expanded === true || internalExpanded;

	// The controller is created once; its callbacks read the latest props through this ref.
	const latest = useRef(
		{
			onShow,
			onHide,
			setExpanded,
		},
	);
	useLayoutEffect(() =>
	{
		latest.current =
		{
			onShow,
			onHide,
			setExpanded,
		};
	});

	const [controller] = useState(() =>
		createButtonMenuController(
			{
				actOnHover,
				blockCloseOnInternalClick,
				forId,
				setTimeout: (fn, ms) => window.setTimeout(fn, ms),
				clearTimeout: (id) =>
				{
					window.clearTimeout(id);
				},
				bodyClassList:
				{
					add: (name) =>
					{
						document.body.classList.add(name);
					},
					remove: (name) =>
					{
						document.body.classList.remove(name);
					},
				},
				onShow: () =>
				{
					(latest.current.setExpanded ?? setInternalExpanded)(true);
					latest.current.onShow?.();
				},
				onHide: () =>
				{
					(latest.current.setExpanded ?? setInternalExpanded)(false);
					latest.current.onHide?.();
				},
				focusTrigger: () => triggerRef.current?.focus(),
			},
		),
	);

	useImperativeHandle(
		ref,
		() => (
		{
			focus: () => triggerRef.current?.focus(),
		}),
		[],
	);

	useLayoutEffect(() =>
	{
		const reposition = () =>
		{
			const reference = referenceRef.current;
			const flyout = flyoutRef.current;
			if (!reference || !flyout)
			{
				return;
			}
			const rect = reference.getBoundingClientRect();
			const placed = placePopper(
				{
					reference:
					{
						left: rect.left,
						top: rect.top,
						width: rect.width,
						height: rect.height,
					},
					popper:
					{
						width: flyout.offsetWidth,
						height: flyout.offsetHeight,
					},
					placement,
					viewport: popperViewport(document),
				},
			);
			// The flyout is absolutely positioned in document.body, so viewport coordinates need the scroll offset.
			setPosition(
				{
					x: placed.x + window.scrollX,
					y: placed.y + window.scrollY,
				},
			);
		};
		if (open)
		{
			reposition();
			window.addEventListener("resize", reposition);
			window.addEventListener("scroll", reposition, true);
		}
		return () =>
		{
			window.removeEventListener("resize", reposition);
			window.removeEventListener("scroll", reposition, true);
		};
	}, [open, placement]);

	const hide = () =>
	{
		controller.blur();
	};
	const box = popoverBox(
		{
			minWidth,
			maxWidth,
			offset,
		},
	);

	const flyout = (
		// oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- verbatim upstream markup: the pointer handlers only flag internal clicks
		<div
			ref={flyoutRef}
			onMouseDown={() =>
			{
				controller.flyoutPointerDown();
			}}
			onTouchStart={() =>
			{
				controller.flyoutPointerDown();
			}}
			className={`${box.className} flyout menu`}
			data-popper-reference-hidden="false"
			data-popper-escaped="false"
			data-popper-placement={placement}
			style={
			{
				position: "absolute",
				inset: "0px auto auto 0px",
				...box.style,
				padding: "5px",
				zIndex: BUTTON_MENU_Z,
				transform: popperTransform(position.x, position.y, globalThis.devicePixelRatio || 1),
			}}
		>
			<MenuBody unwrapped maxHeight={maxHeight} exit={hide}>
				{children}
			</MenuBody>
		</div>
	);

	return (
		// oxlint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events -- verbatim upstream markup: a focusable div is the menu trigger; Escape and other keys reach the global handlers
		<div
			ref={triggerRef}
			// oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- upstream opens the menu on trigger focus
			tabIndex={0}
			style={style}
			className={`relative outline-none menu ${className}`}
			onFocus={() =>
			{
				controller.focus();
			}}
			onBlur={() =>
			{
				controller.blur();
			}}
			onMouseEnter={() =>
			{
				controller.mouseEnter();
			}}
			onMouseLeave={() =>
			{
				controller.mouseLeave();
			}}
			onClick={(event) =>
			{
				const active = document.activeElement;
				const activeElement = active instanceof HTMLElement ? active : null;
				// A menu item's click bubbles here through the portal; it must not reopen the menu it just closed.
				const fromFlyout = event.target instanceof Node && (flyoutRef.current?.contains(event.target) ?? false);
				const action = controller.click(
					activeElement ? (triggerRef.current?.contains(activeElement) ?? false) : null,
					fromFlyout,
				);
				if (action === "blur")
				{
					activeElement?.blur();
				}
			}}
		>
			<div ref={referenceRef}>{button}</div>
			{open && createPortal(flyout, document.body)}
		</div>
	);
}
