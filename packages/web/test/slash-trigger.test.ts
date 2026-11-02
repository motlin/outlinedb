import {QueryClient} from "@tanstack/react-query";
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import
{
	EMPTY_PREFERENCES,
	markSlashDiscovered,
	preferenceKeys,
	slashDiscoveredFrom,
} from "../src/client/hooks/use-preferences.js";
import type {PreferencesState} from "../src/client/hooks/use-preferences.js";
import
{
	placeholderFor,
	planSlashOpen,
	planSlashRearm,
	SLASH_CHIP_CLASS,
	stripSlashChip,
} from "../src/client/slash-trigger.js";

describe("planSlashOpen", () =>
{
	it.each([
		[
			"Slash Alpha /",
			12,
			{
				start: 11,
				end: 13,
			},
		],
		[
			"/",
			0,
			{
				start: 0,
				end: 1,
			},
		],
		["Betax/", 5, null],
		[
			"a / b",
			2,
			{
				start: 2,
				end: 3,
			},
		],
		["a /b", 2, null],
		[
			"/b",
			0,
			{
				start: 0,
				end: 1,
			},
		],
		[
			"a\t/",
			2,
			{
				start: 1,
				end: 3,
			},
		],
	] as const)("planSlashOpen(%j, %i)", (text, slashIndex, expected) =>
	{
		expect(planSlashOpen(text, slashIndex)).toStrictEqual(expected);
	});
});

describe("planSlashRearm", () =>
{
	it.each([
		[
			"Slash Alpha /mo",
			15,
			{
				start: 11,
				end: 15,
			},
		],
		["x/mo", 4, null],
		["a / mo", 6, null],
		[
			"/mo",
			3,
			{
				start: 0,
				end: 3,
			},
		],
		[
			"a /mo",
			4,
			{
				start: 1,
				end: 4,
			},
		],
		["a /abcdefghij", 13, null],
		[
			"a /abcdefgh",
			11,
			{
				start: 1,
				end: 11,
			},
		],
		["plain", 5, null],
	] as const)("planSlashRearm(%j, %i)", (text, caret, expected) =>
	{
		expect(planSlashRearm(text, caret)).toStrictEqual(expected);
	});
});

describe("stripSlashChip", () =>
{
	it("unwraps the chip span to its text", () =>
	{
		expect(
			stripSlashChip(
				'Slash Alpha<span class="slash-input bg-tertiary py-2xs pr-xs pl-xs rounded-s leading-none"> /mo</span>',
			),
		).toBe("Slash Alpha /mo");
	});

	it("returns HTML without a chip unchanged", () =>
	{
		const html = 'a <b>bold</b> <span class="colored c-red">red</span> /x';
		expect(stripSlashChip(html)).toBe(html);
	});

	it("exports the upstream chip class", () =>
	{
		expect(SLASH_CHIP_CLASS).toBe("slash-input bg-tertiary py-2xs pr-xs pl-xs rounded-s leading-none");
	});
});

describe("placeholderFor", () =>
{
	it.each([
		[
			{
				focused: true,
				empty: true,
				layoutMode: "bullets",
				slashDiscovered: false,
			},
			'Type "/" for commands',
		],
		[
			{
				focused: true,
				empty: true,
				layoutMode: undefined,
				slashDiscovered: false,
			},
			'Type "/" for commands',
		],
		[
			{
				focused: true,
				empty: true,
				layoutMode: "bullets",
				slashDiscovered: true,
			},
			undefined,
		],
		[
			{
				focused: true,
				empty: true,
				layoutMode: "divider",
				slashDiscovered: false,
			},
			undefined,
		],
		[
			{
				focused: true,
				empty: true,
				layoutMode: "numbered",
				slashDiscovered: false,
			},
			undefined,
		],
		[
			{
				focused: true,
				empty: true,
				layoutMode: "code-block",
				slashDiscovered: false,
			},
			undefined,
		],
		[
			{
				focused: true,
				empty: true,
				layoutMode: "quote-block",
				slashDiscovered: false,
			},
			undefined,
		],
		[
			{
				focused: false,
				empty: true,
				layoutMode: "divider",
				isZoomRoot: true,
			},
			undefined,
		],
		[
			{
				focused: false,
				empty: true,
				layoutMode: "code-block",
				isZoomRoot: true,
			},
			undefined,
		],
		[
			{
				focused: false,
				empty: true,
				layoutMode: "h1",
				isZoomRoot: true,
			},
			"Untitled",
		],
		[
			{
				focused: false,
				empty: true,
				layoutMode: "bullets",
				slashDiscovered: false,
			},
			undefined,
		],
		[
			{
				focused: true,
				empty: false,
				layoutMode: "bullets",
				slashDiscovered: false,
			},
			undefined,
		],
		[
			{
				isZoomRoot: true,
				empty: true,
				focused: false,
			},
			"Untitled",
		],
		[
			{
				isZoomRoot: true,
				empty: true,
				focused: true,
				slashDiscovered: true,
			},
			"Untitled",
		],
		[
			{
				isZoomRoot: true,
				empty: false,
				focused: false,
			},
			undefined,
		],
	] as const)("placeholderFor(%j)", (input, expected) =>
	{
		expect(placeholderFor(input)).toBe(expected);
	});
});

function preferencesClient(state: PreferencesState | undefined): QueryClient
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
		queryClient.setQueryData(preferenceKeys.all, state);
	}
	return queryClient;
}

const AVAILABLE = (slashDiscovered: boolean): PreferencesState => (
{
	preferences:
	{
		...EMPTY_PREFERENCES,
		slashDiscovered,
	},
	available: true,
	error: null,
});

describe("slashDiscoveredFrom", () =>
{
	it("is true while loading or unavailable so the hint never flashes", () =>
	{
		expect(
			{
				loading: slashDiscoveredFrom(undefined),
				unavailable: slashDiscoveredFrom(
					{
						preferences: EMPTY_PREFERENCES,
						available: false,
						error: "x",
					},
				),
				undiscovered: slashDiscoveredFrom(AVAILABLE(false)),
				discovered: slashDiscoveredFrom(AVAILABLE(true)),
			},
		).toStrictEqual(
			{
				loading: true,
				unavailable: true,
				undiscovered: false,
				discovered: true,
			},
		);
	});
});

describe("markSlashDiscovered", () =>
{
	afterEach(() =>
	{
		vi.unstubAllGlobals();
	});

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
					body: init?.body,
				},
			);
			return Promise.resolve(
				Response.json(
					{
						...EMPTY_PREFERENCES,
						slashDiscovered: true,
					},
				),
			);
		});
		return requests;
	}

	it("PATCHes slashDiscovered once when it is false", async () =>
	{
		const requests = stubFetch();
		const queryClient = preferencesClient(AVAILABLE(false));
		await markSlashDiscovered(queryClient);
		await markSlashDiscovered(queryClient);
		expect(requests).toStrictEqual([
			{
				url: "/api/v1/preferences",
				method: "PATCH",
				body: '{"slashDiscovered":true}',
			},
		]);
	});

	it("issues no request when already discovered, loading or unavailable", async () =>
	{
		const requests = stubFetch();
		await markSlashDiscovered(preferencesClient(AVAILABLE(true)));
		await markSlashDiscovered(preferencesClient(undefined));
		await markSlashDiscovered(
			preferencesClient(
				{
					preferences: EMPTY_PREFERENCES,
					available: false,
					error: "x",
				},
			),
		);
		expect(requests).toStrictEqual([]);
	});
});
