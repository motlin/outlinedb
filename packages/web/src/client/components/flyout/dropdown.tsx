import {Children, isValidElement, useLayoutEffect, useRef, useState} from "react";
import type {CSSProperties, ReactElement, ReactNode} from "react";
import {createPortal} from "react-dom";
import {FaIcon} from "../fa-icons.js";
import {MenuItem} from "./menu-item.js";
import type {MenuItemProps} from "./menu-item.js";
import {MenuBody} from "./menu.js";
import {placePopper, popperTransform, popperViewport} from "./place-popper.js";
import {BUTTON_MENU_Z, popoverBox} from "./popover-box.js";

/** How long after focus opened the menu a click is still part of that opening. */
const JUST_OPENED_MS = 300;

/** Gap between the trigger and its flyout (upstream popper offset `[0, 4]`). */
const FLYOUT_OFFSET = 4;

/** Upstream `q34`: a MenuItem that takes `isSelected` only to label the trigger and never renders it. */
export function DropdownOption({isSelected: _isSelected, ...props}: MenuItemProps)
{
	return <MenuItem {...props} />;
}

DropdownOption.componentType = "menuItem" as const;

type OptionElement = ReactElement<MenuItemProps>;

function isOption(node: ReactNode): node is OptionElement
{
	return isValidElement(node);
}

/** The label of the first child marked `isSelected`, else the empty string. */
function selectedLabel(children: ReactNode): ReactNode
{
	const selected = Children.toArray(children)
		.filter(isOption)
		.find((child) => child.props.isSelected === true);
	return selected?.props.label ?? "";
}

/** Upstream `K34`'s trigger class template, literal newlines and 8-space indents included. */
function dropdownTriggerClassName(className: string): string
{
	return `flex flex-row items-center justify-center gap-m box-border
        leading-[16px] text-s text-primary border border-solid border-primary
        whitespace-nowrap select-none cursor-pointer hover:bg-quaternary active:bg-quaternary
        [.menu:focus_&]:bg-[color-mix(in_srgb,var(--wf-background-quaternary)_85%,black)]
        [.menu:focus_&]:hover:bg-[color-mix(in_srgb,var(--wf-background-quaternary)_85%,black)]
        ${className}`;
}

export interface DropdownProps
{
	large?: boolean;
	className?: string;
	maxHeight?: number | string;
	style?: CSSProperties;
	menuStyle?: CSSProperties;
	children?: ReactNode;
}

/** Upstream DomKit Dropdown (`K34`), desktop: a focus-opened trigger whose flyout is portaled to the body. */
export function Dropdown({large = false, className = "dropdown", maxHeight, style, menuStyle, children}: DropdownProps)
{
	const wrapperRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLDivElement>(null);
	const flyoutRef = useRef<HTMLDivElement>(null);
	const justOpened = useRef(false);
	const timer = useRef<number>(0);
	const [open, setOpen] = useState(false);
	const [placed, setPlaced] = useState<
	{
		x: number;
		y: number;
		placement: string;
	}>(
		{
			x: 0,
			y: 0,
			placement: "bottom",
		},
	);

	useLayoutEffect(() =>
	{
		if (!open)
		{
			return () =>
			{
			};
		}
		const reposition = () =>
		{
			const trigger = triggerRef.current;
			const flyout = flyoutRef.current;
			if (!trigger || !flyout)
			{
				return;
			}
			const rect = trigger.getBoundingClientRect();
			const popper =
			{
				width: flyout.offsetWidth,
				height: flyout.offsetHeight,
			};
			const viewport = popperViewport(document);
			const below = placePopper(
				{
					reference:
					{
						left: rect.left,
						top: rect.top,
						width: rect.width,
						height: rect.height,
					},
					popper,
					placement: "bottom",
					viewport,
				},
			);
			const fitsBelow = rect.bottom + FLYOUT_OFFSET + popper.height <= viewport.height - 10;
			const fitsAbove = rect.top - FLYOUT_OFFSET - popper.height >= 10;
			if (!fitsBelow && fitsAbove)
			{
				setPlaced(
					{
						x: below.x + window.scrollX,
						y: rect.top - FLYOUT_OFFSET - popper.height + window.scrollY,
						placement: "top",
					},
				);
				return;
			}
			setPlaced(
				{
					x: below.x + window.scrollX,
					y: below.y + FLYOUT_OFFSET + window.scrollY,
					placement: "bottom",
				},
			);
		};
		reposition();
		window.addEventListener("resize", reposition);
		window.addEventListener("scroll", reposition, true);
		return () =>
		{
			window.removeEventListener("resize", reposition);
			window.removeEventListener("scroll", reposition, true);
		};
	}, [open]);

	const show = () =>
	{
		setOpen(true);
		justOpened.current = true;
		window.clearTimeout(timer.current);
		timer.current = window.setTimeout(() =>
		{
			justOpened.current = false;
		}, JUST_OPENED_MS);
	};
	const hide = () =>
	{
		setOpen(false);
	};
	const hideAndBlur = () =>
	{
		setOpen(false);
		wrapperRef.current?.blur();
	};

	const box = popoverBox(
		{
			minWidth: 0,
			maxWidth: 240,
		},
	);
	const triggerStyle: CSSProperties =
	{
		paddingTop: large ? 9 : 3,
		paddingBottom: large ? 9 : 3,
		paddingLeft: large ? 17 : 11,
		paddingRight: large ? 17 : 11,
		borderRadius: large ? 18 : 12,
		...menuStyle,
	};

	return (
		// oxlint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events -- verbatim upstream markup: a focusable div opens the menu on focus
		<div
			ref={wrapperRef}
			// oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- upstream opens the menu on trigger focus
			tabIndex={0}
			style={style}
			className="relative outline-none menu"
			onFocus={show}
			onBlur={hide}
			onClick={(event) =>
			{
				if (!justOpened.current)
				{
					event.currentTarget.blur();
				}
			}}
		>
			{/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- the wrapper owns the keyboard */}
			<div ref={triggerRef} className={dropdownTriggerClassName(className)} style={triggerStyle} onClick={show}>
				{selectedLabel(children)}
				<FaIcon icon="fal:chevron-down" size="1x" />
			</div>
			{open &&
				createPortal(
					<div
						ref={flyoutRef}
						className={`${box.className} flyout menu`}
						data-popper-reference-hidden="false"
						data-popper-escaped="false"
						data-popper-placement={placed.placement}
						style={
						{
							position: "absolute",
							inset: "0px auto auto 0px",
							...box.style,
							padding: "5px",
							zIndex: BUTTON_MENU_Z,
							transform: popperTransform(placed.x, placed.y, globalThis.devicePixelRatio || 1),
						}}
					>
						<MenuBody unwrapped disableKeyboard maxHeight={maxHeight} exit={hideAndBlur}>
							{children}
						</MenuBody>
					</div>,
					document.body,
				)}
		</div>
	);
}
