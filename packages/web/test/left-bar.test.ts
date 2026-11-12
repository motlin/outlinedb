import {describe, expect, it, vi} from "vite-plus/test";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {cssPreludes} from "./helpers/css-block.js";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import type {Star} from "@outlinedb/shared";
import type {LeftBarMode} from "../src/client/stores/outline.js";
import type * as ExpansionsModule from "../src/client/stores/left-bar-expansions.js";

const storeState =
{
	leftBarMode: "drawerClosed" as LeftBarMode,
	leftBarWidth: 296,
	leftBarHovered: false,
	draggingIds: [] as string[],
	starDragActive: false,
	stripDropKey: null as string | null,
	setStarDragActive: vi.fn<(active: boolean) => void>(),
	setLeftBarDrop: vi.fn<(drop: unknown) => void>(),
	toggleLeftBar: () =>
	{
	},
	closeLeftBarDrawer: () =>
	{
	},
	setLeftBarHovered: () =>
	{
	},
	setLeftBarWidth: () =>
	{
	},
	zoomedNodeId: null as string | null,
	startEditing: vi.fn<(id: string) => void>(),
	urlSearchQuery: null as string | null,
	leftBarSectionExpansions: {} as Record<string, boolean>,
	setLeftBarSectionExpanded: vi.fn<(key: string, value: boolean) => void>(),
};

vi.mock("../src/client/stores/outline.js", () => (
{
	useOutlineStore: (selector?: (state: typeof storeState) => unknown) =>
		selector === undefined ? storeState : selector(storeState),
}));
const navigateMock = vi.fn<(path: string) => void>();
const mutateMock = vi.fn<
	(
		payload: unknown,
		options?:
		{
			onSuccess?: (node: {id: string}) => void;
		},
	) => void
>();
let rootChildren:
{
	id: string;
}[] = [];
let starred: Star[] = [];
const toggleStarMock = vi.fn<(loc: {nodeId: string | null; query: string | null}) => Promise<boolean>>(async () =>
	Promise.resolve(false),
);
const nodesById: Record<
	string,
	{
		id: string;
		name: string;
		completedAt: null;
	}
> = {};

vi.mock("../src/client/hooks/use-starred.js", () => (
{
	STARS_UNAVAILABLE_TOOLTIP: "Stars need a workflowy.com login",
	useRecordStarViews: () =>
	{
	},
	useStarActions: () => (
	{
		toggleStar: toggleStarMock,
		renameStar: async () => Promise.resolve(),
	}),
	useStarredLocations: () => starred,
	useStars: () => (
	{
		stars: [],
		unavailable: false,
	}),
}));
vi.mock("../src/client/hooks/use-preferences.js", () => (
{
	useDateSettings: () => (
	{
		dateFormat: "YYYY-MM-DD ddd",
		timeFormat: "HH:mm",
		weekStartDay: 0,
	}),
}));
vi.mock("../src/client/hooks/use-calendar-settings.js", () => (
{
	useDayPrefix: () => true,
}));
vi.mock("react-router-dom", () => (
{
	useNavigate: () => navigateMock,
}));
vi.mock("../src/client/hooks/use-stable-navigate.js", () => (
{
	useStableNavigate: () => navigateMock,
}));
vi.mock("../src/client/hooks/use-nodes.js", () => (
{
	useChildren: () => (
	{
		data: rootChildren,
	}),
	useCreateNode: () => (
	{
		mutate: mutateMock,
	}),
	useNode: (id: string | null) => (
	{
		data: id === null ? undefined : nodesById[id],
	}),
}));
const expansionState =
{
	keys: new Set<string>(),
	toggle: vi.fn<(key: string) => void>(),
	load: async () =>
	{
	},
};
vi.mock("../src/client/stores/left-bar-expansions.js", async (importActual) => (
{
	...(await importActual<typeof ExpansionsModule>()),
	useLeftBarExpansionStore: (selector: (state: typeof expansionState) => unknown) => selector(expansionState),
}));
const navigateToTodayMock = vi.fn<() => Promise<void>>(async () => {});
const paneTodayMock = vi.fn<() => Promise<void>>(async () => {});
vi.mock("../src/client/hooks/use-navigate-to-today.js", () => (
{
	useNavigateToToday: (zoomTo?: unknown) => (zoomTo === undefined ? navigateToTodayMock : paneTodayMock),
}));
let focusedPane: string | null = null;
const zoomPaneMock = vi.fn<(paneId: string, id: string | null) => void>();
vi.mock("../src/client/left-bar-pane-nav.js", () => (
{
	focusedSidePaneId: () => focusedPane,
	zoomFocusedPane: (paneId: string, id: string | null) =>
	{
		zoomPaneMock(paneId, id);
	},
}));

const
{
	HomeSectionName,
	LeftBar,
	LeftBarSection,
	NewNodeButton,
	StarredRowControls,
	StarRenameInput,
	StarredSection,
	TodayRow,
	applyBodyOffset,
	resizeWidth,
} = await import("../src/client/components/left-sidebar.js");
const {TRIANGLE_PATH} = await import("../src/client/components/fa-icons.js");

function render(mode: LeftBarMode, hovered = false): string
{
	storeState.leftBarMode = mode;
	storeState.leftBarHovered = hovered;
	return renderToStaticMarkup(createElement(LeftBar));
}

function openTag(html: string, classPrefix: string): string
{
	const classAt = html.indexOf(` class="${classPrefix}`);
	if (classAt === -1)
	{
		throw new Error(`no element with class prefix ${classPrefix}`);
	}
	return html.slice(html.lastIndexOf("<div", classAt), html.indexOf(">", classAt) + 1);
}

const SHADOW = "absolute top-0 left-0 bottom-0 right-0 transition-[opacity]";
const SCROLLER = "absolute top-0 left-0 right-0 bottom-0 mr-1";
const PIN = "absolute top-m right-m";

describe("LeftBar shell", () =>
{
	it("renders the closed drawer offscreen below the header", () =>
	{
		const html = render("drawerClosed");
		expect(
			{
				outer: openTag(html, "fixed left-0"),
				inner: openTag(html, "wf-left-bar"),
				shadow: openTag(html, SHADOW),
				scroller: openTag(html, SCROLLER),
				pin: openTag(html, PIN),
				hoverTarget: html.includes("leftBarTopHiddenHoverTarget"),
				resizeTarget: html.includes("resizeTarget"),
			},
		).toStrictEqual(
			{
				outer: '<div class="fixed left-0 bottom-0 transition-[top] duration-250 ease-base leftBar" style="z-index:200;top:49px;width:var(--safe-area-inset-right)">',
				inner: '<div class="wf-left-bar absolute z-[2] box-border bg-primary  text-tertiary" style="top:12px;bottom:12px;left:-296px;width:296px;border-radius:0 6px 6px 0;transition:left 0.25s, bottom 0.25s">',
				shadow: `<div class="${SHADOW} duration-250 ease-base" style="border-radius:0 6px 6px 0;box-shadow:var(--wf-box-shadow-m);opacity:0">`,
				scroller: `<div class="${SCROLLER} pt-3xl pb-m overflow-x-hidden scroller vertical-scrollable-container" style="padding-left:var(--safe-area-inset-left);overflow-y:hidden;scrollbar-gutter:stable">`,
				pin: `<div role="button" tabindex="0" style="transform:rotate(135deg)" class="${PIN} transition-[transform] duration-250 ease-base iconButton lg shape-circle">`,
				hoverTarget: true,
				resizeTarget: false,
			},
		);
	});

	it("lets a hovered closed drawer scroll", () =>
	{
		expect(openTag(render("drawerClosed", true), SCROLLER)).toContain("overflow-y:auto");
	});

	it("renders the open drawer onscreen with its shadow", () =>
	{
		const html = render("drawerOpen");
		expect(
			{
				outer: openTag(html, "fixed left-0"),
				inner: openTag(html, "wf-left-bar"),
				shadow: openTag(html, SHADOW),
				scroller: openTag(html, SCROLLER),
				pin: openTag(html, PIN),
				hoverTarget: html.includes("leftBarTopHiddenHoverTarget"),
				resizeTarget: html.includes("resizeTarget"),
			},
		).toStrictEqual(
			{
				outer: '<div class="fixed left-0 bottom-0 transition-[top] duration-250 ease-base leftBar" style="z-index:200;top:49px;width:var(--safe-area-inset-right)">',
				inner: '<div class="wf-left-bar absolute z-[2] box-border bg-primary  text-tertiary" style="top:12px;bottom:12px;left:0;width:296px;border-radius:0 6px 6px 0;transition:left 0.25s, bottom 0.25s">',
				shadow: `<div class="${SHADOW} duration-250 ease-base" style="border-radius:0 6px 6px 0;box-shadow:var(--wf-box-shadow-m);opacity:1">`,
				scroller: `<div class="${SCROLLER} pt-3xl pb-m overflow-x-hidden scroller vertical-scrollable-container" style="padding-left:var(--safe-area-inset-left);overflow-y:auto;scrollbar-gutter:stable">`,
				pin: `<div role="button" tabindex="0" style="transform:rotate(135deg)" class="${PIN} transition-[transform] duration-250 ease-base iconButton lg shape-circle">`,
				hoverTarget: true,
				resizeTarget: false,
			},
		);
	});

	it("renders the pinned bar full height with edge and resize target", () =>
	{
		const html = render("alwaysOpen");
		expect(
			{
				outer: openTag(html, "fixed left-0"),
				inner: openTag(html, "wf-left-bar"),
				shadow: openTag(html, SHADOW),
				edge: openTag(html, "absolute top-0 bottom-0 -right-px"),
				resize: openTag(html, "resizeTarget"),
				pin: openTag(html, PIN),
				hoverTarget: html.includes("leftBarTopHiddenHoverTarget"),
			},
		).toStrictEqual(
			{
				outer: '<div class="fixed left-0 bottom-0 transition-[top] duration-250 ease-base leftBar" style="z-index:200;top:0;width:var(--safe-area-inset-right)">',
				inner: '<div class="wf-left-bar absolute z-[2] box-border bg-secondary text-tertiary" style="top:0;bottom:0;left:0;width:296px;border-radius:0 0px 0px 0;overflow-x:hidden;transition:left 0.25s, bottom 0.25s">',
				shadow: `<div class="${SHADOW} duration-250 ease-base" style="border-radius:0 0px 0px 0;box-shadow:var(--wf-box-shadow-m);opacity:0">`,
				edge: '<div class="absolute top-0 bottom-0 -right-px w-px shadow-[0_2px_10px_rgba(0,0,0,0.5)]">',
				resize: '<div class="resizeTarget absolute top-0 bottom-0 right-0 w-[4px] cursor-ew-resize">',
				pin: `<div role="button" tabindex="0" style="transform:rotate(0deg)" class="${PIN} transition-[transform] duration-250 ease-base iconButton lg shape-circle">`,
				hoverTarget: false,
			},
		);
	});

	it("renders the arrow-left icon inside the pin", () =>
	{
		expect(render("alwaysOpen")).toContain('data-icon="arrow-left"');
	});
});

describe("LeftBarSection", () =>
{
	const header = (open: boolean) =>
		'<div class="relative pl-xl flex items-center font-normal text-secondary mb-m hover:cursor-pointer left-bar-section-header group ">' +
		`<div class="absolute -top-[3px] left-2xs flex items-center justify-center ${open ? "opacity-25" : "opacity-50"} hover:opacity-100 group-hover:opacity-100 sectionArrow ${open ? "expanded" : ""}">` +
		'<div><svg width="20" height="20" viewBox="0 0 20 20" class="block transition-transform duration-200 ease-base [.expanded_&amp;]:rotate-90">' +
		`<path d="${TRIANGLE_PATH}" stroke="none" fill="currentColor"></path></svg></div></div>Home</div>`;

	function renderSection(expansions: Record<string, boolean>): string
	{
		storeState.leftBarSectionExpansions = expansions;
		return renderToStaticMarkup(
			createElement(
				LeftBarSection,
				{
					name: "Home",
					contextKey: "leftbar__home__",
				},
				createElement("p", null, "kids"),
			),
		);
	}

	it("renders an open section by default with children and a 24px spacer", () =>
	{
		expect(renderSection({})).toBe(`${header(true)}<p>kids</p><div style="margin-bottom:24px"></div>`);
	});

	it("renders a collapsed section without children and a 16px spacer", () =>
	{
		expect(
			renderSection(
				{
					leftbar__home__: false,
				},
			),
		).toBe(`${header(false)}<div style="margin-bottom:16px"></div>`);
	});

	it("persists the toggled state under its context key", () =>
	{
		storeState.leftBarSectionExpansions = {};
		storeState.setLeftBarSectionExpanded.mockClear();
		const fragment = LeftBarSection(
			{
				name: "Home",
				contextKey: "leftbar__home__",
			},
		) as
		{
			props:
			{
				children: [
					{
						props:
						{
							onClick: () => void;
						};
					},
				];
			};
		};
		fragment.props.children[0].props.onClick();
		expect(storeState.setLeftBarSectionExpanded.mock.calls).toStrictEqual([["leftbar__home__", false]]);
	});
});

describe("Home section name in a focused side pane", () =>
{
	it("zooms that pane to Home instead of navigating", () =>
	{
		navigateMock.mockClear();
		zoomPaneMock.mockClear();
		focusedPane = "p1";
		const span = HomeSectionName() as
		{
			props:
			{
				onClick: (event: unknown) => void;
			};
		};
		span.props.onClick(
			{
				stopPropagation: () =>
				{
				},
			},
		);
		focusedPane = null;
		expect(
			{
				zoom: zoomPaneMock.mock.calls,
				navigate: navigateMock.mock.calls,
			},
		).toStrictEqual(
			{
				zoom: [["p1", null]],
				navigate: [],
			},
		);
	});
});

describe("Home section name", () =>
{
	it("navigates to the root without toggling the section", () =>
	{
		navigateMock.mockClear();
		storeState.setLeftBarSectionExpanded.mockClear();
		const span = HomeSectionName() as
		{
			props:
			{
				className: string;
				children: string;
				onClick: (event: unknown) => void;
			};
		};
		const stopPropagation = vi.fn<() => void>();
		span.props.onClick(
			{
				stopPropagation,
			},
		);
		expect(
			{
				className: span.props.className,
				children: span.props.children,
				navigate: navigateMock.mock.calls,
				stopped: stopPropagation.mock.calls.length,
				toggled: storeState.setLeftBarSectionExpanded.mock.calls,
			},
		).toStrictEqual(
			{
				className: "hover:underline",
				children: "Home",
				navigate: [["/"]],
				stopped: 1,
				toggled: [],
			},
		);
	});
});

describe("TodayRow", () =>
{
	it("renders upstream's Today block with the light calendar-day icon", () =>
	{
		const html = renderToStaticMarkup(createElement(TodayRow)).replace(/ d="[^"]*"/u, "");
		expect(html).toBe(
			'<div class="my-xl mx-l desktop:mt-m desktop:mb-2xl"><div class="relative flex flex-row px-m py-s rounded-m gap-m text-secondary hover:bg-tertiary active:bg-tertiary cursor-pointer" data-left-bar-today="">' +
				'<svg aria-hidden="true" focusable="false" data-prefix="fal" data-icon="calendar-day" class="svg-inline--fa fa-calendar-day fa-1x text-tertiary" role="img" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 512"><path fill="currentColor"></path></svg>' +
				"<span>Today</span></div></div>",
		);
	});

	it("paints a quaternary background and a bar under the label while a drag hovers it", () =>
	{
		storeState.stripDropKey = "left-bar-today";
		const html = renderToStaticMarkup(createElement(TodayRow)).replace(/ d="[^"]*"/u, "");
		storeState.stripDropKey = null;
		expect(html.slice(0, html.indexOf("<svg"))).toBe(
			'<div class="my-xl mx-l desktop:mt-m desktop:mb-2xl"><div class="relative flex flex-row px-m py-s rounded-m gap-m text-secondary hover:bg-tertiary active:bg-tertiary cursor-pointer" data-left-bar-today="" style="background:var(--wf-background-quaternary)">' +
				'<div class="absolute left-[24px] right-0 bottom-0 h-[4px] rounded-full" style="background:#ccc"></div>',
		);
	});

	it("zooms the focused side pane to today instead of the main outline", () =>
	{
		navigateToTodayMock.mockClear();
		paneTodayMock.mockClear();
		focusedPane = "p1";
		const wrapper = TodayRow() as
		{
			props:
			{
				children:
				{
					props:
					{
						onClick: () => void;
					};
				};
			};
		};
		wrapper.props.children.props.onClick();
		focusedPane = null;
		expect(
			{
				main: navigateToTodayMock.mock.calls,
				pane: paneTodayMock.mock.calls,
			},
		).toStrictEqual(
			{
				main: [],
				pane: [[]],
			},
		);
	});

	it("zooms to today instead of navigating to the root", () =>
	{
		navigateMock.mockClear();
		navigateToTodayMock.mockClear();
		const wrapper = TodayRow() as
		{
			props:
			{
				children:
				{
					props:
					{
						onClick: () => void;
					};
				};
			};
		};
		wrapper.props.children.props.onClick();
		expect(
			{
				today: navigateToTodayMock.mock.calls,
				navigate: navigateMock.mock.calls,
			},
		).toStrictEqual(
			{
				today: [[]],
				navigate: [],
			},
		);
	});
});

describe("NewNodeButton", () =>
{
	it("renders upstream's pill button markup", () =>
	{
		const html = renderToStaticMarkup(createElement(NewNodeButton)).replace(/ d="[^"]*"/u, "");
		expect(html).toBe(
			'<div class="mt-ml mx-xl"><button tabindex="0" class="w-full cursor-pointer button"><span class="">' +
				'<svg aria-hidden="true" focusable="false" data-prefix="fal" data-icon="plus" class="svg-inline--fa fa-plus fa-1x mr-xs opacity-50" role="img" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 512"><path fill="currentColor"></path></svg>' +
				" New node</span></button></div>",
		);
	});

	it("creates an empty node at the end of the root, ignoring the zoomed node, and edits it", () =>
	{
		mutateMock.mockClear();
		storeState.startEditing.mockClear();
		storeState.zoomedNodeId = "abc";
		rootChildren = [
			{
				id: "a",
			},
			{
				id: "b",
			},
			{
				id: "c",
			},
		];
		const wrapper = NewNodeButton() as
		{
			props:
			{
				children:
				{
					props:
					{
						onClick: () => void;
					};
				};
			};
		};
		wrapper.props.children.props.onClick();
		mutateMock.mock.calls[0]?.[1]?.onSuccess?.(
			{
				id: "new-id",
			},
		);
		expect(
			{
				payloads: mutateMock.mock.calls.map((call) => call[0]),
				editing: storeState.startEditing.mock.calls,
			},
		).toStrictEqual(
			{
				payloads: [
					{
						name: "",
						position: 3,
					},
				],
				editing: [["new-id"]],
			},
		);
		storeState.zoomedNodeId = null;
		rootChildren = [];
	});
});

describe("Starred section", () =>
{
	const ROW_CLASS =
		"flex justify-between items-center pr-m hover:cursor-pointer hover:no-underline left-bar-section-item font-custom ";
	const INNER = '<div class="flex grow items-center min-w-0 h-[30px] pl-xs text-tertiary" style="font-weight:400">';
	const ARROW =
		'<div class="flex shrink-0 items-center justify-center opacity-[var(--opacity)] hover:opacity-[var(--hover-opacity)] arrow " data-left-bar-controls="true" style="--opacity:0.45;--hover-opacity:1">';
	const STAR_CLASS = "!text-spark hover:!bg-quaternary iconButton sm shape-square";
	const PLUS_CLASS = " hover:!bg-quaternary add-node iconButton sm shape-square";

	function star(overrides: Partial<Star>): Star
	{
		return {
			key: "k",
			nodeId: null,
			query: null,
			name: null,
			position: 0,
			...overrides,
		};
	}

	function renderStarred(stars: Star[]): string
	{
		starred = stars;
		storeState.leftBarSectionExpansions = {};
		const html = renderToStaticMarkup(createElement(StarredSection))
			.replaceAll(/ d="[^"]*"/gu, "")
			.replaceAll(/<svg width="20"[\s\S]*?<\/svg>/gu, "TRI");
		starred = [];
		return html;
	}

	function rows(html: string): string
	{
		return html.slice(
			html.indexOf('<div draggable="true" class="relative">'),
			html.lastIndexOf('<div style="margin-bottom'),
		);
	}

	it("renders nothing when nothing is starred", () =>
	{
		expect(renderStarred([])).toBe("");
	});

	it("renders a search row with the magnifier slot and its page name", () =>
	{
		nodesById.x =
		{
			id: "x",
			name: "<b>Xname</b>",
			completedAt: null,
		};
		expect(
			rows(
				renderStarred([
					star(
						{
							key: "x_date:past",
							nodeId: "x",
							query: "date:past",
						},
					),
				]),
			),
		).toBe(
			`<div draggable="true" class="relative">` +
				`<a href="/#/x?q=date%3Apast" data-location-url="/#/x?q=date%3Apast" draggable="false" class="${ROW_CLASS}" style="padding-left:12px;color:var(--wf-text-tertiary)">${
					INNER
				}<div class="flex shrink-0 items-center justify-center" style="width:20px;height:20px">` +
				`<svg aria-hidden="true" focusable="false" data-prefix="fas" data-icon="magnifying-glass" class="svg-inline--fa fa-magnifying-glass fa-xs " role="img" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path fill="currentColor"></path></svg></div>` +
				`<div class="grow py-xs truncate" data-expanded="false"><span>date:past <span class="font-light text-[.8em] opacity-75">in ` +
				`<span style="pointer-events:none;white-space:nowrap"><span class="innerContentContainer"><b>Xname</b></span></span></span></span></div>` +
				`</div></a></div>`,
		);
	});

	it("names a Home search in Home", () =>
	{
		expect(
			renderStarred([
				star(
					{
						key: "None_#a",
						query: "#a",
					},
				),
			]),
		).toContain(
			'<span>#a <span class="font-light text-[.8em] opacity-75">in <span style="pointer-events:none;white-space:nowrap"><span class="innerContentContainer">Home</span></span></span></span>',
		);
	});

	it("renders a page row as an expandable FilesList row with the node's rich name", () =>
	{
		nodesById.p =
		{
			id: "p",
			name: "<i>Page</i>",
			completedAt: null,
		};
		expect(
			rows(
				renderStarred([
					star(
						{
							key: "p",
							nodeId: "p",
						},
					),
				]),
			),
		).toBe(
			`<div draggable="true" class="relative">` +
				`<a href="/#/p" data-location-url="/#/p" draggable="false" class="${ROW_CLASS}" style="padding-left:12px;color:var(--wf-text-tertiary)">${
					INNER
				}${ARROW}<div>TRI</div></div><div class="grow py-xs truncate" data-expanded="false"><span style="pointer-events:none;white-space:nowrap"><span class="innerContentContainer"><i>Page</i></span></span></div>` +
				`</div></a></div>`,
		);
	});

	it("keeps only the depth-0 row in the draggable wrapper and renders expanded children as flat siblings", async () =>
	{
		nodesById.p =
		{
			id: "p",
			name: "Page",
			completedAt: null,
		};
		starred = [
			star(
				{
					key: "p",
					nodeId: "p",
				},
			),
		];
		storeState.leftBarSectionExpansions = {};
		const {leftBarExpansionKey, pageUniqueId} = await import("../src/client/stores/left-bar-expansions.js");
		expansionState.keys = new Set([leftBarExpansionKey("starred", pageUniqueId("p"), "p")]);
		rootChildren = [
			{
				id: "c1",
				name: "Child",
				completedAt: null,
				hasChildren: false,
			},
		] as never;
		const html = renderToStaticMarkup(createElement(StarredSection));
		expansionState.keys = new Set();
		rootChildren = [];
		starred = [];
		const wrapperEnd = html.indexOf("</a></div>") + "</a></div>".length;
		expect(
			{
				wrapperStart: html.slice(html.indexOf('<div draggable="true"'), html.indexOf("<a ")),
				anchorsInWrapper: html.slice(0, wrapperEnd).split("<a ").length - 1,
				nextIsChildRow: html.slice(wrapperEnd).startsWith('<a href="'),
				childPadding: html.slice(wrapperEnd).includes("padding-left:24px"),
			},
		).toStrictEqual(
			{
				wrapperStart: '<div draggable="true" class="relative">',
				anchorsInWrapper: 1,
				nextIsChildRow: true,
				childPadding: true,
			},
		);
	});

	it("labels a renamed star with its custom name", () =>
	{
		nodesById.p =
		{
			id: "p",
			name: "Page",
			completedAt: null,
		};
		expect(
			renderStarred([
				star(
					{
						key: "p",
						nodeId: "p",
						name: "Alice",
					},
				),
			]),
		).toContain('<span class="innerContentContainer">Alice</span>');
	});

	it("renders rows in the order the hook returns", () =>
	{
		nodesById.a =
		{
			id: "a",
			name: "Zed",
			completedAt: null,
		};
		nodesById.b =
		{
			id: "b",
			name: "Abe",
			completedAt: null,
		};
		const html = renderStarred([
			star(
				{
					key: "a",
					nodeId: "a",
				},
			),
			star(
				{
					key: "b",
					nodeId: "b",
				},
			),
		]);
		expect(html.indexOf(">Zed<") < html.indexOf(">Abe<")).toBe(true);
	});

	it("gives a page row a star then a plus control", () =>
	{
		const html = renderToStaticMarkup(
			createElement(
				StarredRowControls,
				{
					star: star(
						{
							key: "p",
							nodeId: "p",
						},
					),
				},
			),
		);
		expect([...html.matchAll(/class="([^"]*iconButton[^"]*)"/gu)].map((match) => match[1])).toStrictEqual([
			STAR_CLASS,
			PLUS_CLASS,
		]);
	});

	it("gives a search row a pencil then the star control", () =>
	{
		const html = renderToStaticMarkup(
			createElement(
				StarredRowControls,
				{
					star: star(
						{
							key: "p_x",
							nodeId: "p",
							query: "x",
						},
					),
				},
			),
		);
		expect([...html.matchAll(/class="([^"]*iconButton[^"]*)"/gu)].map((match) => match[1])).toStrictEqual([
			"hover:!bg-quaternary iconButton sm shape-square",
			STAR_CLASS,
		]);
	});

	interface Control
	{
		props:
		{
			onClick: (event: unknown) => void;
		};
	}
	function controls(target: Star): Control[]
	{
		const element = StarredRowControls(
			{
				star: target,
			},
		) as
		{
			props:
			{
				children: (Control | null)[];
			};
		};
		return element.props.children.filter((child): child is Control => child !== null);
	}
	const event = () => (
	{
		preventDefault: vi.fn<() => void>(),
		stopPropagation: vi.fn<() => void>(),
	});

	it("unstars the row's location from the star control without following the link", () =>
	{
		toggleStarMock.mockClear();
		const click = event();
		controls(
			star(
				{
					key: "p_x",
					nodeId: "p",
					query: "x",
				},
			),
		)[1]?.props.onClick(click);
		expect(
			{
				calls: toggleStarMock.mock.calls,
				prevented: click.preventDefault.mock.calls.length,
				stopped: click.stopPropagation.mock.calls.length,
			},
		).toStrictEqual(
			{
				calls: [
					[
						{
							nodeId: "p",
							query: "x",
						},
					],
				],
				prevented: 1,
				stopped: 1,
			},
		);
	});

	it("navigates to the page and creates an empty first child from the plus control", () =>
	{
		navigateMock.mockClear();
		mutateMock.mockClear();
		storeState.startEditing.mockClear();
		controls(
			star(
				{
					key: "p",
					nodeId: "p",
				},
			),
		)[1]?.props.onClick(event());
		mutateMock.mock.calls[0]?.[1]?.onSuccess?.(
			{
				id: "new-id",
			},
		);
		expect(
			{
				navigate: navigateMock.mock.calls,
				payloads: mutateMock.mock.calls.map((call) => call[0]),
				editing: storeState.startEditing.mock.calls,
			},
		).toStrictEqual(
			{
				navigate: [["/#/p"]],
				payloads: [
					{
						parent_id: "p",
						name: "",
						position: 0,
					},
				],
				editing: [["new-id"]],
			},
		);
	});
});

describe("Starred search rename", () =>
{
	it("renders a small DomKit text input", () =>
	{
		const html = renderToStaticMarkup(
			createElement(
				StarRenameInput,
				{
					initial: "Old",
					onCommit: () =>
					{
					},
					onCancel: () =>
					{
					},
				},
			),
		);
		expect(
			{
				wrapper: html.startsWith('<div class="flex flex-col w-full"><input'),
				text: html.includes('type="text"') && html.includes('value="Old"'),
				small: html.includes("p-m rounded-s py-xs px-s"),
			},
		).toStrictEqual(
			{
				wrapper: true,
				text: true,
				small: true,
			},
		);
	});

	it("renames on Enter and cancels on Escape or blur", () =>
	{
		const onCommit = vi.fn<(value: string) => void>();
		const onCancel = vi.fn<() => void>();
		const root = StarRenameInput(
			{
				initial: "Old",
				onCommit,
				onCancel,
			},
		) as
		{
			props:
			{
				children:
				{
					props:
					{
						onKeyDown: (e: unknown) => void;
						onBlur: () => void;
					};
				};
			};
		};
		const {onKeyDown, onBlur} = root.props.children.props;
		const key = (name: string) => (
		{
			key: name,
			preventDefault: () =>
			{
			},
			stopPropagation: () =>
			{
			},
			currentTarget:
			{
				value: "New",
			},
		});
		onKeyDown(key("Enter"));
		const afterEnter = [onCommit.mock.calls, onCancel.mock.calls.length];
		onKeyDown(key("Escape"));
		onBlur();
		expect(
			{
				afterEnter,
				commits: onCommit.mock.calls.length,
				cancels: onCancel.mock.calls.length,
			},
		).toStrictEqual(
			{
				afterEnter: [[["New"]], 0],
				commits: 1,
				cancels: 2,
			},
		);
	});
});

describe("resizeWidth", () =>
{
	it("follows the pointer and clamps to 160", () =>
	{
		expect([resizeWidth(296, 296, 350), resizeWidth(296, 296, 200), resizeWidth(296, 296, 10)]).toStrictEqual([
			350, 200, 160,
		]);
	});
});

describe("applyBodyOffset", () =>
{
	it("pads the body by the offset with upstream's transition", () =>
	{
		const pinned =
		{
			transition: "",
			paddingLeft: "",
		};
		const drawer =
		{
			transition: "",
			paddingLeft: "",
		};
		applyBodyOffset(pinned, 296);
		applyBodyOffset(drawer, 0);
		expect([pinned, drawer]).toStrictEqual([
			{
				transition: "padding-left .25s",
				paddingLeft: "296px",
			},
			{
				transition: "padding-left .25s",
				paddingLeft: "0px",
			},
		]);
	});
});

describe("left bar styles", () =>
{
	const styles = readFileSync(fileURLToPath(new URL("../src/client/styles.css", import.meta.url)), "utf8").replaceAll(
		/\/\*[\s\S]*?\*\//gu,
		"",
	);

	it("inherits line-height 1 from the reset on .wf-left-bar", () =>
	{
		expect(/\.wf-left-bar\s*\{\s*font-size:\s*16px;\s*\}/u.test(styles)).toBe(true);
	});

	it("hides the left bar when printing", () =>
	{
		expect(/@media print\s*\{\s*\.leftBar\s*\{\s*display:\s*none;\s*\}\s*\}/u.test(styles)).toBe(true);
	});

	it("drops the with-sidebar margin rule", () =>
	{
		expect(styles.includes("with-sidebar")).toBe(false);
	});

	it("adds no .scroller padding rule so the left bar scroller keeps its pt-3xl and pb-m", () =>
	{
		const preludes = new Set(cssPreludes(styles).map((prelude) => prelude.trim()));
		expect(
			{
				bareScroller: preludes.has(".scroller"),
				outlineScroller: preludes.has(".outline-tree-container > .scroller"),
			},
		).toStrictEqual(
			{
				bareScroller: false,
				outlineScroller: false,
			},
		);
	});

	it("removes the body padding when printing", () =>
	{
		expect(/@media print\s*\{\s*body\s*\{\s*padding-left:\s*0\s*!important;?\s*\}\s*\}/u.test(styles)).toBe(true);
	});
});
