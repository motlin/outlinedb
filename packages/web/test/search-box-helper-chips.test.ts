// @vitest-environment happy-dom
import {afterEach, beforeAll, describe, expect, it, vi} from "vite-plus/test";
import type {Root} from "react-dom/client";

declare global
{
	// React reads this to know act() wraps every update.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const {useSyncExternalStore} = await import("react");

interface StoreState
{
	searchInput: string;
	searchFocused: boolean;
	setSearchInput: (value: string) => void;
	setSearchFocused: (focused: boolean) => void;
	commitSearch: (query: string) => void;
	openJumpMenu: () => void;
}

const listeners = new Set<() => void>();
const jumpOpens: number[] = [];
const commits: string[] = [];
let state: StoreState =
{
	searchInput: "",
	searchFocused: true,
	setSearchInput: (value) =>
	{
		setState(
			{
				searchInput: value,
			},
		);
	},
	setSearchFocused: () =>
	{
	},
	commitSearch: (query) =>
	{
		commits.push(query);
		setState(
			{
				searchInput: query,
			},
		);
	},
	openJumpMenu: () =>
	{
		jumpOpens.push(1);
	},
};

function setState(patch: Partial<StoreState>): void
{
	state =
	{
		...state,
		...patch,
	};
	for (const listener of listeners)
	{
		listener();
	}
}

function subscribe(listener: () => void): () => void
{
	listeners.add(listener);
	return () =>
	{
		listeners.delete(listener);
	};
}

vi.mock("../src/client/stores/outline.js", () => (
{
	useOutlineStore: Object.assign(
		(selector: (s: StoreState) => unknown) => selector(useSyncExternalStore(subscribe, () => state)),
		{
			getState: () => state,
		},
	),
}));
vi.mock("../src/client/hooks/use-stable-navigate.js", () => (
{
	useStableNavigate: () => () =>
	{
	},
}));
vi.mock("@tanstack/react-query", () => (
{
	useQueryClient: () => (
	{
		invalidateQueries: () =>
		{
		},
	}),
	useQuery: () => (
	{
		data: undefined,
	}),
}));
vi.mock("../src/client/hooks/use-breakpoint.js", () => (
{
	useBreakpoint: () => true,
}));

const {act, createElement} = await import("react");
const {createRoot} = await import("react-dom/client");
const {SearchBox} = await import("../src/client/components/search-box.js");

let root: Root | undefined;

beforeAll(() =>
{
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() =>
{
	act(() =>
	{
		root?.unmount();
	});
	root = undefined;
	document.body.innerHTML = "";
	state =
	{
		...state,
		searchInput: "",
	};
	jumpOpens.length = 0;
	commits.length = 0;
});

function mount(): HTMLInputElement
{
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	act(() =>
	{
		root?.render(createElement(SearchBox));
	});
	return document.querySelector<HTMLInputElement>("#srch-input")!;
}

function press(input: HTMLInputElement, key: string, init: KeyboardEventInit = {}): KeyboardEvent
{
	const event = new KeyboardEvent(
		"keydown",
		{
			key,
			code: key,
			bubbles: true,
			cancelable: true,
			...init,
		},
	);
	act(() =>
	{
		input.dispatchEvent(event);
	});
	return event;
}

function type(input: HTMLInputElement, text: string): void
{
	act(() =>
	{
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, text);
		input.setSelectionRange(text.length, text.length);
		input.dispatchEvent(
			new Event(
				"input",
				{
					bubbles: true,
				},
			),
		);
	});
}

function tabs(): HTMLElement[]
{
	return [...document.querySelectorAll<HTMLElement>("svg[data-icon]")]
		.filter((icon) => icon.closest(".flyout") !== null)
		.map((icon) => icon.parentElement!);
}

async function hoverTab(index: number): Promise<void>
{
	await act(async () =>
	{
		tabs()[index]?.dispatchEvent(
			new MouseEvent(
				"mouseover",
				{
					bubbles: true,
				},
			),
		);
		await new Promise<void>((resolve) =>
		{
			setTimeout(resolve, 120);
		});
	});
}

function chips(): HTMLElement[]
{
	return [...document.querySelectorAll<HTMLElement>("a.menuItem")];
}

// No tags in the zoom, so the tabs are globe, mentions, dates, ...
function selectDatesTab(input: HTMLInputElement): void
{
	for (const key of ["ArrowDown", "ArrowRight", "ArrowRight"])
	{
		press(input, key);
	}
}

describe("search helper chips", () =>
{
	it("makes the hovered chip the only active one and switches to the mouse classes", () =>
	{
		const input = mount();
		selectDatesTab(input);
		const keyboardMode = chips().map((chip) => chip.className.includes("canHover"));

		act(() =>
		{
			chips()[4]?.dispatchEvent(
				new MouseEvent(
					"mouseover",
					{
						bubbles: true,
					},
				),
			);
		});

		expect(
			{
				keyboardMode: keyboardMode.some(Boolean),
				active: chips().flatMap((chip, index) => (chip.className.endsWith("active canHover") ? [index] : [])),
				allHover: chips().every((chip) => chip.className.includes(" hover:bg-secondary ")),
			},
		).toStrictEqual(
			{
				keyboardMode: false,
				active: [4],
				allHover: true,
			},
		);
	});

	it("keeps the tab open after a chip click and resets it on a click into the input", () =>
	{
		const input = mount();
		selectDatesTab(input);
		const today = chips().find((chip) => chip.textContent === "today");

		act(() =>
		{
			today?.dispatchEvent(
				new MouseEvent(
					"mousedown",
					{
						bubbles: true,
					},
				),
			);
			today?.dispatchEvent(
				new MouseEvent(
					"click",
					{
						bubbles: true,
					},
				),
			);
		});
		const afterChip =
		{
			query: state.searchInput,
			chips: chips().length,
		};
		act(() =>
		{
			input.dispatchEvent(
				new MouseEvent(
					"click",
					{
						bubbles: true,
					},
				),
			);
		});

		expect(
			{
				afterChip,
				afterInput: chips().length,
			},
		).toStrictEqual(
			{
				afterChip:
				{
					query: "today ",
					chips: 13,
				},
				afterInput: 0,
			},
		);
	});
});

describe("search helper keys", () =>
{
	it("keeps the caret on ArrowUp by arming the tab row instead", () =>
	{
		const input = mount();
		type(input, "ab");
		const up = press(input, "ArrowUp");
		const right = press(input, "ArrowRight");

		expect(
			{
				up: up.defaultPrevented,
				right: right.defaultPrevented,
				tabs: chips().length,
			},
		).toStrictEqual(
			{
				up: true,
				right: true,
				tabs: 0,
			},
		);
	});

	it("swallows Space and Tab on a hovered chip tab without typing or leaving the search", async () =>
	{
		const input = mount();
		act(() =>
		{
			input.focus();
		});
		type(input, "ab");
		await hoverTab(2);
		const space = press(
			input,
			" ",
			{
				code: "Space",
			},
		);
		const tab = press(
			input,
			"Tab",
			{
				code: "Tab",
			},
		);

		expect(
			{
				value: input.value,
				space: space.defaultPrevented,
				tab: tab.defaultPrevented,
				focused: document.activeElement === input,
				commits,
				chips: chips().length,
			},
		).toStrictEqual(
			{
				value: "ab",
				space: true,
				tab: true,
				focused: true,
				commits: [],
				chips: 13,
			},
		);
	});

	it("selects tab 0 with Ctrl+N from nothing", () =>
	{
		const input = mount();
		press(
			input,
			"n",
			{
				code: "KeyN",
				ctrlKey: true,
			},
		);

		expect(document.body.textContent).toContain("For the jump to-menu");
	});
});

describe("search helper tabs", () =>
{
	it("opens the jump menu when the globe tab is clicked, and not for other tabs", () =>
	{
		mount();
		act(() =>
		{
			tabs()[2]?.click();
		});
		const afterDates = jumpOpens.length;
		act(() =>
		{
			tabs()[0]?.click();
		});

		expect(
			{
				afterDates,
				afterGlobe: jumpOpens.length,
			},
		).toStrictEqual(
			{
				afterDates: 0,
				afterGlobe: 1,
			},
		);
	});

	it("opens the jump menu on Enter by code, not on NumpadEnter", () =>
	{
		const input = mount();
		press(input, "ArrowDown");
		press(
			input,
			"Enter",
			{
				code: "NumpadEnter",
			},
		);
		const afterNumpad = jumpOpens.length;
		press(
			input,
			"Enter",
			{
				code: "Enter",
			},
		);

		expect(
			{
				afterNumpad,
				afterEnter: jumpOpens.length,
			},
		).toStrictEqual(
			{
				afterNumpad: 0,
				afterEnter: 1,
			},
		);
	});
});
