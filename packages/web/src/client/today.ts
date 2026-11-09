import {isFeatureOn} from "./features.js";
import {dateId} from "@outlinedb/shared";
import type {CalendarLevel} from "@outlinedb/shared";
import type {CalendarDayResponse, CalendarEnsureResponse} from "../node-types.js";
import {readJson} from "./read-json.js";

export interface NavigateToTodayDeps {
	fetch: (url: string, init?: {method?: string}) => Promise<Response>;
	/** Record that the day's short URL id resolves to `id`, so the zoom needs no lookup request. */
	seedResolved: (id: string) => unknown;
	/** Zoom the target pane to `id`: the main outline's URL, or an open pane's own zoom. */
	zoomTo: (id: string) => unknown;
	notify: (message: string, type: "info") => unknown;
	/** Edit `id` with the caret at `offset`. */
	startEditing: (id: string, offset: number) => unknown;
	/** Commit the edited text first, as upstream's Today works from anywhere, including while editing. */
	commitEdit: () => unknown;
	now: Date;
}

export type NavigateToCalendarDeps = Omit<NavigateToTodayDeps, "now">;

/** A 📆 Calendar page to zoom to: the `level` node (default the day) holding `date`. */
export interface CalendarTarget {
	date: Date;
	level?: CalendarLevel;
	/** Upstream `C9`'s `createChild`: give a new or empty node one empty child (default true). */
	createChild?: boolean;
}

/** The page's name in the notification: `YYYY-MM-DD`, `the week of YYYY-MM-DD`, `YYYY-MM` or `YYYY`. */
export function pageLabel(date: Date, level: CalendarLevel): string {
	const parts = [date.getFullYear(), date.getMonth() + 1, date.getDate()].map((n) => String(n).padStart(2, "0"));
	const count = {year: 1, month: 2, week: 3, day: 3}[level];
	const label = parts.slice(0, count).join("-");
	return level === "week" ? `the week of ${label}` : label;
}

/**
 * Upstream `C9`: the 📆 Calendar node for `target`, looked up and created
 * through the ensure route when it is missing; null when ensure is disabled
 * or the internal API is not configured.
 */
export async function findOrEnsureCalendarNode(
	{date, level = "day", createChild = true}: CalendarTarget,
	fetch: NavigateToCalendarDeps["fetch"],
): Promise<{dayId: string; firstChildId: string | null} | null> {
	const url = `/api/v1/calendar/day/${dateId("day", date)}`;
	const levelQuery = level === "day" ? [] : [`level=${level}`];
	const lookupQuery = levelQuery.length === 0 ? "" : `?${levelQuery.join("&")}`;
	const ensureParams = [...levelQuery, ...(createChild ? [] : ["createChild=false"])];
	const ensureQuery = ensureParams.length === 0 ? "" : `?${ensureParams.join("&")}`;
	const found = await fetch(`${url}${lookupQuery}`);
	if (found.ok) {
		const {id, firstChildId} = await readJson<CalendarDayResponse>(found);
		if (firstChildId === null && createChild) {
			const filled = await fetch(`${url}/ensure${ensureQuery}`, {method: "POST"});
			if (filled.ok) {
				return readJson<CalendarEnsureResponse>(filled);
			}
		}
		return {dayId: id, firstChildId};
	}
	const ensured = await fetch(`${url}/ensure${ensureQuery}`, {method: "POST"});
	return ensured.ok ? readJson<CalendarEnsureResponse>(ensured) : null;
}

/**
 * Upstream `C9` + zoom (the day strip, its arrows and month cells, and Today):
 * zoom to the 📆 Calendar node for `target`, creating it through the ensure
 * route when it is missing, and edit its first child. When ensure is disabled
 * or the internal API is not configured, it notifies instead of navigating.
 */
export async function navigateToCalendarDate(
	target: CalendarTarget,
	{fetch, seedResolved, zoomTo, notify, startEditing, commitEdit}: NavigateToCalendarDeps,
): Promise<void> {
	if (!isFeatureOn("calendar_node")) {
		return;
	}
	commitEdit();
	const node = await findOrEnsureCalendarNode(target, fetch);
	if (node === null) {
		notify(`No calendar page for ${pageLabel(target.date, target.level ?? "day")} yet`, "info");
		return;
	}
	void seedResolved(node.dayId);
	void zoomTo(node.dayId);
	if (node.firstChildId !== null) {
		startEditing(node.firstChildId, 0);
	}
}

/**
 * Upstream `navigate_to_today` (⌃T, the Today button and the left-bar Today row): zoom to today's 📆 Calendar day
 * node, creating it when it is missing, and edit its first child.
 */
export async function navigateToToday({now, ...deps}: NavigateToTodayDeps): Promise<void> {
	await navigateToCalendarDate({date: now}, deps);
}
