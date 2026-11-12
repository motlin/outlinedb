import {useCallback, useEffect, useLayoutEffect, useRef, useState} from "react";
import type {CSSProperties, MouseEventHandler, ReactNode, Ref, UIEventHandler} from "react";
import {FlyoutAlign, bottomShift, flyoutStyle} from "./flyout-style.js";
import {popoverBox} from "./popover-box.js";

/** Upstream EnterExit's fade length, matching popoverBox's `[transition:200ms_opacity]`. */
const FADE_MS = 200;

const DEFAULT_OFFSET = [0, 0] as const;

export interface FlyoutProps
{
	position?: readonly [number, number];
	offset?: readonly [number, number];
	minWidth?: number | string;
	maxWidth?: number | string;
	maxHeight?: CSSProperties["maxHeight"];
	align?: FlyoutAlign;
	expanded?: boolean;
	surfaceClassName?: string;
	className?: string;
	onMouseEnter?: MouseEventHandler<HTMLDivElement>;
	onMouseLeave?: MouseEventHandler<HTMLDivElement>;
	onMouseDown?: MouseEventHandler<HTMLDivElement>;
	onScroll?: UIEventHandler<HTMLDivElement>;
	dense?: boolean;
	rounded?: boolean;
	style?: CSSProperties;
	scrollIntoView?: boolean;
	/** Upstream default true: fade out over 200ms after `expanded` turns false, then unmount. */
	removeFromDom?: boolean;
	ref?: Ref<HTMLDivElement>;
	children?: ReactNode;
}

/** Keeps the flyout mounted for the fade after `visible` turns false, like upstream EnterExit. */
function useFadeMounted(visible: boolean): boolean
{
	const [gone, setGone] = useState(!visible);
	const [previousVisible, setPreviousVisible] = useState(visible);
	if (visible !== previousVisible)
	{
		setPreviousVisible(visible);
		if (visible)
		{
			setGone(false);
		}
	}
	useEffect(() =>
	{
		const timer = visible
			? undefined
			: window.setTimeout(() =>
				{
					setGone(true);
				}, FADE_MS);
		return () =>
		{
			window.clearTimeout(timer);
		};
	}, [visible]);
	return !gone;
}

/** Upstream WF.DomKit.Flyout (`a24`): an absolutely positioned popup surface below its offset parent. */
export function Flyout({removeFromDom = true, expanded = true, ...props}: FlyoutProps)
{
	const mounted = useFadeMounted(expanded);
	if (removeFromDom && !mounted)
	{
		return null;
	}
	return <FlyoutSurface {...props} expanded={expanded} />;
}

function FlyoutSurface({
	position,
	offset = DEFAULT_OFFSET,
	minWidth,
	maxWidth = 240,
	maxHeight,
	align = FlyoutAlign.Center,
	expanded,
	surfaceClassName = "",
	className = "",
	onMouseEnter,
	onMouseLeave,
	onMouseDown,
	onScroll,
	dense,
	rounded,
	style,
	scrollIntoView,
	ref,
	children,
}: Omit<FlyoutProps, "removeFromDom">)
{
	const elementRef = useRef<HTMLDivElement | null>(null);
	const [shiftY, setShiftY] = useState(0);
	const setRef = useCallback(
		(element: HTMLDivElement | null) =>
		{
			elementRef.current = element;
			if (typeof ref === "function")
			{
				ref(element);
			}
			else if (ref)
			{
				ref.current = element;
			}
		},
		[ref],
	);

	// Upstream runs this once on mount, so later scrollIntoView changes are ignored.
	const [scrollOnMount] = useState(scrollIntoView);
	useEffect(() =>
	{
		document.body.classList.add("fly");
		if (scrollOnMount)
		{
			elementRef.current?.scrollIntoView(
				{
					block: "nearest",
				},
			);
		}
		return () =>
		{
			document.body.classList.remove("fly");
		};
	}, [scrollOnMount]);

	const shifts = expanded !== false && align !== FlyoutAlign.None;
	// A hidden or unaligned flyout drops its shift, so the next showing measures from zero.
	if (!shifts && shiftY !== 0)
	{
		setShiftY(0);
	}
	useLayoutEffect(() =>
	{
		const element = elementRef.current;
		if (!element || !shifts)
		{
			return;
		}
		// Upstream leaves the previous shift in place when the flyout already fits.
		const shift = bottomShift(element.getBoundingClientRect(), window.innerHeight);
		if (shift !== 0)
		{
			setShiftY(shift);
		}
	}, [shifts]);

	const box = popoverBox(
		{
			surfaceName: surfaceClassName || undefined,
			minWidth,
			maxWidth,
			offset,
		},
	);
	const positioning = flyoutStyle(
		{
			position,
			offset,
			align,
			expanded,
			rounded,
			dense,
			maxHeight,
			shiftY,
		},
	);
	return (
		// oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- verbatim upstream markup: the mouse handlers only track hover and keep input focus
		<div
			ref={setRef}
			style={
			{
				...box.style,
				...positioning,
				...style,
			}}
			onScroll={onScroll}
			onMouseEnter={onMouseEnter}
			onMouseLeave={onMouseLeave}
			onMouseDown={onMouseDown}
			className={`${box.className} absolute flyout ${className}`}
		>
			{children}
		</div>
	);
}
