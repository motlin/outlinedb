import {useEffect, useRef} from "react";
import type {HTMLAttributes, KeyboardEvent, MouseEvent, MouseEventHandler, ReactNode} from "react";
import {useTooltip} from "./tooltip.js";

type IconButtonSize = "sm" | "ms" | "md" | "ml" | "lg" | "xl";
type IconButtonShape = "circle" | "square" | "none";

interface IconButtonProps extends Omit<HTMLAttributes<HTMLDivElement>, "onClick" | "onKeyDown">
{
	size?: IconButtonSize;
	shape?: IconButtonShape;
	className?: string;
	disabled?: boolean;
	tooltip?: ReactNode;
	shortcut?: string;
	/** Upstream's `icon` attribute naming the glyph, set on the Back and Forward buttons. */
	icon?: string;
	onClick?: MouseEventHandler<HTMLDivElement>;
	children?: ReactNode;
	[dataAttribute: `data-${string}`]: string | undefined;
}

interface KeyLikeEvent
{
	key: string;
	preventDefault: () => void;
	stopPropagation: () => void;
	currentTarget:
	{
		click: () => void;
	};
}

/** Upstream's IconButton key handling: Enter or Space activates the div like a native button. */
export function iconButtonKeyDown(event: KeyLikeEvent, disabled: boolean): void
{
	if (disabled || (event.key !== "Enter" && event.key !== " "))
	{
		return;
	}
	event.preventDefault();
	event.stopPropagation();
	event.currentTarget.click();
}

/** Upstream's `div[role=button].iconButton` with size and shape modifiers and an optional tooltip. */
export function IconButton({
	size = "lg",
	shape = "circle",
	className = "",
	disabled = false,
	tooltip,
	shortcut,
	onClick,
	onMouseDown,
	children,
	...rest
}: IconButtonProps)
{
	const elementRef = useRef<HTMLDivElement | null>(null);
	const {triggerProps, tooltip: tooltipNode} = useTooltip(
		{
			content: tooltip,
			shortcut,
			disabled: disabled || tooltip === undefined,
		},
	);
	const triggerRef = triggerProps.ref;

	useEffect(() =>
	{
		if (disabled && elementRef.current !== null && elementRef.current === document.activeElement)
		{
			elementRef.current.blur();
		}
	}, [disabled]);

	const hasTooltip = tooltip !== undefined && !disabled;
	const classes = [className, "iconButton", size, `shape-${shape}`, disabled && "disabled"].filter(Boolean).join(" ");

	return (
		<>
			<div
				// oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- upstream renders div[role=button]; markup parity with workflowy.com
				role="button"
				tabIndex={disabled ? -1 : 0}
				aria-disabled={disabled || undefined}
				{...rest}
				className={classes}
				onClick={onClick}
				onKeyDown={(event: KeyboardEvent<HTMLDivElement>) =>
				{
					iconButtonKeyDown(event, disabled);
				}}
				{...(hasTooltip ? triggerProps : {})}
				// The tooltip hides on mousedown; the caller's handler (e.g. keeping the editor's selection) still runs.
				onMouseDown={(event: MouseEvent<HTMLDivElement>) =>
				{
					if (hasTooltip)
					{
						triggerProps.onMouseDown();
					}
					onMouseDown?.(event);
				}}
				ref={(element) =>
				{
					elementRef.current = element;
					triggerRef(element);
				}}
			>
				{children}
			</div>
			{hasTooltip ? tooltipNode : null}
		</>
	);
}
