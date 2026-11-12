import {useQuery} from "@tanstack/react-query";
import type
{
	AppliedCalendarLayout,
	CalendarLayout,
	CalendarLayoutPreview,
	CalendarLayoutStep,
	OpErrorBody,
} from "../../node-types.js";
import type {LayoutLevels} from "../calendar-layout-model.js";
import {readJson} from "../read-json.js";

const LAYOUT_URL = "/api/v1/calendar/layout";

/** The Calendar Layout view's starting state, fetched while the view is open. */
export function useCalendarLayout(enabled: boolean): CalendarLayout | undefined
{
	const {data} = useQuery(
		{
			queryKey: ["calendar-layout"],
			enabled,
			queryFn: async () =>
			{
				const response = await fetch(LAYOUT_URL);
				if (!response.ok)
				{
					throw new Error(`Failed to load the calendar layout: ${response.statusText}`);
				}
				return readJson<CalendarLayout>(response);
			},
		},
	);
	return data;
}

/** Plan upstream's restructure for `levels` without writing anything; rejects with the server's error. */
export async function previewCalendarLayout(levels: LayoutLevels): Promise<CalendarLayoutStep[]>
{
	const response = await fetch(
		`${LAYOUT_URL}/preview`,
		{
			method: "POST",
			headers:
			{
				"content-type": "application/json",
			},
			body: JSON.stringify(
				{
					levels,
				},
			),
		},
	);
	const body = await readJson<Partial<CalendarLayoutPreview> & OpErrorBody>(response);
	if (!response.ok || body.steps === undefined)
	{
		throw new Error(body.error ?? `Failed to preview the calendar layout: ${response.statusText}`);
	}
	return body.steps;
}

async function layoutWrite(path: string, method: string, body?: unknown): Promise<AppliedCalendarLayout>
{
	const response = await fetch(
		`${LAYOUT_URL}${path}`,
		{
			method,
			headers:
			{
				"content-type": "application/json",
			},
			...(body === undefined
				? {}
				:
					{
						body: JSON.stringify(body),
					}),
		},
	);
	const result = await readJson<Partial<AppliedCalendarLayout> & OpErrorBody>(response);
	if (!response.ok || result.rootId === undefined || result.writes === undefined)
	{
		throw new Error(result.error ?? `Failed to update the calendar layout: ${response.statusText}`);
	}
	return {
		rootId: result.rootId,
		writes: result.writes,
	};
}

/** Restructure the calendar for `levels`; rejects with the server's error. */
export async function applyCalendarLayout(levels: LayoutLevels): Promise<AppliedCalendarLayout>
{
	return layoutWrite(
		"",
		"PUT",
		{
			levels,
		},
	);
}

/** Undo the last applied layout; rejects with the server's error. */
export async function undoCalendarLayout(): Promise<AppliedCalendarLayout>
{
	return layoutWrite("/undo", "POST");
}
