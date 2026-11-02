import {describe, expect, it, vi} from "vite-plus/test";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";

interface Ancestor
{
	id: string;
	name: string | null;
	calendar?:
	{
		root?: boolean;
		dayPrefix?: boolean;
		level?: string;
		dateId?: number;
	};
	data?:
	{
		layoutMode: string | null;
	};
	attachment?:
	{
		fileName: string;
		fileType: string;
		isDeleted: boolean;
	};
}

const ancestorsState:
{
	data: Ancestor[] | undefined;
	isLoading: boolean;
} =
{
	data: undefined,
	isLoading: false,
};

vi.mock("../src/client/hooks/use-account.js", () => (
{
	useAccount: () => null,
}));
vi.mock("../src/client/hooks/use-nodes.js", () => (
{
	useAncestors: () => (
	{
		...ancestorsState,
		data: ancestorsState.data?.map((node) => (
		{
			...node,
			data: node.data ??
			{
				layoutMode: null,
			},
		})),
	}),
}));
const storeState =
{
	searchQuery: "",
};
vi.mock("../src/client/stores/outline.js", () => (
{
	useOutlineStore: Object.assign(
		(selector: (state: typeof storeState) => unknown) => selector(storeState),
		{
			getState: () => storeState,
		},
	),
}));
vi.mock(import("../src/client/breadcrumb-layout.js"), async (importOriginal) => (
{
	...(await importOriginal()),
	measureCrumbLabel: (label: string) => label.length * 7,
}));
vi.mock("../src/client/navigation.js", () => (
{
	nodeUrl: (nodeId: string) => `/#/${nodeId.slice(-12)}`,
	useNodeNavigation: () => (
	{
		navigateToNode: () =>
		{
		},
		cancelSearch: () =>
		{
		},
	}),
}));
vi.mock("../src/client/crumb-zoom.js", () => (
{
	useCrumbZoomOut: () => () =>
	{
	},
}));

const dateSettingsState =
{
	dateFormat: "ddd, MMM D",
	timeFormat: "h:mma",
	weekStartDay: 0,
};
vi.mock("../src/client/hooks/use-preferences.js", () => (
{
	useDateSettings: () => dateSettingsState,
}));
const calendarSettingsState =
{
	foundDates: true,
	dayPrefix: true,
};
/** The settings cache's Friendly day names value, or undefined before it loads. */
const cachedDayPrefix:
{
	value: boolean | undefined;
} =
{
	value: undefined,
};
vi.mock("../src/client/hooks/use-calendar-settings.js", () => (
{
	useCalendarSettings: () => (
	{
		settings: calendarSettingsState,
		toggle: () =>
		{
		},
	}),
	useDayPrefix: (rootDayPrefix: boolean | null | undefined) => cachedDayPrefix.value ?? rootDayPrefix !== false,
}));

vi.stubGlobal(
	"window",
	{
		innerWidth: 1272,
	},
);

const {Breadcrumbs, BreadcrumbOverflowMenu, FlatCrumbs, LeftCollapsingCrumbs, handleCrumbClick, preventCrumbMouseDown} =
	await import("../src/client/components/breadcrumbs.js");

const CRUMB_CLASS =
	"breadcrumb-item flex-shrink-0 whitespace-nowrap overflow-hidden truncate {state}\n    data-hj-suppress hover:pointer-fine:opacity-100 hover:pointer-fine:underline cursor-pointer";

const HOUSE_SVG =
	'<svg aria-hidden="true" focusable="false" data-prefix="fal" data-icon="house" class="svg-inline--fa fa-house fa-lg " role="img" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 576 512"><path fill="currentColor"></path></svg>';

const SEPARATOR =
	'<svg width="5" height="8" viewBox="0 0 5 8" fill="none" class="flex-shrink-0"><path d="M0 0 L4 4 L0 8" stroke="currentColor" stroke-linecap="round"></path></svg>';

const CONTAINER_OPEN =
	'<div class="breadcrumbs grow shrink min-w-0 flex gap-m items-center text-s leading-base overflow-hidden">';

function crumbClass(current: boolean): string
{
	return CRUMB_CLASS.replace("{state}", current ? "current opacity-100" : "opacity-70");
}

function render(nodeId: string | null, ancestors: Ancestor[] | undefined, isLoading = false, searchQuery = ""): string
{
	storeState.searchQuery = searchQuery;
	ancestorsState.data = ancestors;
	ancestorsState.isLoading = isLoading;
	// Strip FontAwesome path data; keep the separator chevron's path.
	return renderToStaticMarkup(
		createElement(
			Breadcrumbs,
			{
				nodeId,
			},
		),
	).replaceAll(/ d="([^"]*)"/gu, (match, d) => (d === "M0 0 L4 4 L0 8" ? match : ""));
}

const ROOT_MARKUP = `${CONTAINER_OPEN}<div class="${crumbClass(true)}"><div role="button" tabindex="-1" aria-disabled="true" data-handbook="nav.home" class="homeButton disabled iconButton lg shape-circle disabled">${HOUSE_SVG}</div></div></div>`;

function todayDay():
{
	level: string;
	dateId: number;
}
{
	const now = new Date();
	return {
		level: "day",
		dateId: now.getFullYear() * 10_000 + (now.getMonth() + 1) * 100 + now.getDate(),
	};
}

function todayName(): string
{
	const now = new Date();
	return `<time startYear="${now.getFullYear()}" startMonth="${now.getMonth() + 1}" startDay="${now.getDate()}">today</time>`;
}

/** Today in the account default "ddd, MMM D". */
function todayLabel(): string
{
	const now = new Date();
	const weekday = now.toLocaleDateString(
		"en-US",
		{
			weekday: "short",
		},
	);
	const month = now.toLocaleDateString(
		"en-US",
		{
			month: "short",
		},
	);
	return `${weekday}, ${month} ${now.getDate()}`;
}

describe("Breadcrumbs markup", () =>
{
	it("renders a disabled current Home crumb at the root", () =>
	{
		expect(render(null, undefined)).toBe(ROOT_MARKUP);
	});

	it("enables Home at the root while a search is committed", () =>
	{
		expect(render(null, undefined, false, "x")).toBe(
			`${CONTAINER_OPEN}<a class="${crumbClass(true)}" href="/" data-item-id="None"><div role="button" tabindex="0" data-handbook="nav.home" class="homeButton  iconButton lg shape-circle">${HOUSE_SVG}</div></a></div>`,
		);
	});

	it("renders the root shape while ancestors load", () =>
	{
		expect(render("bob-uuid", undefined, true)).toBe(ROOT_MARKUP);
	});

	it("renders flat anchors with a separator after every non-current crumb", () =>
	{
		const html = render("bob-uuid", [
			{
				id: "alice-uuid",
				name: "Alice",
			},
			{
				id: "bob-uuid",
				name: "<b>Bob</b>",
			},
		]);
		expect(html).toBe(
			[
				CONTAINER_OPEN,
				`<a class="${crumbClass(false)}" href="/" data-item-id="None"><div role="button" tabindex="0" data-handbook="nav.home" class="homeButton  iconButton lg shape-circle">${HOUSE_SVG}</div></a>`,
				SEPARATOR,
				`<a class="${crumbClass(false)}" href="/#/alice-uuid" data-item-id="alice-uuid">Alice</a>`,
				SEPARATOR,
				`<a class="${crumbClass(true)}" href="/#/bob-uuid" data-item-id="bob-uuid">Bob</a>`,
				"</div>",
			].join(""),
		);
	});

	it("renders an empty-named crumb as an empty anchor", () =>
	{
		const html = render("empty-uuid", [
			{
				id: "empty-uuid",
				name: "",
			},
		]);
		expect(html.slice(html.lastIndexOf("<a "))).toBe(
			`<a class="${crumbClass(true)}" href="/#/empty-uuid" data-item-id="empty-uuid"></a></div>`,
		);
	});

	it("labels a date-node ancestor in the default account date format, like its pill", () =>
	{
		const html = render("day-uuid", [
			{
				id: "day-uuid",
				name: '<time startYear="2020" startMonth="3" startDay="5">Thu, Mar 5, 2020</time>',
			},
		]);
		expect(html.slice(html.lastIndexOf("<a "))).toBe(
			`<a class="${crumbClass(true)}" href="/#/day-uuid" data-item-id="day-uuid">Thu, Mar 5, 2020</a></div>`,
		);
	});

	it("formats a date-node ancestor with the account's date format", () =>
	{
		dateSettingsState.dateFormat = "MM/DD/YYYY";
		const html = render("day-uuid", [
			{
				id: "day-uuid",
				name: '<time startYear="2020" startMonth="3" startDay="5">Thu, Mar 5, 2020</time>',
			},
		]);
		dateSettingsState.dateFormat = "ddd, MMM D";
		expect(html.slice(html.lastIndexOf("<a "))).toBe(
			`<a class="${crumbClass(true)}" href="/#/day-uuid" data-item-id="day-uuid">03/05/2020</a></div>`,
		);
	});

	it("prefixes today's day crumb with Today when the calendar root keeps Friendly day names", () =>
	{
		const html = render("day-uuid", [
			{
				id: "cal-uuid",
				name: "Calendar",
				calendar:
				{
					root: true,
					dayPrefix: true,
				},
			},
			{
				id: "day-uuid",
				name: todayName(),
				calendar: todayDay(),
			},
		]);
		expect(html.slice(html.lastIndexOf("<a "))).toBe(
			`<a class="${crumbClass(true)}" href="/#/day-uuid" data-item-id="day-uuid">Today, ${todayLabel()}</a></div>`,
		);
	});

	it("adds no Today prefix to a non-calendar node named only by today's pill", () =>
	{
		const html = render("day-uuid", [
			{
				id: "day-uuid",
				name: todayName(),
			},
		]);
		expect(html.slice(html.lastIndexOf("<a "))).toBe(
			`<a class="${crumbClass(true)}" href="/#/day-uuid" data-item-id="day-uuid">${todayLabel()}</a></div>`,
		);
	});

	it("drops the Today prefix when the calendar root turns Friendly day names off", () =>
	{
		const html = render("day-uuid", [
			{
				id: "cal-uuid",
				name: "Calendar",
				calendar:
				{
					root: true,
					dayPrefix: false,
				},
			},
			{
				id: "day-uuid",
				name: todayName(),
				calendar: todayDay(),
			},
		]);
		expect(html.slice(html.lastIndexOf("<a "))).toBe(
			`<a class="${crumbClass(true)}" href="/#/day-uuid" data-item-id="day-uuid">${todayLabel()}</a></div>`,
		);
	});

	it("follows the settings cache over the ancestors' root value, so a Friendly day names toggle shows at once", () =>
	{
		cachedDayPrefix.value = false;
		const html = render("day-uuid", [
			{
				id: "cal-uuid",
				name: "Calendar",
				calendar:
				{
					root: true,
					dayPrefix: true,
				},
			},
			{
				id: "day-uuid",
				name: todayName(),
				calendar: todayDay(),
			},
		]);
		cachedDayPrefix.value = undefined;
		expect(html.slice(html.lastIndexOf("<a "))).toBe(
			`<a class="${crumbClass(true)}" href="/#/day-uuid" data-item-id="day-uuid">${todayLabel()}</a></div>`,
		);
	});
});

function longName(name: string): string
{
	return name.padEnd(40, ".");
}

const DEEP_ANCESTORS: Ancestor[] = ["Sandbox", "Alpha", "Bravo", "Charlie", "Delta", "Echo"].map((name) => (
{
	id: `${name.toLowerCase()}-uuid`,
	name: longName(name),
}));

/** Top-level tags of the container, in order. */
function childTags(html: string): string[]
{
	const inner = html.slice(CONTAINER_OPEN.length, -"</div>".length);
	const tags: string[] = [];
	let depth = 0;
	for (const match of inner.matchAll(/<(\/?)([a-z]+)[^>]*?(\/?)>/gu))
	{
		const [, closing, tag, selfClosing] = match;
		if (closing === "/")
		{
			depth--;
		}
		else if (selfClosing !== "/")
		{
			if (depth === 0)
			{
				tags.push(tag);
			}
			depth++;
		}
	}
	return tags;
}

function renderLeft(
	crumbs:
	{
		id: string;
		isRoot: boolean;
		name?: string | null;
		dayDateId?: number | null;
	}[],
): string
{
	return renderToStaticMarkup(
		createElement(
			LeftCollapsingCrumbs,
			{
				crumbs,
			},
		),
	);
}

describe("LeftCollapsingCrumbs labels", () =>
{
	it("prefixes a today crumb with Today when the calendar keeps Friendly day names", () =>
	{
		calendarSettingsState.dayPrefix = true;
		const html = renderLeft([
			{
				id: "day-uuid",
				isRoot: false,
				name: todayName(),
				dayDateId: todayDay().dateId,
			},
		]);
		expect(html.slice(html.indexOf("<a "))).toBe(
			`<a class="${crumbClass(false)}" href="/#/day-uuid" data-item-id="day-uuid">Today, ${todayLabel()}</a></div>`,
		);
	});

	it("drops the Today prefix when the calendar turns Friendly day names off", () =>
	{
		calendarSettingsState.dayPrefix = false;
		const html = renderLeft([
			{
				id: "day-uuid",
				isRoot: false,
				name: todayName(),
				dayDateId: todayDay().dateId,
			},
		]);
		calendarSettingsState.dayPrefix = true;
		expect(html.slice(html.indexOf("<a "))).toBe(
			`<a class="${crumbClass(false)}" href="/#/day-uuid" data-item-id="day-uuid">${todayLabel()}</a></div>`,
		);
	});

	it("formats a date crumb with the account's date format", () =>
	{
		dateSettingsState.dateFormat = "MM/DD/YYYY";
		const html = renderLeft([
			{
				id: "day-uuid",
				isRoot: false,
				name: '<time startYear="2020" startMonth="3" startDay="5">x</time>',
			},
		]);
		dateSettingsState.dateFormat = "ddd, MMM D";
		expect(html.slice(html.indexOf("<a "))).toBe(
			`<a class="${crumbClass(false)}" href="/#/day-uuid" data-item-id="day-uuid">03/05/2020</a></div>`,
		);
	});
});

function renderFlat(
	crumbs:
	{
		id: string;
		isRoot: boolean;
		name?: string | null;
		dayDateId?: number | null;
	}[],
): string
{
	return renderToStaticMarkup(
		createElement(
			FlatCrumbs,
			{
				crumbs,
			},
		),
	);
}

describe("FlatCrumbs labels", () =>
{
	it("prefixes a today crumb with Today when the calendar keeps Friendly day names", () =>
	{
		calendarSettingsState.dayPrefix = true;
		expect(
			renderFlat([
				{
					id: "day-uuid",
					isRoot: false,
					name: todayName(),
					dayDateId: todayDay().dateId,
				},
			]),
		).toBe(
			`${CONTAINER_OPEN}<a class="${crumbClass(false)}" href="/#/day-uuid" data-item-id="day-uuid">Today, ${todayLabel()}</a></div>`,
		);
	});

	it("drops the Today prefix when the calendar turns Friendly day names off", () =>
	{
		calendarSettingsState.dayPrefix = false;
		const html = renderFlat([
			{
				id: "day-uuid",
				isRoot: false,
				name: todayName(),
				dayDateId: todayDay().dateId,
			},
		]);
		calendarSettingsState.dayPrefix = true;
		expect(html).toBe(
			`${CONTAINER_OPEN}<a class="${crumbClass(false)}" href="/#/day-uuid" data-item-id="day-uuid">${todayLabel()}</a></div>`,
		);
	});

	it("formats a date crumb with the account's date format", () =>
	{
		dateSettingsState.dateFormat = "MM/DD/YYYY";
		const html = renderFlat([
			{
				id: "day-uuid",
				isRoot: false,
				name: '<time startYear="2020" startMonth="3" startDay="5">x</time>',
			},
		]);
		dateSettingsState.dateFormat = "ddd, MMM D";
		expect(html).toBe(
			`${CONTAINER_OPEN}<a class="${crumbClass(false)}" href="/#/day-uuid" data-item-id="day-uuid">03/05/2020</a></div>`,
		);
	});

	it("separates crumbs with a chevron", () =>
	{
		expect(
			renderFlat([
				{
					id: "a-uuid",
					isRoot: false,
					name: "A",
				},
				{
					id: "b-uuid",
					isRoot: false,
					name: "B",
				},
			]),
		).toBe(
			`${CONTAINER_OPEN}<a class="${crumbClass(false)}" href="/#/a-uuid" data-item-id="a-uuid">A</a>${SEPARATOR}<a class="${crumbClass(false)}" href="/#/b-uuid" data-item-id="b-uuid">B</a></div>`,
		);
	});
});

describe("Breadcrumbs overflow", () =>
{
	it("truncates and collapses a deep trail into one ellipsis menu at 675px", () =>
	{
		vi.stubGlobal(
			"window",
			{
				innerWidth: 675,
			},
		);
		const html = render("echo-uuid", DEEP_ANCESTORS);
		vi.stubGlobal(
			"window",
			{
				innerWidth: 1272,
			},
		);
		expect(
			{
				tags: childTags(html),
				menus: html.split('<div tabindex="0" class="relative outline-none menu ">').length - 1,
				maxWidths: [...html.matchAll(/style="max-width:(\d+)px" href="[^"]*" data-item-id="([^"]+)"/gu)].map(
					([, width, id]) => [id, Number(width)],
				),
				ellipsis: html.includes(
					'<div tabindex="0" class="relative outline-none menu "><div><div role="button" tabindex="0" class="iconButton md shape-circle"><svg aria-hidden="true" focusable="false" data-prefix="fal" data-icon="ellipsis" class="svg-inline--fa fa-ellipsis fa-1x "',
				),
			},
		).toStrictEqual(
			{
				tags: ["a", "svg", "a", "svg", "a", "svg", "div", "svg", "a", "svg", "a"],
				menus: 1,
				maxWidths: [
					["sandbox-uuid", 118],
					["alpha-uuid", 118],
					["delta-uuid", 118],
					["echo-uuid", 118],
				],
				ellipsis: true,
			},
		);
	});

	it("only truncates, without an ellipsis menu, when the window is wide enough", () =>
	{
		const html = render("echo-uuid", DEEP_ANCESTORS);
		expect(
			{
				tags: childTags(html),
				menu: html.includes("outline-none menu"),
			},
		).toStrictEqual(
			{
				tags: ["a", "svg", "a", "svg", "a", "svg", "a", "svg", "a", "svg", "a", "svg", "a"],
				menu: false,
			},
		);
	});

	it("renders the collapsed crumbs as a separator-free vertical list", () =>
	{
		const html = renderToStaticMarkup(
			createElement(
				BreadcrumbOverflowMenu,
				{
					items: [
						{
							id: "bravo-uuid",
							label: longName("Bravo"),
							group: 1,
							isZoomed: false,
							truncateWidth: null,
						},
						{
							id: "charlie-uuid",
							label: longName("Charlie"),
							group: 1,
							isZoomed: false,
							truncateWidth: null,
						},
					],
					crumbs: new Map([
						[
							"bravo-uuid",
							{
								id: "bravo-uuid",
								isRoot: false,
								name: longName("Bravo"),
							},
						],
						[
							"charlie-uuid",
							{
								id: "charlie-uuid",
								isRoot: false,
								name: longName("Charlie"),
							},
						],
					]),
					currentId: "echo-uuid",
					maxWidth: 822,
					onNavigate: () =>
					{
					},
				},
			),
		);
		expect(html).toBe(
			[
				'<div class="max-w-[822px] flex flex-col items-stretch gap-m px-m breadcrumb-overflow-menu">',
				`<div><a class="${crumbClass(false)}" href="/#/bravo-uuid" data-item-id="bravo-uuid">${longName("Bravo")}</a></div>`,
				`<div><a class="${crumbClass(false)}" href="/#/charlie-uuid" data-item-id="charlie-uuid">${longName("Charlie")}</a></div>`,
				"</div>",
			].join(""),
		);
	});
});

function clickEvent(
	overrides: Partial<
	{
		altKey: boolean;
		ctrlKey: boolean;
		metaKey: boolean;
		shiftKey: boolean;
		button: number;
	}>,
)
{
	return {
		altKey: false,
		ctrlKey: false,
		metaKey: false,
		shiftKey: false,
		button: 0,
		...overrides,
		preventDefault: vi.fn<() => void>(),
		stopPropagation: vi.fn<() => void>(),
	};
}

function clickDeps()
{
	return {
		navigateToNode: vi.fn<(nodeId: string | null) => void>(),
		cancelSearch: vi.fn<() => void>(),
		leaveSearch: vi.fn<() => void>(),
		scrollToTop: vi.fn<() => void>(),
		focusWindow: vi.fn<() => void>(),
	};
}

type ClickEvent = ReturnType<typeof clickEvent>;
type ClickDeps = ReturnType<typeof clickDeps>;

function calls(event: ClickEvent, deps: ClickDeps)
{
	return {
		preventDefault: event.preventDefault.mock.calls,
		stopPropagation: event.stopPropagation.mock.calls,
		focusWindow: deps.focusWindow.mock.calls,
		cancelSearch: deps.cancelSearch.mock.calls,
		leaveSearch: deps.leaveSearch.mock.calls,
		navigate: deps.navigateToNode.mock.calls,
		scrollToTop: deps.scrollToTop.mock.calls,
	};
}

const NOTHING =
{
	preventDefault: [],
	stopPropagation: [],
	focusWindow: [],
	cancelSearch: [],
	leaveSearch: [],
	navigate: [],
	scrollToTop: [],
};

const ALICE =
{
	id: "alice-uuid",
	isRoot: false,
};

describe("handleCrumbClick", () =>
{
	it("leaves a meta-click to the browser", () =>
	{
		const event = clickEvent(
			{
				metaKey: true,
			},
		);
		const deps = clickDeps();
		handleCrumbClick(
			event,
			ALICE,
			{
				current: false,
				searchActive: true,
			},
			deps,
		);
		expect(calls(event, deps)).toStrictEqual(NOTHING);
	});

	it("leaves a middle-click to the browser", () =>
	{
		const event = clickEvent(
			{
				button: 1,
			},
		);
		const deps = clickDeps();
		handleCrumbClick(
			event,
			ALICE,
			{
				current: false,
				searchActive: true,
			},
			deps,
		);
		expect(calls(event, deps)).toStrictEqual(NOTHING);
	});

	it("focuses the window, leaves search without its own URL push, navigates and scrolls to top on a plain click", () =>
	{
		const event = clickEvent({});
		const deps = clickDeps();
		handleCrumbClick(
			event,
			ALICE,
			{
				current: false,
				searchActive: true,
			},
			deps,
		);
		expect(calls(event, deps)).toStrictEqual(
			{
				...NOTHING,
				preventDefault: [[]],
				focusWindow: [[]],
				leaveSearch: [[]],
				navigate: [["alice-uuid"]],
				scrollToTop: [[]],
			},
		);
	});

	it("leaves search and navigates in one push when the current crumb is clicked", () =>
	{
		const event = clickEvent({});
		const deps = clickDeps();
		handleCrumbClick(
			event,
			ALICE,
			{
				current: true,
				searchActive: true,
			},
			deps,
		);
		expect(calls(event, deps)).toStrictEqual(
			{
				...NOTHING,
				preventDefault: [[]],
				focusWindow: [[]],
				leaveSearch: [[]],
				navigate: [["alice-uuid"]],
				scrollToTop: [[]],
			},
		);
	});

	it("navigates to the root on a plain Home click", () =>
	{
		const event = clickEvent({});
		const deps = clickDeps();
		handleCrumbClick(
			event,
			{
				id: "None",
				isRoot: true,
			},
			{
				current: false,
				searchActive: false,
			},
			deps,
		);
		expect(deps.navigateToNode.mock.calls).toStrictEqual([[null]]);
	});

	it("only cancels the search when the root Home is clicked during a search", () =>
	{
		const event = clickEvent({});
		const deps = clickDeps();
		handleCrumbClick(
			event,
			{
				id: "None",
				isRoot: true,
			},
			{
				current: true,
				searchActive: true,
			},
			deps,
		);
		expect(calls(event, deps)).toStrictEqual(
			{
				...NOTHING,
				preventDefault: [[]],
				stopPropagation: [[]],
				focusWindow: [[]],
				cancelSearch: [[]],
				scrollToTop: [[]],
			},
		);
	});
});

describe("preventCrumbMouseDown", () =>
{
	it("keeps the caret by preventing the mousedown default", () =>
	{
		const event =
		{
			preventDefault: vi.fn<() => void>(),
		};
		preventCrumbMouseDown(event);
		expect(event.preventDefault.mock.calls).toStrictEqual([[]]);
	});
});

describe("Breadcrumbs item:icon decorations", () =>
{
	it("prefixes a divider crumb with the upstream hr", () =>
	{
		const html = render("div-uuid", [
			{
				id: "div-uuid",
				name: "",
				data:
				{
					layoutMode: "divider",
				},
			},
		]);
		expect(html.slice(html.lastIndexOf("<a "))).toBe(
			`<a class="${crumbClass(true)}" href="/#/div-uuid" data-item-id="div-uuid"><hr class="min-w-l w-full h-px border-0 border-t border-solid border-color text-center m-0 mt-xs"/></a></div>`,
		);
	});

	it("prefixes an image file crumb with a tertiary file-image icon and a non-breaking space", () =>
	{
		const html = render("img-uuid", [
			{
				id: "img-uuid",
				name: "photo.png",
				attachment:
				{
					fileName: "photo.png",
					fileType: "image/png",
					isDeleted: false,
				},
			},
		]);
		const anchor = html.slice(html.lastIndexOf("<a "));
		expect(
			{
				icon: /data-icon="([^"]+)"/u.exec(anchor)?.[1],
				color: /style="color:var\(--wf-text-tertiary\)"/u.test(anchor),
				text: anchor.slice(anchor.indexOf("</svg>") + "</svg>".length),
			},
		).toStrictEqual(
			{
				icon: "file-image",
				color: true,
				text: "\u00A0photo.png</a></div>",
			},
		);
	});

	it("picks the audio, video and generic file icons by mime prefix and ignores deleted files", () =>
	{
		const icon = (fileType: string, isDeleted = false) =>
		{
			const html = render("f-uuid", [
				{
					id: "f-uuid",
					name: "f",
					attachment:
					{
						fileName: "f",
						fileType,
						isDeleted,
					},
				},
			]);
			return /data-icon="(file[^"]*)"/u.exec(html)?.[1];
		};
		expect([icon("audio/wav"), icon("video/mp4"), icon("application/pdf"), icon("image/png", true)]).toStrictEqual([
			"file-audio",
			"file-video",
			"file",
			undefined,
		]);
	});
});

describe("Breadcrumbs pane layout", () =>
{
	it("collapses the leftmost crumbs first, Home included, with pane sizes and maxWidth", () =>
	{
		ancestorsState.data = DEEP_ANCESTORS;
		ancestorsState.isLoading = false;
		storeState.searchQuery = "";
		const html = renderToStaticMarkup(
			createElement(
				Breadcrumbs,
				{
					nodeId: "echo-uuid",
					sizes:
					{
						rightMargin: 8,
						itemGap: 18,
						ellipsisWidth: 28,
					},
					maxWidth: 400,
					threeDotPosition: "left",
				},
			),
		);
		expect(
			{
				tags: childTags(html),
				first: html.slice(CONTAINER_OPEN.length, CONTAINER_OPEN.length + 40),
				ids: [...html.matchAll(/data-item-id="([^"]+)"/gu)].map(([, id]) => id),
			},
		).toStrictEqual(EXPECTED_PANE_LAYOUT);
	});
});

const EXPECTED_PANE_LAYOUT =
{
	tags: ["div", "svg", "a", "svg", "a", "svg", "a"],
	first: '<div tabindex="0" class="relative outlin',
	ids: ["charlie-uuid", "delta-uuid", "echo-uuid"],
};
