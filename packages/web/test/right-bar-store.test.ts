import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";

const fetchMock = vi.fn<typeof fetch>();

function stubGlobals(): void
{
	vi.stubGlobal(
		"localStorage",
		{
			getItem: () => null,
			setItem: () =>
			{
			},
			removeItem: () =>
			{
			},
		},
	);
	vi.stubGlobal("innerWidth", 1272);
	vi.stubGlobal("matchMedia", () => (
	{
		matches: false,
		addEventListener: () =>
		{
		},
	}));
	vi.stubGlobal(
		"document",
		{
			documentElement:
			{
				dataset: {},
			},
			body:
			{
				classList:
				{
					toggle: () => true,
					contains: () => false,
				},
			},
			cookie: "",
		},
	);
	vi.stubGlobal("addEventListener", () => {});
	vi.stubGlobal("fetch", fetchMock);
}

async function loadStore()
{
	vi.resetModules();
	const {useOutlineStore} = await import("../src/client/stores/outline.js");
	return useOutlineStore;
}

type Store = Awaited<ReturnType<typeof loadStore>>;

function rightBar(store: Store):
{
	showKeyboardShortcuts: boolean;
	rightBarCollapsed: boolean;
}
{
	const {showKeyboardShortcuts, rightBarCollapsed} = store.getState();
	return {
		showKeyboardShortcuts,
		rightBarCollapsed,
	};
}

function patchCalls():
{
	url: unknown;
	method: unknown;
	body: unknown;
}[]
{
	return fetchMock.mock.calls.map(([url, init]) => (
	{
		url,
		method: init?.method,
		body: init?.body,
	}));
}

beforeEach(() =>
{
	fetchMock.mockReset();
	fetchMock.mockResolvedValue(
		Response.json(
			{},
			{
				status: 200,
			},
		),
	);
	stubGlobals();
});

afterEach(() =>
{
	vi.unstubAllGlobals();
});

describe("right bar store", () =>
{
	it("starts hidden and collapsed", async () =>
	{
		const store = await loadStore();
		expect(rightBar(store)).toStrictEqual(
			{
				showKeyboardShortcuts: false,
				rightBarCollapsed: true,
			},
		);
	});

	it("toggleRightBar opens then closes, persisting showKeyboardShortcuts each time", async () =>
	{
		const store = await loadStore();
		store.getState().toggleRightBar();
		const opened = rightBar(store);
		store.getState().toggleRightBar();
		expect(
			{
				opened,
				closed: rightBar(store),
				calls: patchCalls(),
			},
		).toStrictEqual(
			{
				opened:
				{
					showKeyboardShortcuts: true,
					rightBarCollapsed: false,
				},
				closed:
				{
					showKeyboardShortcuts: false,
					rightBarCollapsed: true,
				},
				calls: [
					{
						url: "/api/v1/preferences",
						method: "PATCH",
						body: '{"showKeyboardShortcuts":true}',
					},
					{
						url: "/api/v1/preferences",
						method: "PATCH",
						body: '{"showKeyboardShortcuts":false}',
					},
				],
			},
		);
	});

	it("adopts the account value without a PATCH and stays collapsed", async () =>
	{
		const store = await loadStore();
		store.getState().adoptShowKeyboardShortcuts(true);
		expect(
			{
				state: rightBar(store),
				calls: patchCalls(),
			},
		).toStrictEqual(
			{
				state:
				{
					showKeyboardShortcuts: true,
					rightBarCollapsed: true,
				},
				calls: [],
			},
		);
	});

	it("toggleRightBarCollapsed flips only collapsed, without a PATCH", async () =>
	{
		const store = await loadStore();
		store.getState().toggleRightBarCollapsed();
		const expanded = rightBar(store);
		store.getState().toggleRightBarCollapsed();
		expect(
			{
				expanded,
				collapsed: rightBar(store),
				calls: patchCalls(),
			},
		).toStrictEqual(
			{
				expanded:
				{
					showKeyboardShortcuts: false,
					rightBarCollapsed: false,
				},
				collapsed:
				{
					showKeyboardShortcuts: false,
					rightBarCollapsed: true,
				},
				calls: [],
			},
		);
	});

	it("setShowKeyboardShortcuts stays local-only without logging on 503", async () =>
	{
		fetchMock.mockResolvedValue(
			new Response(
				"{}",
				{
					status: 503,
				},
			),
		);
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const store = await loadStore();
		store.getState().setShowKeyboardShortcuts(true);
		await Promise.resolve();
		await Promise.resolve();
		const logged = error.mock.calls.length;
		error.mockRestore();
		expect(
			{
				state: rightBar(store),
				logged,
			},
		).toStrictEqual(
			{
				state:
				{
					showKeyboardShortcuts: true,
					rightBarCollapsed: true,
				},
				logged: 0,
			},
		);
	});
});

describe("toggleRightBarPanel", () =>
{
	it("shows a panel when collapsed, hides the bar when that panel is shown, and switches panels otherwise", async () =>
	{
		const store = await loadStore();
		const {registerRightBarPanel} = await import("../src/client/right-bar-panels.js");
		const unregisterFirst = registerRightBarPanel(
			{
				title: "Hotkeys",
				element: () => null,
			},
		);
		const unregisterSecond = registerRightBarPanel(
			{
				title: "Second",
				element: () => null,
			},
		);
		const steps: unknown[] = [];
		const step = (): void =>
		{
			steps.push(
				{
					...rightBar(store),
					cookie: document.cookie,
					calls: patchCalls().length,
				},
			);
		};
		store.getState().toggleRightBarPanel("Hotkeys");
		step();
		store.getState().toggleRightBarPanel("Second");
		step();
		store.getState().toggleRightBarPanel("Second");
		step();
		unregisterFirst();
		unregisterSecond();
		expect(steps).toStrictEqual([
			{
				showKeyboardShortcuts: true,
				rightBarCollapsed: false,
				cookie: "right-bar-last=Hotkeys",
				calls: 1,
			},
			{
				showKeyboardShortcuts: true,
				rightBarCollapsed: false,
				cookie: "right-bar-last=Second",
				calls: 2,
			},
			{
				showKeyboardShortcuts: false,
				rightBarCollapsed: true,
				cookie: "right-bar-last=Second",
				calls: 3,
			},
		]);
	});
});

describe("serverShowKeyboardShortcuts", () =>
{
	it("is the account value once loaded and null while loading or unavailable", async () =>
	{
		const {EMPTY_PREFERENCES, serverShowKeyboardShortcuts} = await import("../src/client/hooks/use-preferences.js");
		const preferences =
		{
			...EMPTY_PREFERENCES,
			showKeyboardShortcuts: true,
		};
		expect([
			serverShowKeyboardShortcuts(undefined),
			serverShowKeyboardShortcuts(
				{
					preferences,
					available: true,
					error: null,
				},
			),
			serverShowKeyboardShortcuts(
				{
					preferences,
					available: false,
					error: "no login",
				},
			),
		]).toStrictEqual([null, true, null]);
	});
});
