import type {CSSProperties} from "react";

/** Upstream WF.DomKit.FlyoutAlign. */
export const FlyoutAlign =
{
	Left: 0,
	Center: 1,
	None: 2,
} as const;
export type FlyoutAlign = (typeof FlyoutAlign)[keyof typeof FlyoutAlign];

export interface FlyoutStyleOptions
{
	position?: readonly [number, number];
	offset?: readonly [number, number];
	align?: FlyoutAlign;
	expanded?: boolean;
	rounded?: boolean;
	dense?: boolean;
	maxHeight?: CSSProperties["maxHeight"];
	/** The bottom-overflow correction from {@link bottomShift}. */
	shiftY?: number;
}

const ROUNDED_STYLE: CSSProperties =
{
	borderTop: "none",
	margin: "0",
	boxShadow: "none",
	borderRadius: "0 0 16px 16px",
	boxSizing: "border-box",
};

const DEFAULT_OFFSET = [0, 0] as const;

/** Upstream `a24`'s inline positioning style, in upstream's property order. */
export function flyoutStyle({
	position,
	offset = DEFAULT_OFFSET,
	align = FlyoutAlign.Center,
	expanded = true,
	rounded = false,
	dense = false,
	maxHeight,
	shiftY = 0,
}: FlyoutStyleOptions = {}): CSSProperties
{
	const style: CSSProperties =
	{
		maxHeight,
	};
	// Upstream tests maxHeight for truthiness, so 0 and "" do not scroll.
	if (maxHeight !== undefined && maxHeight !== 0 && maxHeight !== "")
	{
		style.overflowY = "auto";
	}
	if (position)
	{
		style.left = position[0];
		style.top = position[1];
	}
	else
	{
		if (align === FlyoutAlign.Center)
		{
			style.left = "50%";
		}
		else if (align === FlyoutAlign.Left)
		{
			style.left = offset[0];
		}
		style.top = "100%";
	}
	let translateX = "0";
	let originX = "90%";
	if (align === FlyoutAlign.Center)
	{
		style.marginLeft = offset[0];
		translateX = "-50%";
		originX = "0";
	}
	else if (align === FlyoutAlign.Left)
	{
		originX = "10%";
	}
	const shift = shiftY === 0 ? "" : ` translate(0px, ${shiftY}px)`;
	style.transform = `scale(1, 1) translateX(${translateX})${shift}`;
	style.transformOrigin = `${originX} 0`;
	if (rounded)
	{
		Object.assign(style, ROUNDED_STYLE);
	}
	if (dense)
	{
		style.paddingTop = 0;
		style.paddingBottom = 0;
	}
	if (expanded)
	{
		style.opacity = 1;
	}
	else
	{
		style.pointerEvents = "none";
		style.opacity = 0;
	}
	return style;
}

/** Upstream's bottom-overflow correction: lift the flyout 10px inside the viewport, but never push its top above 10px. */
export function bottomShift(
	rect:
	{
		top: number;
		bottom: number;
	},
	innerHeight: number,
): number
{
	if (rect.bottom <= innerHeight)
	{
		return 0;
	}
	let shift = innerHeight - rect.bottom - 10;
	if (rect.top + shift < 0)
	{
		shift -= rect.top + shift - 10;
	}
	return shift;
}
