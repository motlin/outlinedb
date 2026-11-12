import {useQueryClient} from "@tanstack/react-query";
import {useLayoutEffect, useRef, useState, useSyncExternalStore} from "react";
import type {MouseEvent, ReactElement} from "react";
import {createPortal} from "react-dom";
import {markCalendarTooltipSeen, useCalendarTooltipSeen} from "../hooks/use-preferences.js";
import {Button} from "./button.js";
import {FaIcon} from "./fa-icons.js";
import {tooltipPosition} from "./tooltip.js";

/** Upstream's tippy `offset: [-40, 10]`: 40px left of centered, 10px below the trigger. */
const SKIDDING = -40;

const subscribeNever = () => () =>
{
};
const onClient = () => true;
const onServer = () => false;

interface CalendarTodayControlProps
{
	/** Navigate to today's 📆 Calendar day, as the plain Today button does. */
	onToday: () => void;
	/** The plain Today button (upstream `header.controls.today`), shown once the tooltip is seen. */
	children: ReactElement;
}

/**
 * Upstream's `header.controls.today` and `header.controls.today_with_tooltip`: until root metadata
 * `calendar.tooltip_seen` is true, a calendar-day button with the "New Calendar" onboarding tooltip open below it takes
 * Today's place; trying it (the button or Try it out) or closing the tooltip sets the flag, and the plain Today shows.
 * Nothing renders while preferences load.
 */
export function CalendarTodayControl({onToday, children}: CalendarTodayControlProps)
{
	const seen = useCalendarTooltipSeen();
	if (seen === null)
	{
		return null;
	}
	return seen ? children : <CalendarOnboarding onToday={onToday} />;
}

function CalendarOnboarding({onToday}: {onToday: () => void})
{
	const queryClient = useQueryClient();
	const triggerRef = useRef<HTMLDivElement>(null);
	const boxRef = useRef<HTMLDivElement>(null);
	const [position, setPosition] = useState<
	{
		top: number;
		left: number;
	} | null>(null);
	// Tippy's `showOnCreate`: the tooltip opens on the client (portals have no server rendering).
	const mounted = useSyncExternalStore(subscribeNever, onClient, onServer);

	useLayoutEffect(() =>
	{
		if (!mounted || triggerRef.current === null || boxRef.current === null)
		{
			return;
		}
		const {top, left} = tooltipPosition(
			triggerRef.current.getBoundingClientRect(),
			boxRef.current.offsetWidth,
			window.innerWidth,
		);
		setPosition(
			{
				top,
				left: left + SKIDDING,
			},
		);
	}, [mounted]);

	const markSeen = () =>
	{
		void markCalendarTooltipSeen(queryClient);
	};
	const tryIt = () =>
	{
		markSeen();
		onToday();
	};

	return (
		<>
			{/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- upstream renders the onboarding trigger as a bare clickable div */}
			<div ref={triggerRef} onClick={tryIt} className="shape-circle iconButton lg">
				<FaIcon icon="fal:calendar-day" />
			</div>
			{mounted &&
				createPortal(
					<div
						data-tippy-root=""
						ref={boxRef}
						style={
						{
							position: "fixed",
							top: position?.top ?? 0,
							left: position?.left ?? 0,
							zIndex: 9999,
							transform: "translateX(-50%)",
							visibility: position === null ? "hidden" : "visible",
						}}
					>
						<div
							className="tippy-box wf-helper tooltip text-xs shadow-md"
							data-state="visible"
							data-calendar-tooltip=""
							role="tooltip"
							style={
							{
								whiteSpace: "normal",
							}}
							data-placement="bottom"
						>
							<div className="tippy-content" data-state="visible">
								<div className="flex flex-col gap-s p-s max-w-[296px] text-s">
									<div className="flex flex-row justify-between">
										<div className="flex flex-row gap-m items-center">
											<span className="badge h-fit !ml-0 !p-0 !px-xs !py-2xs !rounded-sm !font-normal !uppercase !bg-[var(--wf-blue-500)] !text-on-color">
												New
											</span>
											<h2>Calendar</h2>
										</div>
										{/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- upstream's close-tooltip is a bare clickable div */}
										<div
											className="close-tooltip"
											onClick={(event: MouseEvent) =>
											{
												event.stopPropagation();
												markSeen();
											}}
										>
											<FaIcon icon="fal:xmark" />
										</div>
									</div>
									<div className="leading-s text-xs">
										A daily hub for planning, notes, and reflection, so you can stay calm, clear,
										and in control.
									</div>
									<div className="flex my-xs">
										<Button variant="primary" onClick={tryIt}>
											Try it out
										</Button>
									</div>
								</div>
							</div>
						</div>
					</div>,
					document.body,
				)}
		</>
	);
}
