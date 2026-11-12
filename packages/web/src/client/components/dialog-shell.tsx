import {useEffect, useRef, useState} from "react";
import type {CSSProperties, ReactNode, UIEventHandler} from "react";

export const BACKDROP_CLASS =
	"fixed top-sat left-sal right-sar bottom-sab flex items-start justify-center print:hidden dialog-backdrop";

export const SCRIM_CLASS =
	"absolute inset-0 flex items-center justify-center bg-black transition-opacity duration-300 transition-base";

// Upstream WF.DomKit.Dialog box.
export const DIALOG_CLASS =
	"wf-dialog dialog-box relative mt-[10vh] p-0 !w-[calc(100%-72px)] max-w-[576px] max-h-[80vh] shrink-0 gap-l flex flex-col rounded-m border border-solid border-primary text-primary bg-primary box-border select-text overflow-x-hidden overflow-y-auto overscroll-contain transition-[transform,opacity] duration-300 transition-base desktop:shadow-[var(--wf-box-shadow-m)] mobile:max-w-full mobile:border-0 mobile:!w-[100%] [@media(max-height:700px)]:!mt-0 [@media(max-height:700px)]:!h-full [@media(max-height:700px)]:max-h-none [@media(max-height:700px)]:!rounded-none [@media(max-width:576px)]:mt-0 [@media(max-width:576px)]:!w-full [@media(max-width:576px)]:h-full [@media(max-width:576px)]:max-h-none [@media(max-width:576px)]:!rounded-none [@media(max-width:576px)]:border-none";

/** Upstream exit length: the box stays mounted this long after `open` turns false. */
const EXIT_MS = 100;

export type DialogPadding = "xl" | "lg" | "none";

/** The box class for a padding: `DIALOG_CLASS` carries `p-0`, the padded boxes swap it for `p-xl`. */
const BOX_TRANSITION = " transition-[transform,opacity] duration-300 transition-base";

function dialogClass(padding: DialogPadding, instant: boolean): string
{
	const base = padding === "none" ? DIALOG_CLASS : DIALOG_CLASS.replace(" p-0 ", " p-xl ");
	return instant ? base.replace(BOX_TRANSITION, "") : base;
}

export interface DialogShellProps
{
	open?: boolean;
	onClose: () => void;
	padding?: DialogPadding;
	/** Upstream `instant`: the box carries no transition classes (the scrim still fades). */
	instant?: boolean;
	onScroll?: UIEventHandler<HTMLDivElement>;
	children?: ReactNode;
}

/** Upstream WF.DomKit.Dialog: backdrop, scrim and box with enter after one frame and unmount 100ms after exit. */
export function DialogShell({
	open = true,
	onClose,
	padding = "xl",
	instant = false,
	onScroll,
	children,
}: DialogShellProps)
{
	const [entered, setEntered] = useState(false);
	const [mounted, setMounted] = useState(open);
	const [previousOpen, setPreviousOpen] = useState(open);
	if (open !== previousOpen)
	{
		setPreviousOpen(open);
		if (open)
		{
			setMounted(true);
		}
		else
		{
			setEntered(false);
		}
	}

	useEffect(() =>
	{
		if (!open)
		{
			const timer = window.setTimeout(() =>
			{
				setMounted(false);
			}, EXIT_MS);
			return () =>
			{
				window.clearTimeout(timer);
			};
		}
		const frame = window.requestAnimationFrame(() =>
		{
			setEntered(true);
		});
		return () =>
		{
			window.cancelAnimationFrame(frame);
		};
	}, [open]);

	const latestClose = useRef(onClose);
	useEffect(() =>
	{
		latestClose.current = onClose;
	});
	useEffect(() =>
	{
		if (!open)
		{
			return () =>
			{
			};
		}
		const onKeyDown = (event: KeyboardEvent) =>
		{
			const escape = event.key === "Escape";
			if (escape || event.key === "Enter")
			{
				event.stopPropagation();
			}
			if (escape)
			{
				latestClose.current();
			}
		};
		document.body.addEventListener("keydown", onKeyDown);
		return () =>
		{
			document.body.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	if (!mounted)
	{
		return null;
	}
	return (
		<div
			className={BACKDROP_CLASS}
			style={
			{
				zIndex: 600,
			}}
		>
			{/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- Escape closes through the body listener */}
			<div
				className={SCRIM_CLASS}
				style={
				{
					opacity: entered ? 0.2 : 0,
				}}
				onClick={onClose}
			/>
			<div
				className={dialogClass(padding, instant)}
				style={
				{
					opacity: entered ? 1 : 0,
					transform: entered ? "" : "translateY(-48px) scale(0.98)",
				}}
				onScroll={onScroll}
			>
				{children}
			</div>
		</div>
	);
}

/** Upstream WF.DomKit.DialogTitle. */
export function DialogTitle({children}: {children?: ReactNode})
{
	return (
		<h1 className="title text-l leading-xs font-bold whitespace-nowrap overflow-hidden text-ellipsis mr-3xl">
			{children}
		</h1>
	);
}

/** Upstream WF.DomKit.DialogCloseButton: a 20px cross with a 36px hover halo. */
export function DialogCloseButton({
	onClose,
	style,
	inline = false,
}: {
	onClose: () => void;
	style?: CSSProperties;
	/** Sits in the flow of a header instead of the box's top right corner (no inline style at all). */
	inline?: boolean;
})
{
	return (
		// oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- verbatim upstream markup: a plain div; Escape closes through the shell
		<div
			className="group relative w-[20px] h-[20px] flex flex-col items-center justify-center rounded-[10px] text-[12px] text-tertiary cursor-pointer"
			style={
				inline
					? undefined
					:
						{
							position: "absolute",
							top: 30,
							right: 30,
							...style,
						}
			}
			onClick={onClose}
		>
			<div className="absolute top-1/2 left-1/2 -mt-[18px] -ml-[18px] w-[36px] h-[36px] rounded-[18px] group-hover:bg-tertiary group-active:bg-tertiary" />
			<svg
				className="relative"
				width="20"
				height="20"
				viewBox="0 0 20 20"
				fill="none"
				strokeLinecap="round"
				stroke="var(--wf-text-tertiary)"
			>
				<line x1="1" y1="1" x2="19" y2="19" />
				<line x1="19" y1="1" x2="1" y2="19" />
			</svg>
		</div>
	);
}
