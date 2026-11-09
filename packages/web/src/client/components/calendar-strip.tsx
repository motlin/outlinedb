import {useQuery, useQueryClient} from "@tanstack/react-query";
import {useEffect, useLayoutEffect, useRef, useState} from "react";
import {createPortal} from "react-dom";
import {useStableNavigate} from "../hooks/use-stable-navigate.js";
import {dateId, dayTimestamp, formatPillLabel, guessDates, presetDate, stripModel} from "@outlinedb/shared";
import type {CalendarLevel, DatePreset} from "@outlinedb/shared";
import type {CalendarDotsResponse, NodeResponse} from "../../node-types.js";
import {prefetchCalendarDays, useCalendarEventDays} from "../hooks/use-calendar-event-days.js";
import {
	applyCalendarLayout,
	previewCalendarLayout,
	undoCalendarLayout,
	useCalendarLayout,
} from "../hooks/use-calendar-layout.js";
import {useCalendarSettings} from "../hooks/use-calendar-settings.js";
import {activeCommandRegistry} from "../hooks/use-global-keymap.js";
import {useNavigateToCalendarDate} from "../hooks/use-navigate-to-today.js";
import {fetchChildren, sendBlockMoves, useMoveNodes} from "../hooks/use-nodes.js";
import {useDateSettings} from "../hooks/use-preferences.js";
import {goToNode} from "../navigation.js";
import {readJson} from "../read-json.js";
import {useOutlineStore} from "../stores/outline.js";
import {findOrEnsureCalendarNode} from "../today.js";
import type {CalendarTarget} from "../today.js";
import {captureOutlineView, runInUndoBatch} from "../undo-batch.js";
import {
	STRIP_DROP_EVENT,
	attachDragScroll,
	attachOutsideDismiss,
	attachDropAutoscroll,
	stripPage,
	runStripDrop,
	scrollStripOnMount,
} from "../calendar-strip-model.js";
import type {StripDropDetail, StripLevel} from "../calendar-strip-model.js";
import {attachStripZoomFade} from "../calendar-strip-zoom-fade.js";
import {CalendarStripView} from "./calendar-strip-view.js";
import {layoutAppliedMessage, layoutPreviewMessage} from "../calendar-layout-model.js";
import {CalendarLayoutView} from "./calendar-layout-view.js";
import {calendarDayContent, calendarPickerSettingsRows, stripPickerSelection} from "./calendar-picker-settings.js";
import {DatePickerPopup} from "./date-picker-popup.js";
import {FaIcon} from "./fa-icons.js";
import {IconButton} from "./icon-button.js";
import {LoadingSpinner} from "./loading-spinner.js";

async function fetchDots(from: number, to: number): Promise<number[]> {
	const response = await fetch(`/api/v1/calendar/dots?from=${from}&to=${to}`);
	if (!response.ok) {
		throw new Error(`Failed to fetch calendar dots: ${response.statusText}`);
	}
	return (await readJson<CalendarDotsResponse>(response)).dateIds;
}

/** The day dateIds in `[from, to]` with journal content; empty until loaded or when `from` is null. */
function useCalendarDots(from: number | null, to: number | null): ReadonlySet<number> {
	const {data} = useQuery({
		queryKey: ["calendar-dots", from, to],
		queryFn: async () => (from === null || to === null ? [] : fetchDots(from, to)),
		enabled: from !== null && to !== null,
	});
	return new Set(data);
}

/**
 * Upstream's `GuiCalendar.CalendarButton` (`v10`): the calendar-days button opens the
 * date picker without its input row or controls, with Found Dates dots, the
 * Found Dates / Friendly day names toggles and the Calendar Layout row, which
 * swaps the body for the layout view; picking a day zooms to it. Update Layout
 * applies the restructure (with an Undo action) when the server enables it,
 * and otherwise only previews it.
 */
function CalendarButton({date, onSelect}: {date: Date; onSelect: (day: Date) => void}) {
	const anchor = useRef<HTMLDivElement | null>(null);
	const popup = useRef<HTMLDivElement | null>(null);
	const [open, setOpen] = useState<{left: number; top: number} | null>(null);
	const [term, setTerm] = useState("");
	const {dateFormat, weekStartDay} = useDateSettings();
	const eventDays = useCalendarEventDays({found: true});
	const [layoutView, setLayoutView] = useState(false);
	const layout = useCalendarLayout(layoutView);
	const showAppMessage = useOutlineStore((state) => state.showAppMessage);
	const openSettings = useOutlineStore((state) => state.openSettings);
	const queryClient = useQueryClient();
	const reportError = (error: unknown) => {
		showAppMessage(error instanceof Error ? error.message : String(error), {type: "failure"});
	};
	const calendarSettings = useCalendarSettings(reportError);
	const shownYear = date.getFullYear();
	const shownMonth = date.getMonth() + 1;
	const prefetchDots = () => {
		void prefetchCalendarDays(queryClient, {year: shownYear, month: shownMonth}, {found: true});
	};
	// The picker opens on the strip's month: load its dots while the button shows, so they paint with the grid.
	useEffect(() => {
		void prefetchCalendarDays(queryClient, {year: shownYear, month: shownMonth}, {found: true});
	}, [queryClient, shownYear, shownMonth]);
	/**
	 * Apply the layout and offer Undo when anything changed; everything it may have moved refetches in the background,
	 * so the button's spinner ends as soon as the server has pushed.
	 */
	const applyLayout = async (levels: Parameters<typeof applyCalendarLayout>[0]) => {
		const {writes} = await applyCalendarLayout(levels);
		void queryClient.invalidateQueries();
		const undo = async () => {
			try {
				await undoCalendarLayout();
				void queryClient.invalidateQueries();
				showAppMessage("Calendar layout restored.", {timeout: 5000});
			} catch (error) {
				reportError(error);
			}
		};
		showAppMessage(
			layoutAppliedMessage(writes),
			writes === 0
				? {timeout: 5000}
				: {
						actions: [
							{
								label: "Undo",
								run: () => {
									void undo();
								},
							},
						],
					},
		);
	};
	const close = () => {
		setOpen(null);
		setTerm("");
		setLayoutView(false);
	};
	const isOpen = open !== null;
	// Upstream closes the picker on a pointerdown outside it; the button itself toggles it in its click handler.
	useEffect(() => {
		if (!isOpen) {
			return noCleanup;
		}
		return attachOutsideDismiss(
			document,
			(target) =>
				target instanceof Node &&
				((anchor.current?.contains(target) ?? false) || (popup.current?.contains(target) ?? false)),
			() => {
				setOpen(null);
				setTerm("");
				setLayoutView(false);
			},
		);
	}, [isOpen]);
	const select = (day: Date | undefined) => {
		close();
		if (day !== undefined) {
			onSelect(day);
		}
	};
	return (
		// oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- upstream wraps the IconButton, which handles the keyboard
		<div
			ref={anchor}
			className="inline-flex relative"
			onPointerEnter={prefetchDots}
			onClick={(event) => {
				event.stopPropagation();
				// Clicks inside the portaled popup bubble here through the React tree; only the button's own toggle.
				if (!(event.target instanceof Node && (anchor.current?.contains(event.target) ?? false))) {
					return;
				}
				if (open !== null) {
					close();
					return;
				}
				const rect = anchor.current?.getBoundingClientRect();
				if (rect) {
					setOpen({left: rect.left + globalThis.scrollX, top: rect.bottom + globalThis.scrollY});
				}
			}}
		>
			<IconButton shape="square" size="md">
				<FaIcon icon="fal:calendar-days" />
			</IconButton>
			{open === null
				? null
				: createPortal(
						<div ref={popup} className="contents">
							<DatePickerPopup
								selected={stripPickerSelection(
									term,
									date,
									guessDates(term, {dateFormat, weekStartDay}),
								)}
								weekStartDay={weekStartDay}
								showControls={false}
								renderDayContent={calendarDayContent(eventDays.hasEvent)}
								afterCalendar={calendarPickerSettingsRows(
									calendarSettings.settings,
									calendarSettings.toggle,
									() => {
										setLayoutView(true);
									},
								)}
								content={
									layoutView ? (
										layout === undefined ? (
											<div className="p-ml">
												<LoadingSpinner size="small" />
											</div>
										) : (
											<CalendarLayoutView
												layout={layout}
												onCancel={() => {
													setLayoutView(false);
												}}
												onDateFormat={() => {
													close();
													openSettings("Dates");
												}}
												onUpdate={async (levels) => {
													try {
														if (layout.applyEnabled) {
															await applyLayout(levels);
														} else {
															showAppMessage(
																layoutPreviewMessage(
																	await previewCalendarLayout(levels),
																),
															);
														}
														close();
													} catch (error) {
														reportError(error);
													}
												}}
											/>
										)
									) : undefined
								}
								onVisibleMonthChange={eventDays.onVisibleMonthChange}
								term={term}
								position={open}
								onTermChange={setTerm}
								onEnter={() => {
									select(guessDates(term, {dateFormat, weekStartDay})[0]);
								}}
								onApply={(dates) => {
									select(dates[0]);
								}}
								onPreset={(preset: DatePreset) => {
									select(presetDate(preset, {weekStartDay}));
								}}
								onEscape={close}
								onClose={close}
							/>
						</div>,
						document.body,
					)}
		</div>
	);
}

function noCleanup(): void {}

function isStripDrop(event: Event): event is CustomEvent<StripDropDetail> {
	return event instanceof CustomEvent;
}

/**
 * Upstream's strip drop target (`WF.Moving.target`): a bullet drag released over a card moves its items to the end
 * of that page, creating it when missing, and toasts View and Undo; near an edge the strip autoscrolls.
 */
function useStripDrop(scroller: HTMLDivElement | null, level: StripLevel): void {
	const queryClient = useQueryClient();
	const navigate = useStableNavigate();
	const {mutate: moveNodes} = useMoveNodes();
	const {dateFormat} = useDateSettings();
	useEffect(() => {
		if (scroller === null) {
			return noCleanup;
		}
		const onDrop = (event: Event) => {
			if (!isStripDrop(event)) {
				return;
			}
			const {itemIds, cell} = event.detail;
			const store = useOutlineStore.getState();
			void runStripDrop({
				items: itemIds,
				level,
				cell,
				dayName: (date) =>
					formatPillLabel(
						{startYear: date.getFullYear(), startMonth: date.getMonth() + 1, startDay: date.getDate()},
						{dateFormat},
					),
				ensure: async (target) => {
					const node = await findOrEnsureCalendarNode(target, globalThis.fetch);
					return node === null
						? null
						: {id: node.dayId, childCount: (await fetchChildren(node.dayId)).length};
				},
				clearSelection: store.clearItemSelection,
				moveNodes: (moves) => {
					void runInUndoBatch(captureOutlineView, async () => sendBlockMoves(moves, moveNodes)).then(
						async () => queryClient.invalidateQueries({queryKey: ["calendar-dots"]}),
					);
				},
				showToast: ({text, timeout, actions, type}) => {
					useOutlineStore.getState().showAppMessage(text, {timeout, actions, type});
				},
				view: (id) => {
					goToNode(navigate, id);
				},
				undo: () => {
					activeCommandRegistry().undo?.execute({items: [], zoomedId: null});
				},
			});
		};
		scroller.addEventListener(STRIP_DROP_EVENT, onDrop);
		const detachAutoscroll = attachDropAutoscroll(
			scroller,
			() => useOutlineStore.getState().draggingIds.length > 0,
		);
		return () => {
			scroller.removeEventListener(STRIP_DROP_EVENT, onDrop);
			detachAutoscroll();
		};
	}, [scroller, level, dateFormat, moveNodes, navigate, queryClient]);
}

/** A strip page's level and first day. */
interface StripPage {
	level: CalendarLevel;
	date: Date;
}

function StripForPage({level, date}: StripPage) {
	const [now] = useState(() => new Date());
	const {weekStartDay} = useDateSettings();
	const navigateTo = useNavigateToCalendarDate();
	const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
	const model = stripModel(level, date, now, weekStartDay);
	const firstDay = model.days[0];
	const lastDay = model.days.at(-1);
	const dots = useCalendarDots(
		firstDay ? dateId("day", new Date(firstDay.ts)) : null,
		lastDay ? dateId("day", new Date(lastDay.ts)) : null,
	);
	const todayId = model.todayCard ? dateId("day", now) : null;
	const todayDots = useCalendarDots(todayId, todayId);
	const pageTs = dayTimestamp(date);
	const todayTs = dayTimestamp(now);

	// Like upstream, this re-runs only when the zoomed page changes.
	useLayoutEffect(() => {
		if (scroller !== null) {
			scrollStripOnMount(scroller, {level, pageTs, todayTs});
		}
	}, [scroller, level, pageTs, todayTs]);

	useEffect(() => (scroller === null ? undefined : attachDragScroll(scroller, document)), [scroller]);
	useStripDrop(scroller, level);
	const [stripRoot, setStripRoot] = useState<HTMLDivElement | null>(null);
	useEffect(() => (stripRoot === null ? undefined : attachStripZoomFade(stripRoot, document)), [stripRoot]);
	const dragging = useOutlineStore((state) => state.draggingIds.length > 0);
	const dropHoverKey = useOutlineStore((state) => state.stripDropKey);

	const onNavigate = (target: CalendarTarget) => {
		void navigateTo(target);
	};
	return (
		<CalendarStripView
			level={level}
			date={date}
			now={now}
			weekStartDay={weekStartDay}
			dots={dots}
			todayDot={todayId !== null && todayDots.has(todayId)}
			onNavigate={onNavigate}
			scrollerRef={setScroller}
			rootRef={setStripRoot}
			dragging={dragging}
			dropHoverKey={dropHoverKey}
			calendarButton={
				<CalendarButton
					date={date}
					onSelect={(day) => {
						onNavigate({date: day});
					}}
				/>
			}
		/>
	);
}

/**
 * The day strip under a zoomed 📆 Calendar day, week, month or year page's title
 * (upstream `ui.item.note.afterend.calendar_navigation`): arrows, the calendar
 * button, and the scrollable day and month cells, each zooming to its page.
 * Other nodes render nothing.
 */
export function CalendarStrip({node}: {node: Pick<NodeResponse, "id" | "calendar">}) {
	const page = stripPage(node.calendar);
	return page === null ? null : <StripForPage key={node.id} level={page.level} date={page.date} />;
}
