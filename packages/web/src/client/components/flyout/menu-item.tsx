import {isValidElement} from "react";
import type {CSSProperties, MouseEvent, ReactElement, ReactNode, Ref} from "react";
import {FaIcon} from "../fa-icons.js";
import type {FaIconKey} from "../fa-icons.js";

interface MenuItemClassOptions
{
	checked: boolean | null;
	disabled: boolean;
	isSelected: boolean | undefined;
	canHover: boolean;
	className: string;
}

/** Upstream MenuItem's className template, literal newlines and 8-space indents included. */
export function menuItemClassName({checked, disabled, isSelected, canHover, className}: MenuItemClassOptions): string
{
	return `${checked === null ? "pl-l" : "pl-xl"} py-xs pr-l
        block !no-underline cursor-pointer whitespace-nowrap leading-base
        border-solid border-primary
        ${disabled ? "text-tertiary" : "text-primary"}
        ${isSelected ? "bg-secondary" : ""} ${canHover ? "hover:bg-secondary" : ""}
        mobile:border-t mobile:last:border-b
        mobile:py-ml mobile:landscape:pl-safe-left mobile:landscape:pr-safe-right
        menuItem ${className} ${isSelected ? "active" : ""} ${canHover ? "canHover" : ""}`;
}

interface ClickLike
{
	altKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
	shiftKey: boolean;
	button: number;
	preventDefault: () => void;
	stopPropagation: () => void;
	pageX?: number;
	pageY?: number;
}

/** What a row's `onSelect` receives: the click's page point, for rows that open a submenu there. */
export type MenuSelectEvent = Pick<ClickLike, "pageX" | "pageY">;

/** Upstream MenuItem onClick: ignore modifier/middle clicks; disabled rows swallow the click. */
export function menuItemClick(
	event: ClickLike,
	{
		href,
		disabled,
		onSelect,
	}:
	{
		href: string | undefined;
		disabled: boolean;
		onSelect: ((event?: MenuSelectEvent) => unknown) | undefined;
	},
): void
{
	if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.button === 1)
	{
		return;
	}
	if (onSelect && !href)
	{
		event.preventDefault();
	}
	if (disabled)
	{
		event.stopPropagation();
		return;
	}
	onSelect?.(event);
}

/** Upstream MenuItem onMouseDown: always preventDefault so focus stays on the menu trigger. */
export function menuItemMouseDown(
	event:
	{
		preventDefault: () => void;
	},
	onMouseDown: (() => void) | undefined,
): void
{
	onMouseDown?.();
	event.preventDefault();
}

type MenuItemIcon = FaIconKey | ReactElement;

export interface MenuItemProps
{
	label?: ReactNode;
	handbook?: string;
	clarifyingText?: ReactNode;
	shortcut?: ReactNode;
	subtext?: ReactNode;
	pretext?: ReactNode;
	className?: string;
	badge?: ReactNode;
	extra?: ReactNode;
	href?: string;
	icon?: MenuItemIcon;
	disabled?: boolean;
	style?: CSSProperties;
	isSelected?: boolean;
	isInKeyboardMode?: boolean;
	checked?: boolean | null;
	blueDot?: boolean;
	onSelect?: (event?: MenuSelectEvent) => unknown;
	onMouseEnter?: (event: MouseEvent<HTMLAnchorElement>) => void;
	onMouseLeave?: (event: MouseEvent<HTMLAnchorElement>) => void;
	onMouseDown?: () => void;
	withPlaceForIcon?: boolean;
	/** Read by MenuBody: render after the scroller. */
	bottomSticky?: boolean;
	ref?: Ref<HTMLAnchorElement>;
}

/** Upstream's `x && <el>` truthiness for optional ReactNode slots. */
function shown(node: ReactNode): boolean
{
	return node !== undefined && node !== null && node !== false && node !== "" && node !== 0;
}

function renderIcon(icon: MenuItemIcon): ReactNode
{
	return isValidElement(icon) ? icon : <FaIcon fixedWidth icon={icon} />;
}

/** Upstream DomKit MenuItem (`M24`), desktop rendering. */
export function MenuItem({
	label,
	handbook,
	clarifyingText,
	shortcut,
	subtext,
	pretext,
	className = "menuItem",
	badge,
	extra,
	href,
	icon,
	disabled = false,
	style,
	isSelected,
	isInKeyboardMode = false,
	checked = null,
	blueDot = false,
	onSelect,
	onMouseEnter,
	onMouseLeave,
	onMouseDown,
	withPlaceForIcon,
	ref,
}: MenuItemProps)
{
	const canHover = !disabled && !isInKeyboardMode;
	return (
		<a
			ref={ref}
			data-handbook={handbook}
			data-handbook-placement="right"
			style={
			{
				...style,
			}}
			onClick={(event) =>
			{
				menuItemClick(
					event,
					{
						href,
						disabled,
						onSelect,
					},
				);
			}}
			className={menuItemClassName(
				{
					checked,
					disabled,
					isSelected,
					canHover,
					className,
				},
			)}
			href={href}
			onMouseEnter={onMouseEnter}
			onMouseLeave={onMouseLeave}
			onMouseDown={(event) =>
			{
				menuItemMouseDown(event, onMouseDown);
			}}
		>
			{typeof pretext === "string" ? <span className="pretextClass">{pretext}</span> : pretext}
			<span className="relative flex justify-between items-center">
				{checked !== null && (
					<FaIcon
						icon="fal:check"
						size="xs"
						className={`-ml-l shrink-0 grow-0 ${checked ? "visible" : "invisible"}`}
					/>
				)}
				{blueDot && (
					<div
						style={
						{
							left: checked === null ? -12 : -15,
						}}
						className="absolute top-1/2 w-[7px] h-[7px] rounded-[7px] bg-tint -translate-y-1/2"
					/>
				)}
				<span
					className={`grow flex items-center gap-m whitespace-nowrap
          text-ellipsis overflow-hidden desktop:text-xs`}
				>
					{(withPlaceForIcon === true || icon !== undefined) && (
						<div className="menuItemIcon flex items-center text-secondary">
							{icon !== undefined && renderIcon(icon)}
						</div>
					)}
					{label}
					{shown(clarifyingText) && <span className="text ml-s text-tertiary">{clarifyingText}</span>}
					{shown(badge) && (
						<div
							className={`badge ml-m py-2xs px-m flex items-center justify-center text-xs leading-xs font-semibold
            text-center bg-tertiary text-primary rounded-xs capitalize`}
						>
							{badge}
						</div>
					)}
				</span>
				{shown(shortcut) && <span className="text ml-l min-w-[22px] text-xs text-tertiary">{shortcut}</span>}
				{shown(extra) && (
					<span
						style={
						{
							marginLeft: 6,
						}}
					>
						{extra}
					</span>
				)}
			</span>
			{shown(subtext) && (
				<span
					className={`text -mt-s pt-s block whitespace-nowrap text-xs
        text-ellipsis text-tertiary overflow-hidden
        ${icon !== undefined && !isValidElement(icon) ? "ml-xl" : ""}`}
				>
					{subtext}
				</span>
			)}
		</a>
	);
}

MenuItem.componentType = "menuItem" as const;

/** Upstream DomKit Menu.Separator (`x24`). */
export function MenuSeparator({style}: {style?: CSSProperties})
{
	return <div className="border-t border-primary border-solid my-s" style={style} />;
}

/** Upstream DomKit Menu.Header (`C24`). */
export function MenuSectionHeader({children, className = ""}: {children?: ReactNode; className?: string})
{
	return (
		<div
			className={`py-m px-l text-tertiary text-xs uppercase bg-inherit mobile:bg-secondary menu-section-header mobile:landscape:pl-safe-left mobile:landscape:pr-safe-right ${className}`}
		>
			{children}
		</div>
	);
}
