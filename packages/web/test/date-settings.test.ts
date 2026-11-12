import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import
{
	DEFAULT_DATE_SETTINGS,
	dateFormatOptions,
	resolveDateSettings,
	timeFormatOptions,
	weekStartPatch,
} from "../src/client/date-settings.js";
import
{
	EMPTY_PREFERENCES,
	fetchPreferences,
	preferenceKeys,
	setPreferences,
	usePreferences,
} from "../src/client/hooks/use-preferences.js";
import type {Preferences, PreferencesState} from "../src/client/hooks/use-preferences.js";

const NOT_CONFIGURED = "Workflowy internal API is not configured";

let requests:
{
	url: string;
	method: string;
	body: string | undefined;
}[];
let responses: Response[];

beforeEach(() =>
{
	requests = [];
	responses = [];
	vi.stubGlobal("fetch", async (url: string, init?: RequestInit) =>
	{
		requests.push(
			{
				url,
				method: init?.method ?? "GET",
				body: typeof init?.body === "string" ? init.body : undefined,
			},
		);
		return Promise.resolve(responses.shift() ?? Response.json(EMPTY_PREFERENCES));
	});
});

afterEach(() =>
{
	vi.unstubAllGlobals();
});

const ACCOUNT: Preferences =
{
	...EMPTY_PREFERENCES,
	dateFormat: "YYYY-MM-DD ddd",
	timeFormat: "HH:mm",
	weekStartDay: 1,
};

function seeded(preferences: Preferences = EMPTY_PREFERENCES): QueryClient
{
	const queryClient = new QueryClient(
		{
			defaultOptions:
			{
				mutations:
				{
					retry: false,
				},
				queries:
				{
					retry: false,
				},
			},
		},
	);
	queryClient.setQueryData<PreferencesState>(
		preferenceKeys.all,
		{
			preferences,
			available: true,
			error: null,
		},
	);
	return queryClient;
}

function captureState(queryClient: QueryClient): ReturnType<typeof usePreferences>
{
	const captured: ReturnType<typeof usePreferences>[] = [];
	function Probe()
	{
		captured.push(usePreferences());
		return null;
	}
	renderToStaticMarkup(
		createElement(
			QueryClientProvider,
			{
				client: queryClient,
			},
			createElement(Probe),
		),
	);
	const state = captured.at(0);
	if (state === undefined)
	{
		throw new Error("state not captured");
	}
	return state;
}

describe("resolveDateSettings", () =>
{
	it("falls back to upstream defaults for unset preferences", () =>
	{
		expect(
			resolveDateSettings(
				{
					dateFormat: null,
					timeFormat: null,
					weekStartDay: null,
				},
			),
		).toStrictEqual(
			{
				dateFormat: "ddd, MMM D",
				timeFormat: "h:mma",
				weekStartDay: 0,
			},
		);
	});

	it("treats empty stored formats as unset", () =>
	{
		expect(
			resolveDateSettings(
				{
					dateFormat: "",
					timeFormat: "",
					weekStartDay: null,
				},
			),
		).toStrictEqual(
			{
				dateFormat: "ddd, MMM D",
				timeFormat: "h:mma",
				weekStartDay: 0,
			},
		);
	});

	it("passes stored preferences through", () =>
	{
		expect(
			resolveDateSettings(
				{
					dateFormat: "YYYY-MM-DD ddd",
					timeFormat: "HH:mm",
					weekStartDay: 1,
				},
			),
		).toStrictEqual(
			{
				dateFormat: "YYYY-MM-DD ddd",
				timeFormat: "HH:mm",
				weekStartDay: 1,
			},
		);
	});

	it("exposes the upstream defaults", () =>
	{
		expect(DEFAULT_DATE_SETTINGS).toStrictEqual(
			{
				dateFormat: "ddd, MMM D",
				timeFormat: "h:mma",
				weekStartDay: 0,
			},
		);
	});
});

describe("Settings > Dates options", () =>
{
	const now = new Date(2026, 9, 1, 14, 40);

	it("labels each short date format with today rendered in it", () =>
	{
		expect(dateFormatOptions(now)).toStrictEqual([
			{
				value: "ddd, MMM D",
				label: "Thu, Oct 1",
			},
			{
				value: "ddd, MMM D, YYYY",
				label: "Thu, Oct 1, 2026",
			},
			{
				value: "dddd, MMMM Do",
				label: "Thursday, October 1st",
			},
			{
				value: "dddd [the] Do [of] MMMM",
				label: "Thursday the 1st of October",
			},
			{
				value: "Do [of] MMMM",
				label: "1st of October",
			},
			{
				value: "MMMM Do, YYYY",
				label: "October 1st, 2026",
			},
			{
				value: "MM/DD/YYYY",
				label: "10/01/2026",
			},
			{
				value: "DD/MM/YYYY",
				label: "01/10/2026",
			},
			{
				value: "DD.MM.YYYY",
				label: "01.10.2026",
			},
			{
				value: "YYYY-MM-DD",
				label: "2026-10-01",
			},
		]);
	});

	it("labels each time format with the current time", () =>
	{
		expect(timeFormatOptions(now)).toStrictEqual([
			{
				value: "h:mma",
				label: "2:40pm",
			},
			{
				value: "HH:mm",
				label: "14:40",
			},
		]);
	});

	it("removes weekStartDay for Sunday and sets 1 for Monday", () =>
	{
		expect(
			{
				sunday: weekStartPatch(0),
				monday: weekStartPatch(1),
			},
		).toStrictEqual(
			{
				sunday:
				{
					weekStartDay: null,
				},
				monday:
				{
					weekStartDay: 1,
				},
			},
		);
	});
});

describe("preferences hook", () =>
{
	it("issues one PATCH with only the changed key", async () =>
	{
		const queryClient = seeded();
		responses.push(
			Response.json(
				{
					...EMPTY_PREFERENCES,
					dateFormat: "YYYY-MM-DD ddd",
				},
			),
		);
		await captureState(queryClient).setPreferences(
			{
				dateFormat: "YYYY-MM-DD ddd",
			},
		);
		expect(requests).toStrictEqual([
			{
				url: "/api/v1/preferences",
				method: "PATCH",
				body: '{"dateFormat":"YYYY-MM-DD ddd"}',
			},
		]);
	});

	it("sends weekStartDay null when Sunday is chosen", async () =>
	{
		const queryClient = seeded(ACCOUNT);
		responses.push(
			Response.json(
				{
					...ACCOUNT,
					weekStartDay: null,
				},
			),
		);
		await setPreferences(queryClient, weekStartPatch(0));
		expect(
			{
				requests,
				cache: queryClient.getQueryData(preferenceKeys.all),
			},
		).toStrictEqual(
			{
				requests: [
					{
						url: "/api/v1/preferences",
						method: "PATCH",
						body: '{"weekStartDay":null}',
					},
				],
				cache:
				{
					preferences:
					{
						...ACCOUNT,
						weekStartDay: null,
					},
					available: true,
					error: null,
				},
			},
		);
	});

	it("applies the change optimistically before the server answers", async () =>
	{
		const queryClient = seeded(ACCOUNT);
		let seen: unknown;
		vi.stubGlobal("fetch", async () =>
		{
			seen = queryClient.getQueryData(preferenceKeys.all);
			return Promise.resolve(
				Response.json(
					{
						...ACCOUNT,
						timeFormat: "h:mma",
					},
				),
			);
		});
		await setPreferences(
			queryClient,
			{
				timeFormat: "h:mma",
			},
		);
		expect(seen).toStrictEqual(
			{
				preferences:
				{
					...ACCOUNT,
					timeFormat: "h:mma",
				},
				available: true,
				error: null,
			},
		);
	});

	it("rolls back a failed PATCH", async () =>
	{
		const queryClient = seeded(ACCOUNT);
		responses.push(
			new Response(
				null,
				{
					status: 500,
				},
			),
		);
		await expect(
			setPreferences(
				queryClient,
				{
					timeFormat: "h:mma",
				},
			),
		).rejects.toThrow("Failed to update preferences: 500");
		expect(queryClient.getQueryData(preferenceKeys.all)).toStrictEqual(
			{
				preferences: ACCOUNT,
				available: true,
				error: null,
			},
		);
	});

	it("reads the account's date settings", () =>
	{
		const state = captureState(seeded(ACCOUNT));
		expect(
			{
				available: state.available,
				settings: state.dateSettings,
			},
		).toStrictEqual(
			{
				available: true,
				settings:
				{
					dateFormat: "YYYY-MM-DD ddd",
					timeFormat: "HH:mm",
					weekStartDay: 1,
				},
			},
		);
	});

	it("yields the defaults and available: false on a 503 GET", async () =>
	{
		responses.push(
			Response.json(
				{
					error: NOT_CONFIGURED,
				},
				{
					status: 503,
				},
			),
		);
		const queryClient = new QueryClient();
		queryClient.setQueryData(preferenceKeys.all, await fetchPreferences());
		const state = captureState(queryClient);
		expect(
			{
				available: state.available,
				error: state.error,
				settings: state.dateSettings,
			},
		).toStrictEqual(
			{
				available: false,
				error: NOT_CONFIGURED,
				settings: DEFAULT_DATE_SETTINGS,
			},
		);
	});
});
