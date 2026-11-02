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
	searchQuery: string;
	searchFocused: boolean;
	zoomedNodeId: string | null;
	setSearchInput: (value: string) => void;
	setSearchFocused: (focused: boolean) => void;
	commitSearch: (query: string) => void;
	openJumpMenu: () => void;
	blurSearch: () => void;
}

const listeners = new Set<() => void>();
const commits: string[] = [];
const jumpOpens: number[] = [];
const blurs: number[] = [];
const tagData:
{
	tags: string[];
} =
{
	tags: [],
};
const initialState: StoreState =
{
	searchInput: "",
	searchQuery: "",
	searchFocused: true,
	zoomedNodeId: null,
	setSearchInput: (value) =>
	{
		setState(
			{
				searchInput: value,
			},
		);
	},
	setSearchFocused: (focused) =>
	{
		setState(
			{
				searchFocused: focused,
			},
		);
	},
	commitSearch: (query) =>
	{
		commits.push(query);
		setState(
			{
				searchInput: query,
				searchQuery: query,
			},
		);
	},
	openJumpMenu: () =>
	{
		jumpOpens.push(1);
	},
	blurSearch: () =>
	{
		blurs.push(1);
	},
};
let state: StoreState = initialState;

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
	useQuery: ({queryKey}: {queryKey: string[]}) => (
	{
		data: queryKey[0] === "search-autocomplete-tags" ? tagData.tags : undefined,
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
		...initialState,
	};
	commits.length = 0;
	jumpOpens.length = 0;
	blurs.length = 0;
	tagData.tags = [];
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
	const input = document.querySelector<HTMLInputElement>("#srch-input")!;
	act(() =>
	{
		input.focus();
	});
	return input;
}

async function settle(): Promise<void>
{
	await act(async () =>
	{
		await new Promise<void>((resolve) =>
		{
			setTimeout(resolve, 70);
		});
	});
}

async function type(input: HTMLInputElement, text: string): Promise<void>
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
	await settle();
}

function press(
	input: HTMLInputElement,
	code: string,
	init:
	{
		key?: string;
	} = {},
): KeyboardEvent
{
	const event = new KeyboardEvent(
		"keydown",
		{
			key: init.key ?? code,
			code,
			bubbles: true,
			cancelable: true,
		},
	);
	act(() =>
	{
		input.dispatchEvent(event);
	});
	return event;
}

function innerChildren(): string[]
{
	const inner = document.querySelector("label.searchBox > div")!;
	return [...inner.children].map((child) => `${child.tagName}.${child.className.split(" ")[0] ?? ""}`);
}

function rows(): HTMLElement[]
{
	return [...document.querySelectorAll<HTMLElement>(".wf-header a.menuItem")].filter(
		(row) => row.closest(".hidden") === null,
	);
}

function rowTexts(): string[]
{
	return rows().map((row) => row.textContent);
}

function activeText(): string[]
{
	return rows().flatMap((row) => (row.className.includes(" active") ? [row.textContent] : []));
}

describe("search autocomplete flyout", () =>
{
	it("shows the is: options between the hidden helpers and the input, with row 0 active", async () =>
	{
		const input = mount();
		await type(input, "is:");

		expect(
			{
				children: innerChildren().slice(0, 3),
				rows: rowTexts().length,
				active: activeText(),
				helpersClass: document.querySelector("label.searchBox > div > div")?.className,
			},
		).toStrictEqual(
			{
				children: ["DIV.hidden", "DIV.wf-header", "INPUT.m-0"],
				rows: 10,
				active: ["complete"],
				helpersClass: "hidden",
			},
		);
	});

	it("goes away after a space, restoring the helper row", async () =>
	{
		const input = mount();
		await type(input, "is:");
		await type(input, "is: ");

		expect(
			{
				rows: rowTexts().length,
				helpersClass: document.querySelector("label.searchBox > div > div")?.className,
			},
		).toStrictEqual(
			{
				rows: 0,
				helpersClass: "",
			},
		);
	});

	it("goes away on blur", async () =>
	{
		const input = mount();
		await type(input, "is:");
		act(() =>
		{
			input.blur();
		});
		await settle();

		expect(document.querySelector(".wf-header a.menuItem")).toBeNull();
	});

	it("narrows by the typed value", async () =>
	{
		const input = mount();
		await type(input, "has:n");

		expect(rowTexts()).toStrictEqual(["note"]);
	});

	it("puts a Tags header ahead of @ tag rows", async () =>
	{
		tagData.tags = ["@sa"];
		const input = mount();
		await type(input, "@s");

		const scroller = document.querySelector(".wf-header .scroller")!;
		expect(
			{
				first: scroller.firstElementChild?.className.includes("menu-section-header"),
				text: scroller.firstElementChild?.textContent,
				rows: rowTexts(),
			},
		).toStrictEqual(
			{
				first: true,
				text: "Tags",
				rows: ["@sa"],
			},
		);
	});
});

describe("search autocomplete keyboard and selection", () =>
{
	it("wraps ArrowUp to the last row and ArrowDown back to the first, leaving the caret alone", async () =>
	{
		const input = mount();
		await type(input, "is:");
		const up = press(input, "ArrowUp");
		const afterUp = activeText();
		const caret = input.selectionStart;
		press(input, "ArrowDown");

		expect(
			{
				up: up.defaultPrevented,
				afterUp,
				caret,
				afterDown: activeText(),
			},
		).toStrictEqual(
			{
				up: true,
				afterUp: ["quote"],
				caret: 3,
				afterDown: ["complete"],
			},
		);
	});

	it("selects the highlighted row on Enter with one immediate commit and focus kept", async () =>
	{
		const input = mount();
		await type(input, "is:");
		press(input, "ArrowDown");
		press(input, "Enter");
		await settle();

		expect(
			{
				value: input.value,
				caret: input.selectionStart,
				commits,
				focused: document.activeElement === input,
				rows: rowTexts().length,
			},
		).toStrictEqual(
			{
				value: "is:mirror ",
				caret: 10,
				commits: ["is:mirror "],
				focused: true,
				rows: 0,
			},
		);
	});

	it('turns in: into in:note:"" with the caret between the quotes', async () =>
	{
		const input = mount();
		await type(input, "in:");
		press(input, "Enter");
		const first =
		{
			value: input.value,
			caret: input.selectionStart,
		};

		await type(input, "is:shared in:");
		press(input, "Enter");

		expect(
			{
				first,
				second:
				{
					value: input.value,
					caret: input.selectionStart,
				},
			},
		).toStrictEqual(
			{
				first:
				{
					value: 'in:note:""',
					caret: 9,
				},
				second:
				{
					value: 'is:shared in:note:""',
					caret: 19,
				},
			},
		);
	});

	it("selects a clicked row", async () =>
	{
		const input = mount();
		await type(input, "day-of-week:");
		const wednesday = rows().find((row) => row.textContent === "Wednesday")!;
		act(() =>
		{
			wednesday.click();
		});

		expect(input.value).toBe("day-of-week:wednesday ");
	});

	it("leaves Tab to exit the search without selecting", async () =>
	{
		const input = mount();
		await type(input, "is:");
		press(input, "Tab");
		await settle();

		expect(
			{
				value: input.value,
				commits,
				blurs: blurs.length,
			},
		).toStrictEqual(
			{
				value: "is:",
				commits: [],
				blurs: 1,
			},
		);
	});

	it("does not claim Escape", async () =>
	{
		const input = mount();
		await type(input, "is:");
		const seen: boolean[] = [];
		const listener = (event: KeyboardEvent) =>
		{
			seen.push(event.defaultPrevented);
		};
		window.addEventListener("keydown", listener);
		const event = press(input, "Escape");
		window.removeEventListener("keydown", listener);

		expect(
			{
				seen,
				defaultPrevented: event.defaultPrevented,
			},
		).toStrictEqual(
			{
				seen: [false],
				defaultPrevented: false,
			},
		);
	});
});
