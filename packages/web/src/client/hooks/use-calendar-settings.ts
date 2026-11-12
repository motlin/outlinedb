import {useQuery, useQueryClient} from "@tanstack/react-query";
import type {QueryClient} from "@tanstack/react-query";
import type {CalendarSettings, OpErrorBody} from "../../node-types.js";
import {nodeKeys} from "../node-cache.js";
import {readJson} from "../read-json.js";

const SETTINGS_URL = "/api/v1/calendar/settings";
export const CALENDAR_SETTINGS_KEY = ["calendar-settings"] as const;
const DEFAULT_SETTINGS: CalendarSettings =
{
	foundDates: true,
	dayPrefix: true,
};
const LABELS: Record<keyof CalendarSettings, string> =
{
	foundDates: "Found Dates",
	dayPrefix: "Friendly day names",
};

async function fetchSettings(): Promise<CalendarSettings>
{
	const response = await fetch(SETTINGS_URL);
	if (!response.ok)
	{
		throw new Error(`Failed to GET calendar settings: ${response.statusText}`);
	}
	return readJson<CalendarSettings>(response);
}

/** The route's `{error}` message, else the status line. */
async function errorMessage(response: Response): Promise<string>
{
	const body = await readJson<OpErrorBody>(response).catch((): OpErrorBody => ({}));
	return typeof body.error === "string" ? body.error : `${response.status} ${response.statusText}`.trim();
}

/**
 * Flip one of the 📆 Calendar root's picker settings (upstream `A10`/`_10`). The flip lands in the settings cache in
 * the same task as the click, before the write is sent, and a settings read already in flight is cancelled (its
 * cancellation reverts synchronously, so it cannot paint the old value back). Friendly day names need nothing more:
 * day titles and crumbs read the prefix from this cache. Found Dates and the picker dots are computed by the server,
 * so a Found Dates write refetches just those, the local stand-in for `calendar.settings_change`. On failure the flip
 * rolls back and the promise rejects with the server's reason, for the caller to show.
 */
export async function toggleCalendarSetting(queryClient: QueryClient, key: keyof CalendarSettings): Promise<void>
{
	void queryClient.cancelQueries(
		{
			queryKey: CALENDAR_SETTINGS_KEY,
		},
	);
	const previous = queryClient.getQueryData<CalendarSettings>(CALENDAR_SETTINGS_KEY) ?? DEFAULT_SETTINGS;
	const change =
	{
		[key]: !previous[key],
	};
	queryClient.setQueryData<CalendarSettings>(
		CALENDAR_SETTINGS_KEY,
		{
			...previous,
			...change,
		},
	);
	let settings: CalendarSettings;
	try
	{
		const response = await fetch(
			SETTINGS_URL,
			{
				method: "PUT",
				headers:
				{
					"content-type": "application/json",
				},
				body: JSON.stringify(change),
			},
		);
		if (!response.ok)
		{
			throw new Error(await errorMessage(response));
		}
		settings = await readJson<CalendarSettings>(response);
	}
	catch (error)
	{
		queryClient.setQueryData(CALENDAR_SETTINGS_KEY, previous);
		throw new Error(
			`Could not change ${LABELS[key]}: ${error instanceof Error ? error.message : String(error)}`,
			{
				cause: error,
			},
		);
	}
	queryClient.setQueryData(CALENDAR_SETTINGS_KEY, settings);
	if (key === "foundDates")
	{
		await Promise.all([
			queryClient.invalidateQueries(
				{
					queryKey: [...nodeKeys.all, "found-dates"],
				},
			),
			queryClient.invalidateQueries(
				{
					queryKey: ["calendar-days"],
				},
			),
		]);
	}
}

/**
 * Whether day titles and crumbs show Friendly day names: the settings cache once it holds a value, so a toggle shows
 * at once, else `rootDayPrefix`, the 📆 Calendar root's value from already-loaded ancestors, so a fresh page does not
 * flash the default. It only reads the cache, which the calendar strip's {@link useCalendarSettings} and a toggle
 * fill, so pages outside the calendar send no settings request.
 */
export function useDayPrefix(rootDayPrefix: boolean | null | undefined): boolean
{
	const {data} = useQuery(
		{
			queryKey: CALENDAR_SETTINGS_KEY,
			queryFn: fetchSettings,
			enabled: false,
		},
	);
	return data?.dayPrefix ?? rootDayPrefix !== false;
}

/**
 * The 📆 Calendar root's Found Dates and Friendly day names settings, and a toggle that writes the flipped value to
 * the root's metadata through {@link toggleCalendarSetting}; `onError` receives a failed write's reason.
 */
export function useCalendarSettings(onError: (error: unknown) => void):
{
	settings: CalendarSettings;
	toggle: (key: keyof CalendarSettings) => void;
}
{
	const queryClient = useQueryClient();
	const {data = DEFAULT_SETTINGS} = useQuery(
		{
			queryKey: CALENDAR_SETTINGS_KEY,
			queryFn: fetchSettings,
		},
	);
	return {
		settings: data,
		toggle: (key) =>
		{
			toggleCalendarSetting(queryClient, key).catch(onError);
		},
	};
}
