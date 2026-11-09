import type {ReactNode, Ref} from "react";
import {dateId, dayTimestamp, stripModel} from "@outlinedb/shared";
import {monthCellTarget, stripDropKey, stripNav} from "../calendar-strip-model.js";
import type {StripLevel} from "../calendar-strip-model.js";
import type {CalendarTarget} from "../today.js";
import {FaIcon} from "./fa-icons.js";
import {IconButton} from "./icon-button.js";

const LABEL_ROW = "h-[18px] flex items-start justify-center";
const LABEL = "text-2xs uppercase";
const DAY_CELL = "w-[28px] mobile:w-[32px] flex-shrink-0";
const DAY_CARD_LAYOUT =
	"w-[28px] mobile:w-[32px] h-[38px] mobile:h-[44px] py-2xs box-border rounded-s flex flex-col justify-center items-center cursor-pointer transition-transform";
const TODAY_CARD_COLORS = "bg-tertiary hover:bg-quaternary";
const DAY_CARD_COLORS = "!bg-secondary hover:!bg-tertiary";
const MONTH_CELL = "min-w-[28px] mobile:min-w-[32px] flex-shrink-0";
const DROP_HOVER_COLORS = "bg-tertiary border border-solid border-strong";
const MONTH_CARD_COLORS = "bg-primary hover:bg-secondary";
const MONTH_CARD_DRAGGING_COLORS = "bg-secondary hover:bg-tertiary";
const MONTH_CARD =
	"box-border rounded-s px-s min-w-[28px] mobile:min-w-[32px] h-[38px] mobile:h-[44px] flex justify-center items-center cursor-pointer transition-transform";
const SCROLLER =
	"[&::-webkit-scrollbar]:hidden [scrollbar-width:none] flex gap-m mobile:gap-ml overflow-x-auto text-s mobile:text-base pl-m desktop:cursor-grab";

function Separator({className}: {className?: string}) {
	return (
		<div className={className}>
			<div className="h-[18px] flex items-center" />
			<div className="h-[38px] mobile:h-[44px] flex justify-center items-center">
				<div className="h-[22px] border-l border-solid border-secondary" />
			</div>
		</div>
	);
}

function monthCardColors(dragging: boolean, dropHover: boolean): string {
	if (dropHover) {
		return DROP_HOVER_COLORS;
	}
	return dragging ? MONTH_CARD_DRAGGING_COLORS : MONTH_CARD_COLORS;
}

interface DayCellProps {
	ts: number;
	label: string | undefined;
	weekday: string;
	day: number;
	isToday: boolean;
	hasDot: boolean;
	/** A dragged item hovers this card. */
	dropHover: boolean;
	onClick: () => void;
}

function dayCardColors(isToday: boolean, dropHover: boolean): string {
	if (dropHover) {
		return DROP_HOVER_COLORS;
	}
	return isToday ? TODAY_CARD_COLORS : DAY_CARD_COLORS;
}

function DayCell({ts, label, weekday, day, isToday, hasDot, dropHover, onClick}: DayCellProps) {
	return (
		<div data-ts={ts} className={DAY_CELL}>
			<div className={LABEL_ROW}>{label === undefined ? null : <span className={LABEL}>{label}</span>}</div>
			{/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- upstream's strip cards are plain divs; keyboard users have ⌃T and the calendar button */}
			<div
				className={`${dayCardColors(isToday, dropHover)} ${DAY_CARD_LAYOUT}`}
				data-strip-drop="day"
				onClick={onClick}
			>
				<div className="flex flex-col items-center justify-center gap-2xs text-secondary">
					<span className="text-2xs leading-none font-light">{weekday}</span>
					<span className="text-s leading-none font-medium">{day}</span>
				</div>
				<div className={`flex items-center justify-center ${hasDot ? "opacity-1" : "opacity-0"}`}>
					<FaIcon icon="fas:circle-small" className="w-s h-s" />
				</div>
			</div>
		</div>
	);
}

export interface CalendarStripViewProps {
	level: StripLevel;
	/** The zoomed page's first day. */
	date: Date;
	now: Date;
	weekStartDay: number;
	/** Day dateIds with journal content (upstream: two or more children, or a first child with a name or note). */
	dots: ReadonlySet<number>;
	/** Whether today's day has content, for the Today card's dot. */
	todayDot?: boolean;
	onNavigate: (target: CalendarTarget) => void;
	scrollerRef?: Ref<HTMLDivElement>;
	/** The strip's outer row, which fades while a zoom runs. */
	rootRef?: Ref<HTMLDivElement>;
	/** The calendar-days button; a plain icon button when absent. */
	calendarButton?: ReactNode;
	/** An item drag is in progress (month cards darken, upstream `bg-secondary hover:bg-tertiary`). */
	dragging?: boolean;
	/** The `stripDropKey` of the card a dragged item hovers. */
	dropHoverKey?: string | null;
}

/** Upstream's day strip (`wS2`) markup for a calendar page. */
export function CalendarStripView({
	level,
	date,
	now,
	weekStartDay,
	dots,
	todayDot = false,
	onNavigate,
	scrollerRef,
	rootRef,
	calendarButton,
	dragging = false,
	dropHoverKey = null,
}: CalendarStripViewProps) {
	const model = stripModel(level, date, now, weekStartDay);
	const {prev, next} = stripNav(level, date, now, weekStartDay);
	const today = new Date(dayTimestamp(now));
	return (
		<div ref={rootRef} className="flex items-center pb-l">
			<div className="desktop:-ml-[1px] mobile:-ml-[7px] mr-s">
				<div className="h-[18px] flex items-center" />
				<div className="flex items-center mobile:gap-xs">
					<IconButton
						tooltip={prev.tooltip}
						shape="square"
						size="md"
						onClick={() => {
							onNavigate(prev.target);
						}}
					>
						<FaIcon icon="fal:chevron-left" />
					</IconButton>
					{calendarButton ?? (
						<div className="inline-flex relative">
							<IconButton shape="square" size="md">
								<FaIcon icon="fal:calendar-days" />
							</IconButton>
						</div>
					)}
					<IconButton
						tooltip={next.tooltip}
						shape="square"
						size="md"
						onClick={() => {
							onNavigate(next.target);
						}}
					>
						<FaIcon icon="fal:chevron-right" />
					</IconButton>
				</div>
			</div>
			<div className="relative flex-1 overflow-hidden">
				<div ref={scrollerRef} className={SCROLLER}>
					{model.todayCard ? (
						<>
							<div data-ts={today.getTime()} className={DAY_CELL}>
								<div className={LABEL_ROW}>
									<span className={LABEL}>Today</span>
								</div>
								{/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- upstream's strip cards are plain divs */}
								<div
									className={`${dayCardColors(true, dropHoverKey === stripDropKey({kind: "day", ts: today.getTime()}))} ${DAY_CARD_LAYOUT}`}
									data-strip-drop="day"
									onClick={() => {
										onNavigate({date: today});
									}}
								>
									<div className="flex flex-col items-center justify-center gap-2xs text-secondary">
										<span className="text-2xs leading-none font-light">
											{["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"][today.getDay()]}
										</span>
										<span className="text-s leading-none font-medium">{today.getDate()}</span>
									</div>
									<div
										className={`flex items-center justify-center ${todayDot ? "opacity-1" : "opacity-0"}`}
									>
										<FaIcon icon="fas:circle-small" className="w-s h-s" />
									</div>
								</div>
							</div>
							<Separator className="flex-shrink-0" />
						</>
					) : null}
					{model.days.map((day) => (
						<DayCell
							key={day.ts}
							ts={day.ts}
							label={day.label}
							weekday={day.weekday}
							day={day.day}
							isToday={day.isToday}
							hasDot={dots.has(dateId("day", new Date(day.ts)))}
							dropHover={dropHoverKey === stripDropKey({kind: "day", ts: day.ts})}
							onClick={() => {
								onNavigate({date: new Date(day.ts)});
							}}
						/>
					))}
					{model.separator ? <Separator /> : null}
					{model.months.map((month) => (
						<div key={`m${month.ts}`} data-ts={month.ts} className={MONTH_CELL}>
							<div className={LABEL_ROW}>
								{month.label === undefined ? null : <span className={LABEL}>{month.label}</span>}
							</div>
							{/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- upstream's strip cards are plain divs */}
							<div
								className={`${monthCardColors(dragging, dropHoverKey === stripDropKey({kind: "month", ts: month.ts}))} ${MONTH_CARD}`}
								data-strip-drop="month"
								onClick={() => {
									onNavigate(monthCellTarget(level, new Date(month.ts)));
								}}
							>
								{month.text}
							</div>
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
