import {useDatePicker} from "@rehookify/datepicker";
import type {DPDay, DPDayInteger, DPPropGetter} from "@rehookify/datepicker";
import {useEffect, useLayoutEffect, useRef, useState} from "react";
import type {ReactElement, ReactNode, RefObject} from "react";
import {FaIcon} from "./fa-icons.js";
import {MenuBody} from "./flyout/menu.js";
import {MenuItem, MenuSectionHeader, MenuSeparator} from "./flyout/menu-item.js";
import {popoverBox} from "./flyout/popover-box.js";
import {IconButton} from "./icon-button.js";
import {CALENDAR_KEYS, nextCalendarFocus} from "./date-picker-keyboard.js";
import type {CalendarFocusTarget} from "./date-picker-keyboard.js";
import {Toggle} from "./toggle.js";
import type {DatePreset} from "@outlinedb/shared";
import {useCalendarEventDays} from "../hooks/use-calendar-event-days.js";
import type {CalendarMonth} from "../hooks/use-calendar-event-days.js";

export type DatePickerView = "DATE" | "MONTH" | "YEAR";

export interface DatePickerPopupProps {
	/** Upstream `MP.date`: one date in single mode, up to two in range mode. */
	selected: Date[];
	/** 0 = Sunday, 1 = Monday (Settings > Dates "Start of week"). */
	weekStartDay?: number;
	isRange?: boolean;
	/** Adds "Remove date"; upstream shows it only when the popup edits an existing pill. */
	showNoDate?: boolean;
	term?: string;
	initialView?: DatePickerView;
	/** Upstream `showControls`: false for the day strip's calendar button, which drops the Range, Format and Remove date rows. */
	showControls?: boolean;
	/** Upstream `headerText`: a section header row above the input (Move to Date...). */
	headerText?: string;
	/** Viewport position of the popup's top-left corner, before the shell's 4px margin-top. */
	position?: {left: number; top: number};
	/** Whether a day has journal content under 📆 Calendar; draws the single-mode event dot (DP10). */
	hasEvent?: (date: Date) => boolean;
	/** Overrides the single-mode day content (upstream `renderDayContent`); the strip passes {@link calendarDayContent}. */
	renderDayContent?: (day: DPDay) => ReactNode;
	/** Rows after the calendar (upstream `renderAfterCalendar`), such as the strip picker's settings toggles. */
	afterCalendar?: ReactElement[];
	/** Replaces the whole body, input and calendar included (upstream `renderContent`): the strip's Calendar Layout view. */
	content?: ReactNode;
	/** The DATE grid's month on open and after each offset change, so the caller can load its event days. */
	onVisibleMonthChange?: (visible: CalendarMonth) => void;
	onTermChange?: (term: string) => void;
	/** Enter in the date input (upstream `apply(state.date, true)`). */
	onEnter?: () => void;
	/** A day click: `[day]` in single mode; in range mode `[first]` then the sorted `[start, end]`. */
	onApply?: (dates: Date[]) => void;
	onPreset?: (preset: DatePreset) => void;
	onToggleRange?: () => void;
	onFormat?: () => void;
	onRemove?: () => void;
	onEscape?: () => void;
	onClose?: () => void;
}

/** Upstream `Pd4`: the 24x24 day cell's class template. */
function dayCellClassName(day: Pick<DPDay, "selected" | "inCurrentMonth" | "now">): string {
	const color = day.selected ? "" : day.inCurrentMonth ? (day.now ? "text-tint" : "") : "text-tertiary";
	return `date-picker-day-cell w-[24px] h-[24px] flex items-center justify-center cursor-pointer bg-transparent rounded-s relative
    border-solid border
    ${day.now ? "font-bold border-tint mobile:border-tint" : "border-transparent mobile:border-transparent"}
    ${color}
    ${day.selected ? "!text-on-color !bg-tint" : ""}`;
}

function chunk<T>(items: T[], size: number): T[][] {
	const rows: T[][] = [];
	for (let start = 0; start < items.length; start += size) {
		rows.push(items.slice(start, start + size));
	}
	return rows;
}

const HEADER_BUTTON_CLASS = `!bg-transparent hover:!bg-secondary focus:!bg-transparent focus-visible:!bg-secondary active:!bg-transparent cursor-pointer
                px-xs py-2xs rounded-s font-semibold text-s mobile:text-base
                text-primary hover:text-primary`;
const CHEVRON_BUTTON_CLASS = "hover:!bg-secondary focus:!bg-secondary active:!bg-secondary";

export type DayContent = (day: DPDay) => ReactNode;

/** Upstream `Ed4`: the plain day number with leading zeros stripped. */
function plainDayContent(day: DPDay): ReactNode {
	return day.day.replace(/^0+/u, "");
}

/** Upstream's popup `renderDayContent`: the day number over a `circle-small` dot that is visible on days with journal content. */
function dottedDayContent(hasEvent: (date: Date) => boolean): DayContent {
	return (day) => {
		const color = day.selected ? "!text-on-color" : day.inCurrentMonth && day.now ? "text-tint" : "text-tertiary";
		return (
			<div className="flex h-full w-full flex-col items-center justify-center">
				<div
					className={`
                          flex items-center justify-center flex-1
                          pt-xs
                        `}
				>
					{day.day.replace(/^0+/u, "")}
				</div>
				<div
					className={`
                          flex items-center justify-center
                          pb-xs mobile:pb-m
                          ${hasEvent(day.$date) ? "opacity-1" : "opacity-0"}
                        `}
				>
					<FaIcon icon="fas:circle-small" className={`w-s h-s ${color}`} />
				</div>
			</div>
		);
	};
}

interface ViewProps {
	datepicker: ReturnType<typeof useDatePicker>;
	onChange: (view: DatePickerView) => void;
}

/** Upstream `Ad4`: month/year header, chevrons, weekday row and the six-week day grid. */
function DateView({
	datepicker,
	onChange,
	onDateClick,
	applySelectedDateOnClick,
	renderDayContent,
}: ViewProps & {onDateClick: (date: Date) => void; applySelectedDateOnClick: boolean; renderDayContent: DayContent}) {
	const {
		data: {weekDays, calendars},
		propGetters: {dayButton, addOffset, subtractOffset},
	} = datepicker;
	const calendar = calendars[0];
	if (!calendar) {
		return null;
	}
	const {year, month, days} = calendar;
	const rows = chunk(days, 7);
	const active =
		days.find((d) => d.selected && !d.disabled) ??
		days.find((d) => d.now && !d.disabled) ??
		days.find((d) => d.inCurrentMonth && !d.disabled) ??
		days.find((d) => !d.disabled);
	return (
		<>
			<header>
				<div className="flex items-center justify-between py-s px-m mobile:p-m">
					<div className="flex flex-row items-center ml-xs">
						<button
							data-date-picker-header-button="true"
							onClick={() => {
								onChange("MONTH");
							}}
							className={HEADER_BUTTON_CLASS}
						>
							{month}
						</button>
						<button
							data-date-picker-header-button="true"
							onClick={() => {
								onChange("YEAR");
							}}
							className={HEADER_BUTTON_CLASS}
						>
							{year}
						</button>
					</div>
					<div className="flex items-center">
						<ChevronButton direction="left" props={subtractOffset({months: 1})} />
						<ChevronButton direction="right" props={addOffset({months: 1})} />
					</div>
				</div>
				<div className="grid grid-cols-7 justify-items-center text-tertiary font-semibold px-ml mb-s mobile:px-0 mobile:text-s">
					{weekDays.map((weekDay) => (
						<div className="text-center" key={`${month}-${weekDay}`}>
							{weekDay.slice(0, 2)}
						</div>
					))}
				</div>
			</header>
			<div className="pb-xs">
				{rows.map((row, rowIndex) => (
					<div
						key={row[0]?.$date.toString()}
						className="grid grid-cols-7 justify-items-center px-ml py-0 mobile:px-0"
					>
						{row.map((day, dayIndex) => {
							const reapply = applySelectedDateOnClick && day.selected && !day.disabled;
							const color = day.inCurrentMonth
								? "text-primary hover:text-primary"
								: "text-tertiary hover:text-tertiary";
							const hover = day.selected
								? "[&:hover_.date-picker-day-cell]:!bg-tint [&:focus-visible_.date-picker-day-cell]:!bg-tint"
								: "[&:hover_.date-picker-day-cell]:!bg-secondary [&:focus-visible_.date-picker-day-cell]:!bg-secondary";
							// Upstream's older datepicker build emits no aria-selected; the selected cell is styled by `!bg-tint`.
							const {"aria-selected": _ariaSelected, ...props} = dayButton(day, {
								onClick: (_event, date) => {
									if (date) {
										onDateClick(date);
									}
								},
							});
							return (
								<button
									key={day.$date.toString()}
									{...props}
									{...(reapply
										? {
												onClick: () => {
													onDateClick(day.$date);
												},
											}
										: {})}
									tabIndex={0}
									data-date-picker-day-button="true"
									data-date-picker-grid-button="true"
									data-date-picker-active-button={day === active ? "true" : undefined}
									data-keyboard-focus-enter-from-after={
										rowIndex === rows.length - 1 && dayIndex === 0 ? "true" : undefined
									}
									className={`!bg-transparent hover:!bg-transparent [&:focus:not(:hover)]:!bg-transparent active:!bg-transparent rounded-s m-0 p-0 mobile:p-m text-xs mobile:text-s ${color} ${hover}`}
								>
									<div className={dayCellClassName(day)}>{renderDayContent(day)}</div>
								</button>
							);
						})}
					</div>
				))}
			</div>
		</>
	);
}

function ChevronButton({direction, props}: {direction: "left" | "right"; props: DPPropGetter}) {
	const {role: _role, tabIndex: _tabIndex, disabled, ...rest} = props;
	return (
		<IconButton
			{...rest}
			data-date-picker-header-button="true"
			size="md"
			shape="square"
			disabled={disabled === true}
			className={CHEVRON_BUTTON_CLASS}
			onClick={(event) => {
				props.onClick?.(event);
			}}
		>
			<FaIcon icon={direction === "left" ? "fal:chevron-left" : "fal:chevron-right"} size="lg" />
		</IconButton>
	);
}

/** Upstream `Td4`: the year header and twelve month buttons. */
function MonthView({datepicker, onChange}: ViewProps) {
	const {
		data: {months, calendars},
		propGetters: {monthButton},
	} = datepicker;
	return (
		<>
			<header>
				<div className="flex items-center justify-between py-s px-m mobile:p-m">
					<button
						type="button"
						data-date-picker-header-button="true"
						className="!bg-transparent hover:!bg-secondary focus:!bg-transparent focus-visible:!bg-secondary active:!bg-transparent leading-base text-center text-s mobile:text-base py-2xs px-s cursor-pointer rounded-s text-primary hover:text-primary"
						onClick={() => {
							onChange("YEAR");
						}}
					>
						<strong>{calendars[0]?.year}</strong>
					</button>
				</div>
			</header>
			<div>
				<div className="flex flex-wrap justify-around px-m">
					{months.map((month) => (
						<button
							className={`flex-1 m-m cursor-pointer rounded-s text-xs !bg-transparent border-1 border-solid text-primary hover:text-primary
              focus:!bg-transparent focus-visible:!bg-selected active:!bg-transparent
              ${month.now ? "border-tint" : "border-transparent"} hover:!bg-selected`}
							key={month.$date.toString()}
							{...monthButton(month, {
								onClick: () => {
									onChange("DATE");
								},
							})}
							tabIndex={0}
							data-date-picker-grid-button="true"
							data-date-picker-active-button={month.active ? "true" : undefined}
						>
							{month.month.slice(0, 3)}
						</button>
					))}
				</div>
			</div>
		</>
	);
}

/** Upstream `Id4`: the decade window header, chevrons and twelve year buttons. */
function YearView({datepicker, onChange}: ViewProps) {
	const {
		data: {years},
		propGetters: {nextYearsButton, previousYearsButton, yearButton},
	} = datepicker;
	return (
		<>
			<header>
				<div className="flex items-center justify-between py-s px-m mobile:p-m">
					<strong className="flex-1 text-left text-s mobile:text-base text-primary ml-m min-w-[120px]">
						{`${years[0]?.year} - ${years.at(-1)?.year}`}
					</strong>
					<ChevronButton direction="left" props={previousYearsButton()} />
					<ChevronButton direction="right" props={nextYearsButton()} />
				</div>
			</header>
			<div>
				<div className="flex flex-wrap justify-around px-m">
					{years.map((year) => (
						<button
							className={`flex-1 m-m cursor-pointer rounded-s text-xs mobile:text-s !bg-transparent border-1 border-solid text-primary hover:text-primary
              focus:!bg-transparent focus-visible:!bg-secondary active:!bg-transparent
              ${year.now ? "border-tint" : "border-transparent"} hover:!bg-secondary`}
							key={year.$date.toString()}
							{...yearButton(year, {
								onClick: () => {
									onChange("DATE");
								},
							})}
							tabIndex={0}
							data-date-picker-grid-button="true"
							data-date-picker-active-button={year.active ? "true" : undefined}
						>
							{year.year}
						</button>
					))}
				</div>
			</div>
		</>
	);
}

const HEADER_SELECTOR = '[data-date-picker-header-button="true"]:not(:disabled)';
const DAY_SELECTOR = '[data-date-picker-day-button="true"]:not(:disabled)';
const GRID_SELECTOR = '[data-date-picker-grid-button="true"]:not(:disabled)';

/** Upstream `ZK`'s window capture keydown: arrow keys move focus between the focused scope's calendar buttons. */
function useCalendarArrowKeys(scope: RefObject<HTMLDivElement | null>): void {
	useLayoutEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			const root = scope.current;
			const active = document.activeElement;
			// Upstream `ZK`: Enter clicks the focused calendar button before the menu's Enter/exit can run.
			if (
				event.key === "Enter" &&
				root &&
				active instanceof HTMLElement &&
				root.contains(active) &&
				active.matches(`${HEADER_SELECTOR}, ${GRID_SELECTOR}`)
			) {
				event.stopImmediatePropagation();
				event.preventDefault();
				active.click();
				return;
			}
			if (!CALENDAR_KEYS.has(event.key) || !root || !(active instanceof HTMLElement) || !root.contains(active)) {
				return;
			}
			const headers = [...root.querySelectorAll<HTMLElement>(HEADER_SELECTOR)];
			const days = [...root.querySelectorAll<HTMLElement>(DAY_SELECTOR)];
			const grids = [...root.querySelectorAll<HTMLElement>(GRID_SELECTOR)];
			const counts = {headers: headers.length, grid: grids.length, days: days.length};
			const at = (list: HTMLElement[]) => list.indexOf(active);
			let target: CalendarFocusTarget | undefined;
			if (at(headers) >= 0) {
				target = nextCalendarFocus("header", at(headers), event.key, counts);
			} else if (at(days) >= 0) {
				target = nextCalendarFocus("day", at(days), event.key, counts);
			} else if (at(grids) >= 0) {
				const rects = grids.map((button) => {
					const rect = button.getBoundingClientRect();
					return {top: rect.top, centerX: rect.left + rect.width / 2};
				});
				target = nextCalendarFocus("grid", at(grids), event.key, counts, rects);
			} else {
				target = nextCalendarFocus("other", 0, event.key, counts);
			}
			const element = target && (target.kind === "header" ? headers : grids)[target.index];
			if (element) {
				event.stopImmediatePropagation();
				event.preventDefault();
				element.focus();
			}
		};
		window.addEventListener("keydown", onKeyDown, true);
		return () => {
			window.removeEventListener("keydown", onKeyDown, true);
		};
	}, [scope]);
}

const DAY_INTEGERS: readonly DPDayInteger[] = [0, 1, 2, 3, 4, 5, 6];

function toDayInteger(weekStartDay: number): DPDayInteger {
	return DAY_INTEGERS.find((day) => day === weekStartDay) ?? 0;
}

/** Upstream `ZK` + `Z82`: the `data-keyboard-focus-scope` calendar with its DATE/MONTH/YEAR views (`_d4` single, `kd4` range). */
function Calendar({
	selected,
	weekStartDay,
	isRange,
	initialView,
	renderDayContent,
	onApply,
	onVisibleMonthChange,
}: {
	selected: Date[];
	weekStartDay: number;
	isRange: boolean;
	initialView: DatePickerView;
	renderDayContent: DayContent;
	onApply: (dates: Date[]) => void;
	onVisibleMonthChange?: ((visible: CalendarMonth) => void) | undefined;
}) {
	const [view, setView] = useState<DatePickerView>(initialView);
	const scope = useRef<HTMLDivElement>(null);
	const viewRoot = useRef<HTMLDivElement>(null);
	const previousView = useRef(view);
	useCalendarArrowKeys(scope);
	// Upstream `Z82`: a view switch focuses the new view's active button, else its first focusable.
	useLayoutEffect(() => {
		if (previousView.current === view) {
			return;
		}
		previousView.current = view;
		const root = viewRoot.current;
		const target =
			root?.querySelector<HTMLElement>('[data-date-picker-active-button="true"]:not(:disabled)') ??
			root?.querySelector<HTMLElement>('button:not(:disabled), [tabindex]:not([tabindex="-1"])');
		target?.focus();
	}, [view]);
	const [rangeStart, setRangeStart] = useState<Date | undefined>(undefined);
	const anchor = selected[0];
	const [offsetDate, setOffsetDate] = useState<Date>(() => anchor ?? new Date());
	const [previousAnchor, setPreviousAnchor] = useState(anchor?.getTime());
	// Upstream re-centres the grid on the selected date whenever it changes.
	if (previousAnchor !== anchor?.getTime()) {
		setPreviousAnchor(anchor?.getTime());
		if (anchor) {
			setOffsetDate(anchor);
		}
	}
	const visibleYear = offsetDate.getFullYear();
	const visibleMonth = offsetDate.getMonth() + 1;
	useEffect(() => {
		onVisibleMonthChange?.({year: visibleYear, month: visibleMonth});
	}, [onVisibleMonthChange, visibleYear, visibleMonth]);
	const datepicker = useDatePicker({
		selectedDates: selected,
		onDatesChange: () => {},
		offsetDate,
		onOffsetChange: setOffsetDate,
		locale: {locale: "en-GB", monthName: "short", weekday: "short"},
		calendar: {startDay: toDayInteger(weekStartDay)},
		years: {mode: "decade", numberOfYears: 12, step: 10},
		...(isRange ? {dates: {mode: "range", selectSameDate: true}} : {}),
	});
	const onDateClick = (date: Date) => {
		if (!isRange) {
			onApply([date]);
		} else if (rangeStart) {
			onApply([rangeStart, date].toSorted((a, b) => a.getTime() - b.getTime()));
		} else {
			setRangeStart(date);
			onApply([date]);
		}
	};
	return (
		<div ref={scope} data-keyboard-focus-scope="true" className="flex flex-col w-[220px]">
			{/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- verbatim upstream markup: mousedown keeps focus in the date input */}
			<section
				onMouseDown={(event) => {
					event.preventDefault();
				}}
			>
				<div ref={viewRoot} className="leading-m text-xs">
					{view === "YEAR" && <YearView datepicker={datepicker} onChange={setView} />}
					{view === "MONTH" && <MonthView datepicker={datepicker} onChange={setView} />}
					{view === "DATE" && (
						<DateView
							datepicker={datepicker}
							onChange={setView}
							onDateClick={onDateClick}
							applySelectedDateOnClick={!isRange}
							renderDayContent={isRange ? plainDayContent : renderDayContent}
						/>
					)}
				</div>
			</section>
		</div>
	);
}

// Upstream builds menu rows with `${itemClassName}`, so the presets group (no itemClassName) carries a literal "undefined".
const PRESET_ROW_CLASS = "undefined";
const CONTROL_ROW_CLASS = "[&_.menuItemIcon]:w-[26px] mobile:[&_.menuItemIcon]:w-[54px]";

function noEvents(): boolean {
	return false;
}

function ignoreDates(): void {}

const PRESETS: {label: string; preset: DatePreset; icon: "fal:sun-bright" | "fal:moon" | "fal:calendar-week"}[] = [
	{label: "Today", preset: "today", icon: "fal:sun-bright"},
	{label: "Tomorrow", preset: "tomorrow", icon: "fal:moon"},
	{label: "Next week", preset: "next week", icon: "fal:calendar-week"},
];

const INPUT_CLASS = "date-popup-input bg-inherit w-full border-0 text-primary placeholder:text-tertiary";

/** Upstream's `!!` / pill date popup (`gP.for`): input row, presets, calendar, then Range / Format / Remove date. */
export function DatePickerPopup({
	selected,
	weekStartDay = 0,
	isRange = false,
	showNoDate = false,
	term = "",
	initialView = "DATE",
	showControls = true,
	headerText,
	position,
	hasEvent = noEvents,
	renderDayContent,
	afterCalendar,
	content,
	onVisibleMonthChange,
	onTermChange,
	onEnter,
	onApply = ignoreDates,
	onPreset,
	onToggleRange,
	onFormat,
	onRemove,
	onEscape,
	onClose,
}: DatePickerPopupProps) {
	const box = popoverBox({minWidth: 0, maxWidth: 240, offset: [0, 0]});
	// Upstream `ZK`: Escape closes in the capture phase wherever focus sits, so the caret is restored.
	// A replaced body (upstream `renderContent`, the Calendar Layout view) lets Escape fall through to the app.
	const escapeHandler = content === undefined ? onEscape : undefined;
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape" && escapeHandler) {
				event.stopImmediatePropagation();
				event.preventDefault();
				escapeHandler();
			}
		};
		window.addEventListener("keydown", onKeyDown, true);
		return () => {
			window.removeEventListener("keydown", onKeyDown, true);
		};
	}, [escapeHandler]);
	const input = (
		<input
			name="date-picker-input"
			type="text"
			// oxlint-disable-next-line jsx-a11y/no-autofocus -- upstream focuses the date input as soon as the popup opens
			autoFocus
			placeholder="Type date"
			className={INPUT_CLASS}
			value={term}
			onKeyDown={(event) => {
				if (event.key === "Enter" && !event.nativeEvent.isComposing) {
					onEnter?.();
					event.preventDefault();
					event.stopPropagation();
				}
			}}
			onChange={(event) => {
				onTermChange?.(event.currentTarget.value);
			}}
		/>
	);
	// MenuBody walks its direct children for MenuItems, so the rows are one flat keyed array, never a Fragment.
	const rows: ReactNode[] = [
		...(headerText === undefined
			? []
			: [<MenuSectionHeader key="date-popup-header">{headerText}</MenuSectionHeader>]),
		<div key="date-popup-input" className="flex items-center px-l py-m bg-secondary">
			{input}
		</div>,
		<MenuSeparator key="date-popup-separator-input" style={{margin: 0}} />,
		...PRESETS.map(({label, preset, icon}) => (
			<MenuItem
				key={preset}
				label={label}
				icon={icon}
				className={PRESET_ROW_CLASS}
				onSelect={() => {
					onPreset?.(preset);
				}}
			/>
		)),
		<MenuSeparator key="date-popup-separator-presets" style={{margin: 0}} />,
		<Calendar
			key="date-popup"
			selected={selected}
			weekStartDay={weekStartDay}
			isRange={isRange}
			initialView={initialView}
			renderDayContent={renderDayContent ?? dottedDayContent(hasEvent)}
			onApply={onApply}
			onVisibleMonthChange={onVisibleMonthChange}
		/>,
		...(afterCalendar ?? []),
		...(showControls
			? [
					<MenuSeparator key="date-popup-separator-controls" style={{margin: 0}} />,
					<MenuItem
						key="date-popup-range"
						label="Range"
						icon={<Toggle on={isRange} />}
						className={CONTROL_ROW_CLASS}
						onSelect={() => {
							onToggleRange?.();
							return true;
						}}
					/>,
					<MenuItem
						key="date-popup-format"
						label="Format"
						icon="fal:gear"
						className={CONTROL_ROW_CLASS}
						onSelect={onFormat}
					/>,
					...(showNoDate
						? [
								<MenuItem
									key="date-popup-remove"
									label="Remove date"
									icon="fal:ban"
									className={CONTROL_ROW_CLASS}
									onSelect={onRemove}
								/>,
							]
						: []),
				]
			: []),
	];
	return (
		<div
			className={`${box.className} absolute flyout menu [&.menu]:py-0`}
			style={{...box.style, ...(position ? {left: position.left, top: position.top} : {})}}
		>
			<MenuBody
				keyboardMode
				focusNavigation
				cyclicNavigation
				initialSelect={-1}
				selectOnTab={false}
				exit={onClose}
			>
				{content ?? rows}
			</MenuBody>
		</div>
	);
}

/**
 * The popup with event dots for the visible month (upstream DP10). Holding the month query here, rather than in the
 * hook of every row that can open a picker, keeps a closed picker from costing each row a query subscription.
 */
export function CalendarDatePickerPopup(props: Omit<DatePickerPopupProps, "hasEvent" | "onVisibleMonthChange">) {
	const {hasEvent, onVisibleMonthChange} = useCalendarEventDays();
	return <DatePickerPopup {...props} hasEvent={hasEvent} onVisibleMonthChange={onVisibleMonthChange} />;
}
