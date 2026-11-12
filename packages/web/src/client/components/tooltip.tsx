import {cloneElement, useCallback, useEffect, useLayoutEffect, useRef, useState} from "react";
import type {ReactElement, ReactNode, Ref, RefCallback, SyntheticEvent} from "react";
import {createPortal} from "react-dom";

/** Gap between trigger bottom and tooltip top (tippy offset [0, 10]). */
const OFFSET = 10;
/** Minimum distance kept from the viewport edges. */
const VIEWPORT_PADDING = 8;

type TooltipState = "hidden" | "visible";

interface TooltipBoxProps
{
	content: ReactNode;
	shortcut?: string;
	state: TooltipState;
	/** Horizontal arrow offset: half the box width, once measured. */
	arrowX?: number;
}

function tooltipText(content: ReactNode, shortcut: string | undefined): ReactNode
{
	if (shortcut === undefined || shortcut === "")
	{
		return content;
	}
	if (typeof content === "string" || typeof content === "number")
	{
		return `${content} ${shortcut}`;
	}
	return (
		<>
			{content} {shortcut}
		</>
	);
}

/** Upstream's tippy box markup (`.tippy-box.wf-helper.tooltip`), rendered without positioning. */
export function TooltipBox({content, shortcut, state, arrowX = 0}: TooltipBoxProps)
{
	return (
		// The literal "undefined" class is upstream's: tippy interpolates an unset theme option into the class list.
		<div
			className="tippy-box wf-helper tooltip text-xs shadow-md undefined"
			data-state={state}
			tabIndex={-1}
			data-animation="fade"
			role="tooltip"
			style={
			{
				maxWidth: 350,
				transitionDuration: "300ms",
			}}
			data-placement="bottom"
		>
			<div
				className="tippy-content"
				data-state={state}
				style={
				{
					transitionDuration: "300ms",
				}}
			>
				<div>{tooltipText(content, shortcut)}</div>
			</div>
			<div
				className="tippy-arrow"
				style={
				{
					position: "absolute",
					left: 0,
					transform: `translate3d(${arrowX}px, 0px, 0px)`,
				}}
			/>
		</div>
	);
}

interface TriggerRect
{
	left: number;
	width: number;
	bottom: number;
}

/** Centered-below placement clamped inside the viewport; `left` is the box center (translateX(-50%)). */
export function tooltipPosition(trigger: TriggerRect, boxWidth: number, viewportWidth: number)
{
	const half = boxWidth / 2;
	const center = trigger.left + trigger.width / 2;
	const min = VIEWPORT_PADDING + half;
	const max = viewportWidth - VIEWPORT_PADDING - half;
	return {
		top: trigger.bottom + OFFSET,
		left: Math.max(min, Math.min(center, max)),
	};
}

function canHover(): boolean
{
	return globalThis.matchMedia("(any-hover: hover) and (pointer: fine)").matches;
}

export interface TooltipControllerOptions
{
	/** Delay before showing, in ms. Hiding is immediate. */
	delay: number;
	setTimeout: (fn: () => void, ms: number) => number;
	clearTimeout: (id: number) => void;
	onChange: (shown: boolean) => void;
}

/** Tippy's hover timing: show `delay` ms after enter, hide immediately on leave (or mousedown). */
// oxlint-disable-next-line react/only-export-components -- pure hover-timing controller exported for unit tests
export function createTooltipController({delay, setTimeout, clearTimeout, onChange}: TooltipControllerOptions)
{
	let timer: number | null = null;
	const cancel = () =>
	{
		if (timer !== null)
		{
			clearTimeout(timer);
			timer = null;
		}
	};
	return {
		/** `allowed` is false while disabled or without a fine hover pointer. */
		enter(allowed: boolean)
		{
			if (!allowed)
			{
				return;
			}
			cancel();
			timer = setTimeout(() =>
			{
				timer = null;
				onChange(true);
			}, delay);
		},
		leave()
		{
			cancel();
			onChange(false);
		},
		dispose: cancel,
	};
}

interface UseTooltipOptions
{
	content: ReactNode;
	shortcut?: string;
	/** Delay before showing, in ms. Hiding is immediate. */
	delay?: number;
	disabled?: boolean;
}

interface TooltipTriggerProps
{
	onMouseEnter: () => void;
	onMouseLeave: () => void;
	onMouseDown: () => void;
	ref: RefCallback<HTMLElement>;
}

/**
 * Tippy-style tooltip without a wrapper element: spread `triggerProps` onto the trigger
 * and render `tooltip` anywhere (it portals to document.body).
 */
export function useTooltip({content, shortcut, delay = 300, disabled = false}: UseTooltipOptions)
{
	const [requested, setRequested] = useState(false);
	const shown = requested && !disabled;
	const [state, setState] = useState<TooltipState>("hidden");
	const [position, setPosition] = useState(
		{
			top: 0,
			left: 0,
		},
	);
	const triggerRef = useRef<HTMLElement | null>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	const [controller] = useState(() =>
		createTooltipController(
			{
				delay,
				setTimeout: (fn, ms) => window.setTimeout(fn, ms),
				clearTimeout: (id) =>
				{
					window.clearTimeout(id);
				},
				onChange: (visible) =>
				{
					setRequested(visible);
					if (!visible)
					{
						setState("hidden");
					}
				},
			},
		),
	);

	const show = useCallback(() =>
	{
		controller.enter(!disabled && canHover());
	}, [controller, disabled]);
	const hide = useCallback(() =>
	{
		controller.leave();
	}, [controller]);

	const ref = useCallback((element: HTMLElement | null) =>
	{
		triggerRef.current = element;
	}, []);

	useLayoutEffect(() =>
	{
		if (!shown || triggerRef.current === null || rootRef.current === null)
		{
			return;
		}
		const rect = triggerRef.current.getBoundingClientRect();
		setPosition(tooltipPosition(rect, rootRef.current.offsetWidth, window.innerWidth));
		setState("visible");
	}, [shown]);

	useEffect(() => controller.dispose, [controller]);

	const tooltip = shown
		? createPortal(
				<div
					data-tippy-root=""
					ref={rootRef}
					style={
					{
						position: "fixed",
						top: position.top,
						left: position.left,
						zIndex: 9999,
						pointerEvents: "none",
						transform: "translateX(-50%)",
					}}
				>
					<TooltipBox content={content} shortcut={shortcut} state={state} />
				</div>,
				document.body,
			)
		: null;

	return {
		triggerProps:
		{
			onMouseEnter: show,
			onMouseLeave: hide,
			onMouseDown: hide,
			ref,
		} satisfies TooltipTriggerProps,
		tooltip,
	};
}

interface TooltipProps extends UseTooltipOptions
{
	/** A single element; it receives the trigger handlers and ref directly (no wrapper). */
	children: ReactElement<ChildProps>;
}

interface ChildProps
{
	onMouseEnter?: (event: SyntheticEvent) => void;
	onMouseLeave?: (event: SyntheticEvent) => void;
	onMouseDown?: (event: SyntheticEvent) => void;
	ref?: Ref<HTMLElement>;
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null)
{
	if (typeof ref === "function")
	{
		ref(value);
	}
	else if (ref !== null && ref !== undefined)
	{
		(
			ref as
			{
				current: T | null;
			}
		).current = value;
	}
}

/** Clones its single child with the tooltip trigger props, chaining any existing handlers and ref. */
function Tooltip({children, ...options}: TooltipProps)
{
	const {triggerProps, tooltip} = useTooltip(options);
	const childProps = children.props;
	const childRef = childProps.ref;
	const triggerRef = triggerProps.ref;
	const mergedRef = useCallback(
		(element: HTMLElement | null) =>
		{
			triggerRef(element);
			assignRef(childRef, element);
		},
		[triggerRef, childRef],
	);

	return (
		<>
			{cloneElement(
				children,
				{
					onMouseEnter: (event: SyntheticEvent) =>
					{
						childProps.onMouseEnter?.(event);
						triggerProps.onMouseEnter();
					},
					onMouseLeave: (event: SyntheticEvent) =>
					{
						childProps.onMouseLeave?.(event);
						triggerProps.onMouseLeave();
					},
					onMouseDown: (event: SyntheticEvent) =>
					{
						childProps.onMouseDown?.(event);
						triggerProps.onMouseDown();
					},
					ref: mergedRef,
				},
			)}
			{tooltip}
		</>
	);
}
