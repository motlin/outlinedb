import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";

const stored = new Map<string, string>();
vi.stubGlobal(
	"localStorage",
	{
		getItem: (key: string) => stored.get(key) ?? null,
		setItem: (key: string, value: string) =>
		{
			stored.set(key, value);
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
	},
);
vi.stubGlobal("addEventListener", () => {});
const dispatchEvent = vi.fn<(event: Event) => boolean>();
vi.stubGlobal("dispatchEvent", dispatchEvent);

const {initialLeftBarState, nextLeftBarMode, useOutlineStore} = await import("../src/client/stores/outline.js");

function stubStorage(entries: Record<string, string>): Pick<Storage, "getItem">
{
	return {
		getItem: (key) => entries[key] ?? null,
	};
}

describe("initialLeftBarState", () =>
{
	it("defaults to a closed drawer at 296px with no section expansions", () =>
	{
		expect(initialLeftBarState(stubStorage({}), 1272)).toStrictEqual(
			{
				leftBarMode: "drawerClosed",
				leftBarWidth: 296,
				leftBarSectionExpansions: {},
			},
		);
	});

	it("reads persisted values back", () =>
	{
		const storage = stubStorage(
			{
				"stateStorage::leftBarMode": '"alwaysOpen"',
				"stateStorage::leftBarWidth": "320",
				"stateStorage::leftBarSectionExpansions": '{"starred":false}',
			},
		);
		expect(initialLeftBarState(storage, 1272)).toStrictEqual(
			{
				leftBarMode: "alwaysOpen",
				leftBarWidth: 320,
				leftBarSectionExpansions:
				{
					starred: false,
				},
			},
		);
	});

	it("forces a closed drawer below 800px", () =>
	{
		const storage = stubStorage(
			{
				"stateStorage::leftBarMode": '"alwaysOpen"',
			},
		);
		expect(initialLeftBarState(storage, 700)).toStrictEqual(
			{
				leftBarMode: "drawerClosed",
				leftBarWidth: 296,
				leftBarSectionExpansions: {},
			},
		);
	});

	it("falls back to defaults on corrupt JSON", () =>
	{
		const storage = stubStorage(
			{
				"stateStorage::leftBarMode": "{not json",
				"stateStorage::leftBarWidth": "[[",
				"stateStorage::leftBarSectionExpansions": "nope",
			},
		);
		expect(initialLeftBarState(storage, 1272)).toStrictEqual(
			{
				leftBarMode: "drawerClosed",
				leftBarWidth: 296,
				leftBarSectionExpansions: {},
			},
		);
	});

	it("falls back to defaults when storage throws", () =>
	{
		const storage: Pick<Storage, "getItem"> =
		{
			getItem: () =>
			{
				throw new Error("blocked");
			},
		};
		expect(initialLeftBarState(storage, 1272)).toStrictEqual(
			{
				leftBarMode: "drawerClosed",
				leftBarWidth: 296,
				leftBarSectionExpansions: {},
			},
		);
	});
});

describe("nextLeftBarMode", () =>
{
	it("pins from either drawer state and unpins to a closed drawer", () =>
	{
		expect([
			nextLeftBarMode("drawerClosed"),
			nextLeftBarMode("alwaysOpen"),
			nextLeftBarMode("drawerOpen"),
		]).toStrictEqual(["alwaysOpen", "drawerClosed", "alwaysOpen"]);
	});
});

describe("left-bar store actions", () =>
{
	beforeEach(() =>
	{
		stored.clear();
		dispatchEvent.mockClear();
		vi.useFakeTimers();
		useOutlineStore.setState(
			{
				leftBarMode: "drawerClosed",
				leftBarWidth: 296,
				leftBarSectionExpansions: {},
				leftBarHovered: false,
			},
		);
	});

	afterEach(() =>
	{
		vi.useRealTimers();
	});

	it("toggleLeftBar pins, persists, and dispatches resize after 500ms", () =>
	{
		useOutlineStore.getState().toggleLeftBar();
		const beforeTimer = dispatchEvent.mock.calls.length;
		vi.advanceTimersByTime(500);
		expect(
			{
				mode: useOutlineStore.getState().leftBarMode,
				stored: stored.get("stateStorage::leftBarMode"),
				beforeTimer,
				resizeEvents: dispatchEvent.mock.calls.map(([event]) => event.type),
			},
		).toStrictEqual(
			{
				mode: "alwaysOpen",
				stored: '"alwaysOpen"',
				beforeTimer: 0,
				resizeEvents: ["resize"],
			},
		);
	});

	it("drawer open/close is a no-op while pinned", () =>
	{
		useOutlineStore.setState(
			{
				leftBarMode: "alwaysOpen",
			},
		);
		useOutlineStore.getState().openLeftBarDrawer();
		const afterOpen = useOutlineStore.getState().leftBarMode;
		useOutlineStore.getState().closeLeftBarDrawer();
		expect([afterOpen, useOutlineStore.getState().leftBarMode]).toStrictEqual(["alwaysOpen", "alwaysOpen"]);
	});

	it("drawer open/close moves between drawer states and persists", () =>
	{
		useOutlineStore.getState().openLeftBarDrawer();
		const opened = [useOutlineStore.getState().leftBarMode, stored.get("stateStorage::leftBarMode")];
		useOutlineStore.getState().closeLeftBarDrawer();
		expect(
			{
				opened,
				closed: [useOutlineStore.getState().leftBarMode, stored.get("stateStorage::leftBarMode")],
			},
		).toStrictEqual(
			{
				opened: ["drawerOpen", '"drawerOpen"'],
				closed: ["drawerClosed", '"drawerClosed"'],
			},
		);
	});

	it("closing the drawer clears the hovered flag and the left-bar drop target", () =>
	{
		const pos =
		{
			parentId: "A",
			index: 0,
			ambiguous: false,
			bar:
			{
				top: 1,
				left: 2,
				width: 3,
			},
		};
		useOutlineStore.setState(
			{
				leftBarMode: "drawerOpen",
				leftBarHovered: true,
				leftBarDrop: pos,
			},
		);
		useOutlineStore.getState().closeLeftBarDrawer();
		const {leftBarMode, leftBarHovered, leftBarDrop} = useOutlineStore.getState();
		expect(
			{
				leftBarMode,
				leftBarHovered,
				leftBarDrop,
			},
		).toStrictEqual(
			{
				leftBarMode: "drawerClosed",
				leftBarHovered: false,
				leftBarDrop: null,
			},
		);
	});

	it("leftBarOffset is the width when pinned and 0 otherwise", () =>
	{
		const {leftBarOffset} = useOutlineStore.getState();
		const closed = leftBarOffset();
		useOutlineStore.setState(
			{
				leftBarMode: "drawerOpen",
			},
		);
		const drawer = leftBarOffset();
		useOutlineStore.setState(
			{
				leftBarMode: "alwaysOpen",
			},
		);
		expect([closed, drawer, leftBarOffset()]).toStrictEqual([0, 0, 296]);
	});

	it("setLeftBarWidth clamps to 160 and persists", () =>
	{
		useOutlineStore.getState().setLeftBarWidth(100);
		const clamped = [useOutlineStore.getState().leftBarWidth, stored.get("stateStorage::leftBarWidth")];
		useOutlineStore.getState().setLeftBarWidth(400);
		expect(
			{
				clamped,
				wide: [useOutlineStore.getState().leftBarWidth, stored.get("stateStorage::leftBarWidth")],
			},
		).toStrictEqual(
			{
				clamped: [160, "160"],
				wide: [400, "400"],
			},
		);
	});

	it("setLeftBarSectionExpanded merges and persists; setLeftBarHovered sets the flag", () =>
	{
		useOutlineStore.getState().setLeftBarSectionExpanded("starred", false);
		useOutlineStore.getState().setLeftBarSectionExpanded("recent", true);
		useOutlineStore.getState().setLeftBarHovered(true);
		const state = useOutlineStore.getState();
		expect(
			{
				expansions: state.leftBarSectionExpansions,
				stored: stored.get("stateStorage::leftBarSectionExpansions"),
				hovered: state.leftBarHovered,
			},
		).toStrictEqual(
			{
				expansions:
				{
					starred: false,
					recent: true,
				},
				stored: '{"starred":false,"recent":true}',
				hovered: true,
			},
		);
	});
});

describe("openSettings", () =>
{
	it("opens the modal at an optional section and clears it on close", () =>
	{
		const {openSettings, closeSettings} = useOutlineStore.getState();
		openSettings("Dates");
		const atDates = useOutlineStore.getState();
		const opened =
		{
			open: atDates.settingsOpen,
			section: atDates.settingsSection,
		};
		closeSettings();
		openSettings();
		const plain = useOutlineStore.getState();
		expect(
			{
				opened,
				plain:
				{
					open: plain.settingsOpen,
					section: plain.settingsSection,
				},
			},
		).toStrictEqual(
			{
				opened:
				{
					open: true,
					section: "Dates",
				},
				plain:
				{
					open: true,
					section: null,
				},
			},
		);
		closeSettings();
	});
});
