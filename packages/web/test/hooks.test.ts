import {describe, expect, it, afterEach, beforeEach, vi} from "vite-plus/test";
import {fetchMentionAccount} from "../src/client/hooks/use-account.js";
import {initialBreakpoint, resizedBreakpoint} from "../src/client/hooks/use-breakpoint.js";
import {QueryClient} from "@tanstack/react-query";
import
{
	adjacentMonths,
	calendarDaysKey,
	calendarDaysUrl,
	eventDayPredicate,
	prefetchCalendarDays,
} from "../src/client/hooks/use-calendar-event-days.js";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {CALENDAR_SETTINGS_KEY, toggleCalendarSetting} from "../src/client/hooks/use-calendar-settings.js";
import type {CalendarSettings, CustomTreeResponse, FeaturesResponse} from "../src/node-types.js";
import {readJson} from "../src/client/read-json.js";
import {hasSelector} from "./helpers/css-block.js";
import {applyCustomTree, invalidateCustomTreeOnWrites} from "../src/client/hooks/use-custom-tree.js";
import {hint} from "../src/client/keys/hint.js";
import {useCustomKeymapStore} from "../src/client/stores/custom-keymap.js";
import {useCustomThemesStore} from "../src/client/stores/custom-themes.js";
import {allThemes} from "../src/client/themes.js";
import {isFeatureOn, setAccountFeatures} from "../src/client/features.js";
import {featureKeys, setFeature} from "../src/client/hooks/use-features.js";
import {installPrintListeners, printingStore} from "../src/client/hooks/use-printing.js";
import {printRowBudget} from "../src/client/render-window.js";
import {markWhatsNewRead, whatsNewKeys, whatsNewUnreadFrom} from "../src/client/hooks/use-whats-new.js";
import type {WhatsNewState} from "../src/client/hooks/use-whats-new.js";

describe("use account", () =>
{
	function fetchFrom(routes: Record<string, Response>): typeof fetch
	{
		return async (input) =>
			Promise.resolve(
				routes[typeof input === "string" ? input : ""] ??
					new Response(
						null,
						{
							status: 404,
						},
					),
			);
	}

	const ACCOUNT =
	{
		userId: 7,
		joinedAt: "2020-01-02T00:00:00.000Z",
		fullName: "Alice Smith",
		email: "",
	};

	describe("fetchMentionAccount", () =>
	{
		it("adds each AI assistant's name keyed by its system user id", async () =>
		{
			const ai =
			{
				assistants: [
					{
						id: "assistant_a",
						name: "Assistant A",
						model: null,
						systemUserId: -5,
					},
					{
						id: "assistant_b",
						name: null,
						model: null,
						systemUserId: -6,
					},
					{
						id: "assistant_c",
						name: "Assistant C",
						model: null,
						systemUserId: null,
					},
				],
				defaultAgentId: null,
				promptButtons:
				{
					draft: [],
					reply: [],
				},
				contextLimit: 500,
				mailboxId: null,
			};

			await expect(
				fetchMentionAccount(
					fetchFrom(
						{
							"/api/v1/account": Response.json(ACCOUNT),
							"/api/v1/account/ai": Response.json(ai),
						},
					),
				),
			).resolves.toStrictEqual(
				{
					userId: 7,
					fullName: "Alice Smith",
					joinedAt: "2020-01-02T00:00:00.000Z",
					assistantNames:
					{
						"-5": "Assistant A",
					},
				},
			);
		});

		it("keeps the account without assistant names when the AI settings fail, and is null when the account fails", async () =>
		{
			await expect(
				Promise.all([
					fetchMentionAccount(
						fetchFrom(
							{
								"/api/v1/account": Response.json(ACCOUNT),
							},
						),
					),
					fetchMentionAccount(fetchFrom({})),
				]),
			).resolves.toStrictEqual([
				{
					userId: 7,
					fullName: "Alice Smith",
					joinedAt: "2020-01-02T00:00:00.000Z",
					assistantNames: {},
				},
				null,
			]);
		});
	});
});

describe("use breakpoint", () =>
{
	describe("useBreakpoint helpers", () =>
	{
		it("subtracts a 15px scrollbar allowance from innerWidth at load", () =>
		{
			expect(
				{
					a: initialBreakpoint(
						{
							innerWidth: 1010,
						},
						1000,
					),
					b: initialBreakpoint(
						{
							innerWidth: 1015,
						},
						1000,
					),
					c: initialBreakpoint(
						{
							innerWidth: 715,
						},
						701,
					),
					d: initialBreakpoint(
						{
							innerWidth: 716,
						},
						701,
					),
				},
			).toStrictEqual(
				{
					a: false,
					b: true,
					c: false,
					d: true,
				},
			);
		});

		it("compares body.clientWidth after a resize", () =>
		{
			expect(
				{
					a: resizedBreakpoint(
						{
							clientWidth: 1003,
						},
						1000,
					),
					b: resizedBreakpoint(
						{
							clientWidth: 998,
						},
						1000,
					),
				},
			).toStrictEqual(
				{
					a: true,
					b: false,
				},
			);
		});
	});
});

describe("use calendar event days", () =>
{
	describe("eventDayPredicate", () =>
	{
		it("marks the listed days of every loaded month, adjacent-month cells included", () =>
		{
			const hasEvent = eventDayPredicate(
				new Map([
					["2026-9", [28, 29]],
					["2026-10", [1, 2]],
				]),
			);

			expect(
				[new Date(2026, 8, 28), new Date(2026, 9, 2), new Date(2026, 8, 27), new Date(2026, 10, 1)].map(
					hasEvent,
				),
			).toStrictEqual([true, true, false, false]);
		});

		it("marks nothing for months that have not loaded", () =>
		{
			expect(eventDayPredicate(new Map())(new Date(2026, 8, 28))).toBe(false);
		});
	});

	describe("calendarDaysUrl", () =>
	{
		it("asks the server for one month", () =>
		{
			expect(
				calendarDaysUrl(
					{
						year: 2026,
						month: 9,
					},
				),
			).toBe("/api/v1/calendar/days?year=2026&month=9");
		});

		it("also asks for Found Dates days for the strip's picker", () =>
		{
			expect(
				calendarDaysUrl(
					{
						year: 2026,
						month: 9,
					},
					{
						found: true,
					},
				),
			).toBe("/api/v1/calendar/days?year=2026&month=9&found=1");
		});
	});

	describe("adjacentMonths", () =>
	{
		it("lists the months before and after, across year boundaries", () =>
		{
			expect([
				adjacentMonths(
					{
						year: 2026,
						month: 10,
					},
				),
				adjacentMonths(
					{
						year: 2026,
						month: 1,
					},
				),
			]).toStrictEqual([
				[
					{
						year: 2026,
						month: 9,
					},
					{
						year: 2026,
						month: 11,
					},
				],
				[
					{
						year: 2025,
						month: 12,
					},
					{
						year: 2026,
						month: 2,
					},
				],
			]);
		});
	});

	describe("prefetchCalendarDays", () =>
	{
		let urls: string[];

		beforeEach(() =>
		{
			urls = [];
			vi.stubGlobal(
				"fetch",
				vi.fn<typeof fetch>(async (input) =>
				{
					urls.push(input instanceof Request ? input.url : input.toString());
					return Promise.resolve(
						Response.json(
							{
								days: [1, 15],
							},
						),
					);
				}),
			);
		});

		afterEach(() =>
		{
			vi.unstubAllGlobals();
		});

		it("caches the month's days under the key the picker reads, fetching a fresh month once", async () =>
		{
			const queryClient = new QueryClient(
				{
					defaultOptions:
					{
						queries:
						{
							staleTime: 60_000,
						},
					},
				},
			);
			const october =
			{
				year: 2026,
				month: 10,
			};

			await prefetchCalendarDays(
				queryClient,
				october,
				{
					found: true,
				},
			);
			await prefetchCalendarDays(
				queryClient,
				october,
				{
					found: true,
				},
			);

			expect(
				{
					urls,
					found: queryClient.getQueryData(
						calendarDaysKey(
							october,
							{
								found: true,
							},
						),
					),
					plain: queryClient.getQueryData(calendarDaysKey(october)),
				},
			).toStrictEqual(
				{
					urls: ["/api/v1/calendar/days?year=2026&month=10&found=1"],
					found: [1, 15],
					plain: undefined,
				},
			);
		});
	});
});

describe("use calendar settings", () =>
{
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
});

describe("use custom tree", () =>
{
	const node = (name: string, children: CustomTreeResponse["sections"][string] = []) => (
	{
		name,
		completed: false,
		children,
	});

	afterEach(() =>
	{
		applyCustomTree(
			{
				rootId: null,
				rootChildren: [],
				watchedIds: [],
				sections: {},
			},
		);
	});

	describe("applyCustomTree", () =>
	{
		it("makes a custom hotkey the hint, and a missing root restores the default", () =>
		{
			applyCustomTree(
				{
					rootId: "r",
					rootChildren: [],
					watchedIds: [],
					sections:
					{
						Hotkeys: [node("Hotkeys", [node("alt+z", [node("zoom_in")])])],
					},
				},
			);
			const custom = hint("zoom_in");
			applyCustomTree(
				{
					rootId: null,
					rootChildren: [],
					watchedIds: [],
					sections: {},
				},
			);
			expect(
				{
					custom,
					restored: hint("zoom_in"),
				},
			).toStrictEqual(
				{
					custom: "⌥Z",
					restored: "⌘.",
				},
			);
		});

		it("registers custom themes in the theme list and removes them when the tree goes away", () =>
		{
			applyCustomTree(
				{
					rootId: "r",
					rootChildren: [],
					watchedIds: [],
					sections:
					{
						Themes: [
							node("Themes", [node("My Theme", [node("main", [node("text-primary", [node("#111")])])])]),
						],
					},
				},
			);
			const names = allThemes().map((theme) => theme.name);
			applyCustomTree(
				{
					rootId: null,
					rootChildren: [],
					watchedIds: [],
					sections: {},
				},
			);
			expect(
				{
					added: names.at(-1),
					after: allThemes().some((theme) => theme.name === "My_Theme"),
					keymap: useCustomKeymapStore.getState().overrides,
					themes: useCustomThemesStore.getState().themes,
				},
			).toStrictEqual(
				{
					added: "My_Theme",
					after: false,
					keymap: [],
					themes: [],
				},
			);
		});
	});

	describe("invalidateCustomTreeOnWrites", () =>
	{
		/** Whether a successful mutation with `variables` answering `data` marks the cached custom tree stale. */
		async function refetchesAfter(variables: unknown, data: unknown = null): Promise<boolean>
		{
			const queryClient = new QueryClient();
			queryClient.setQueryData<CustomTreeResponse>(
				["custom-tree", null],
				{
					rootId: "custom",
					rootChildren: [],
					watchedIds: ["custom", "home-sibling", "hotkeys", "combo"],
					sections: {},
				},
			);
			const unsubscribe = invalidateCustomTreeOnWrites(queryClient);
			await queryClient
				.getMutationCache()
				.build(
					queryClient,
					{
						mutationFn: async () => Promise.resolve(data),
					},
				)
				.execute(variables);
			unsubscribe();
			return queryClient.getQueryState(["custom-tree", null])?.isInvalidated ?? false;
		}

		it("refetches only after a write that names a watched node or a top-level parent", async () =>
		{
			const results =
			{
				moveOutside: await refetchesAfter(
					{
						ids: ["a", "b"],
						parent_id: "c",
						index: 0,
						expandParent: true,
					},
				),
				editOutside: await refetchesAfter(
					{
						nodeId: "a",
						name: "zoom_in",
					},
				),
				preference: await refetchesAfter(
					{
						theme: "dark",
					},
				),
				editCombo: await refetchesAfter(
					{
						nodeId: "combo",
						name: "alt+y",
					},
				),
				moveIntoHotkeys: await refetchesAfter(
					{
						ids: ["a"],
						parent_id: "hotkeys",
						index: 0,
					},
				),
				renameTopLevel: await refetchesAfter(
					{
						nodeId: "home-sibling",
						name: "Custom",
					},
				),
				createTopLevel: await refetchesAfter(
					{
						parent_id: null,
						name: "Custom",
					},
				),
				createdUnderCombo: await refetchesAfter(
					{
						name: "zoom_out",
					},
					{
						node:
						{
							id: "new",
							parent_id: "combo",
						},
					},
				),
			};
			expect(results).toStrictEqual(
				{
					moveOutside: false,
					editOutside: false,
					preference: false,
					editCombo: true,
					moveIntoHotkeys: true,
					renameTopLevel: true,
					createTopLevel: true,
					createdUnderCombo: true,
				},
			);
		});
	});
});

describe("use features", () =>
{
	const START: FeaturesResponse =
	{
		visible: [],
		enabled:
		{
			dates: true,
		},
		available: true,
	};

	function clientWithStart()
	{
		const client = new QueryClient();
		client.setQueryData(featureKeys.all, START);
		return client;
	}

	describe("setFeature", () =>
	{
		afterEach(() =>
		{
			vi.unstubAllGlobals();
			setAccountFeatures(null);
		});

		it("flips the dict at once, then stores the server's dict", async () =>
		{
			const seen: unknown[] = [];
			const client = clientWithStart();
			vi.stubGlobal(
				"fetch",
				vi.fn(async () =>
				{
					seen.push(client.getQueryData<FeaturesResponse>(featureKeys.all)?.enabled);
					return Promise.resolve(
						Response.json(
							{
								enabled:
								{
									dates: true,
									dashboards: true,
								},
							},
						),
					);
				}),
			);

			await setFeature(client, "dashboards", true);

			expect(seen).toStrictEqual([
				{
					dates: true,
					dashboards: true,
				},
			]);
			expect(client.getQueryData<FeaturesResponse>(featureKeys.all)?.enabled).toStrictEqual(
				{
					dates: true,
					dashboards: true,
				},
			);
			expect(isFeatureOn("dashboards")).toBe(true);
		});

		it("drops the key when disabling", async () =>
		{
			const client = clientWithStart();
			const fetchStub = vi.fn<typeof fetch>(async () =>
				Promise.resolve(
					Response.json(
						{
							enabled: {},
						},
					),
				),
			);
			vi.stubGlobal("fetch", fetchStub);

			await setFeature(client, "dates", false);

			expect(fetchStub.mock.calls).toStrictEqual([
				[
					"/api/v1/features/dates",
					{
						method: "POST",
						headers:
						{
							"Content-Type": "application/json",
						},
						body: '{"on":false}',
					},
				],
			]);
			expect(client.getQueryData<FeaturesResponse>(featureKeys.all)?.enabled).toStrictEqual({});
		});

		it("restores the previous dict when the POST fails", async () =>
		{
			const client = clientWithStart();
			vi.stubGlobal(
				"fetch",
				vi.fn(async () =>
					Promise.resolve(
						new Response(
							"boom",
							{
								status: 500,
							},
						),
					),
				),
			);

			await expect(setFeature(client, "dashboards", true)).rejects.toThrow("500");

			expect(client.getQueryData<FeaturesResponse>(featureKeys.all)).toStrictEqual(START);
			expect(isFeatureOn("dashboards")).toBe(false);
		});
	});
});

describe("use printing", () =>
{
	describe("printing flag", () =>
	{
		it("follows beforeprint and afterprint, and the disposer removes both listeners", () =>
		{
			const win = new EventTarget();
			const dispose = installPrintListeners(win);
			const seen: boolean[] = [printingStore.get()];
			win.dispatchEvent(new Event("beforeprint"));
			seen.push(printingStore.get());
			win.dispatchEvent(new Event("afterprint"));
			seen.push(printingStore.get());
			win.dispatchEvent(new Event("beforeprint"));
			dispose();
			win.dispatchEvent(new Event("afterprint"));
			seen.push(printingStore.get());
			expect(seen).toStrictEqual([false, true, false, true]);
			printingStore.set(false);
		});

		it("notifies subscribers", () =>
		{
			const calls: boolean[] = [];
			const unsubscribe = printingStore.subscribe(() =>
			{
				calls.push(printingStore.get());
			});
			printingStore.set(true);
			printingStore.set(true);
			printingStore.set(false);
			unsubscribe();
			printingStore.set(true);
			printingStore.set(false);
			expect(calls).toStrictEqual([true, false]);
		});
	});

	describe("printRowBudget", () =>
	{
		it("renders every row while printing and the windowed budget otherwise", () =>
		{
			expect([printRowBudget(48, true), printRowBudget(48, false)]).toStrictEqual([Number.POSITIVE_INFINITY, 48]);
		});
	});
});

describe("use whats new", () =>
{
	function whatsNewClient(state: WhatsNewState | undefined): QueryClient
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
		if (state !== undefined)
		{
			queryClient.setQueryData(whatsNewKeys.all, state);
		}
		return queryClient;
	}

	function stubFetch():
	{
		url: string;
		method: string;
		body: unknown;
	}[]
	{
		const requests:
		{
			url: string;
			method: string;
			body: unknown;
		}[] = [];
		vi.stubGlobal("fetch", async (url: string, init?: RequestInit) =>
		{
			requests.push(
				{
					url,
					method: init?.method ?? "GET",
					body: JSON.parse(init?.body as string) as unknown,
				},
			);
			return Promise.resolve(
				Response.json(
					{
						read: ["as_of_queries", "older_entry"],
					},
				),
			);
		});
		return requests;
	}

	describe("whatsNewUnreadFrom", () =>
	{
		it("is false while loading, and true while one of our entries is not read", () =>
		{
			expect(
				{
					loading: whatsNewUnreadFrom(undefined),
					neverRead: whatsNewUnreadFrom(
						{
							read: [],
						},
					),
					allRead: whatsNewUnreadFrom(
						{
							read: ["as_of_queries"],
						},
					),
				},
			).toStrictEqual(
				{
					loading: false,
					neverRead: true,
					allRead: false,
				},
			);
		});
	});

	describe("markWhatsNewRead", () =>
	{
		afterEach(() =>
		{
			vi.unstubAllGlobals();
		});

		it("POSTs the unread entries to our own endpoint, never upstream's preferences, and stores the answer", async () =>
		{
			const requests = stubFetch();
			const queryClient = whatsNewClient(
				{
					read: ["older_entry"],
				},
			);
			await markWhatsNewRead(queryClient);
			expect(
				{
					requests,
					cached: queryClient.getQueryData<WhatsNewState>(whatsNewKeys.all),
				},
			).toStrictEqual(
				{
					requests: [
						{
							url: "/api/v1/whats-new/read",
							method: "POST",
							body:
							{
								entries: ["as_of_queries"],
							},
						},
					],
					cached:
					{
						read: ["as_of_queries", "older_entry"],
					},
				},
			);
		});

		it("issues no request when every entry is read or while loading", async () =>
		{
			const requests = stubFetch();
			await markWhatsNewRead(
				whatsNewClient(
					{
						read: ["as_of_queries"],
					},
				),
			);
			await markWhatsNewRead(whatsNewClient(undefined));
			expect(requests).toStrictEqual([]);
		});
	});
});
