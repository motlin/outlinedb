import {QueryClient} from "@tanstack/react-query";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {CALENDAR_SETTINGS_KEY, toggleCalendarSetting} from "../src/client/hooks/use-calendar-settings.js";
import type {CalendarSettings} from "../src/node-types.js";
import {readJson} from "../src/client/read-json.js";
import {hasSelector} from "./helpers/css-block.js";

type FetchCall = [string, RequestInit | undefined];

let calls: FetchCall[];
let respond: (call: FetchCall) => Promise<Response>;

beforeEach(() =>
{
	calls = [];
	respond = async () =>
		Promise.resolve(
			Response.json(
				{
					foundDates: false,
					dayPrefix: true,
				},
			),
		);
	vi.stubGlobal(
		"fetch",
		vi.fn<typeof fetch>(async (input, init) =>
		{
			const call: FetchCall = [input instanceof Request ? input.url : input.toString(), init];
			calls.push(call);
			return respond(call);
		}),
	);
});

afterEach(() =>
{
	vi.unstubAllGlobals();
});

function client(
	settings =
	{
		foundDates: true,
		dayPrefix: true,
	},
): QueryClient
{
	const queryClient = new QueryClient(
		{
			defaultOptions:
			{
				queries:
				{
					retry: false,
				},
			},
		},
	);
	queryClient.setQueryData(CALENDAR_SETTINGS_KEY, settings);
	return queryClient;
}

describe("toggleCalendarSetting", () =>
{
	it("PUTs the flipped value and stores the server's settings", async () =>
	{
		const queryClient = client();

		await toggleCalendarSetting(queryClient, "foundDates");

		expect(
			{
				calls: calls.map(([url, init]) => [url, init?.method, init?.body]),
				settings: queryClient.getQueryData(CALENDAR_SETTINGS_KEY),
			},
		).toStrictEqual(
			{
				calls: [
					[
						"/api/v1/calendar/settings",
						"PUT",
						JSON.stringify(
							{
								foundDates: false,
							},
						),
					],
				],
				settings:
				{
					foundDates: false,
					dayPrefix: true,
				},
			},
		);
	});

	it("rolls back and rejects with the server's error when the write fails", async () =>
	{
		const queryClient = client();
		respond = async () =>
			Promise.resolve(
				Response.json(
					{
						error: "Internal API not configured",
					},
					{
						status: 503,
					},
				),
			);

		await expect(toggleCalendarSetting(queryClient, "dayPrefix")).rejects.toThrow(
			"Could not change Friendly day names: Internal API not configured",
		);
		expect(queryClient.getQueryData(CALENDAR_SETTINGS_KEY)).toStrictEqual(
			{
				foundDates: true,
				dayPrefix: true,
			},
		);
	});

	it("does not let a settings read already in flight overwrite the flipped value", async () =>
	{
		const queryClient = client();
		let finishRead: (response: Response) => void = () =>
		{
		};
		respond = async ([, init]) =>
			init?.method === "PUT"
				? new Promise<Response>(() => {})
				: new Promise<Response>((resolve) =>
					{
						finishRead = resolve;
					});
		const read = queryClient.query(
			{
				queryKey: CALENDAR_SETTINGS_KEY,
				queryFn: async () => readJson<CalendarSettings>(await fetch("/api/v1/calendar/settings")),
				staleTime: 0,
			},
		);

		void toggleCalendarSetting(queryClient, "foundDates");
		await vi.waitFor(() =>
		{
			expect(calls.map(([, init]) => init?.method)).toStrictEqual([undefined, "PUT"]);
		});
		finishRead(
			Response.json(
				{
					foundDates: true,
					dayPrefix: true,
				},
			),
		);
		await read.catch(() => {});

		expect(queryClient.getQueryData(CALENDAR_SETTINGS_KEY)).toStrictEqual(
			{
				foundDates: false,
				dayPrefix: true,
			},
		);
	});
});

describe("toggleCalendarSetting speed", () =>
{
	it("shows the flipped value before the server answers the write", async () =>
	{
		const queryClient = client();
		respond = async () => new Promise<Response>(() => {});

		void toggleCalendarSetting(queryClient, "dayPrefix");
		await Promise.resolve();

		expect(
			{
				methods: calls.map(([, init]) => init?.method),
				settings: queryClient.getQueryData(CALENDAR_SETTINGS_KEY),
			},
		).toStrictEqual(
			{
				methods: ["PUT"],
				settings:
				{
					foundDates: true,
					dayPrefix: false,
				},
			},
		);
	});

	it("sends one request for Friendly day names and refetches nothing, since the prefixes read the settings cache", async () =>
	{
		const queryClient = client();
		const invalidate = vi.spyOn(queryClient, "invalidateQueries");
		respond = async () =>
			Promise.resolve(
				Response.json(
					{
						foundDates: true,
						dayPrefix: false,
					},
				),
			);

		await toggleCalendarSetting(queryClient, "dayPrefix");

		expect(
			{
				calls: calls.map(([url, init]) => [url, init?.method]),
				invalidated: invalidate.mock.calls.map(([filters]) => filters?.queryKey),
			},
		).toStrictEqual(
			{
				calls: [["/api/v1/calendar/settings", "PUT"]],
				invalidated: [],
			},
		);
	});

	it("refetches only the server-computed Found Dates and picker dots after a Found Dates write", async () =>
	{
		const queryClient = client();
		const invalidate = vi.spyOn(queryClient, "invalidateQueries");

		await toggleCalendarSetting(queryClient, "foundDates");

		expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toStrictEqual([
			["nodes", "found-dates"],
			["calendar-days"],
		]);
	});
});

describe("Toggle styles", () =>
{
	it("leaves the track content-box (no box-sizing override) so the 10px knob fits inside its 2px padding", () =>
	{
		const styles = readFileSync(fileURLToPath(new URL("../src/client/styles.css", import.meta.url)), "utf8");

		expect(hasSelector(styles, /^\s*label\.toggle > div\s*$/u)).toBe(false);
	});
});
