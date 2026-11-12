import {describe, expect, it, vi} from "vite-plus/test";
import type * as UsePreferencesModule from "../src/client/hooks/use-preferences.js";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {createElement, useContext} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import type * as IconButtonModule from "../src/client/components/icon-button.js";
import {cssBlock} from "./helpers/css-block.js";

interface PaneState
{
	id: string;
	zoomedId: string | null;
	backLocations: (string | null)[];
	forwardLocations: (string | null)[];
	query: string;
	expandedIds: Set<string>;
}
const calls:
{
	close: string[];
	zoom: string[];
	activate: string[];
	history: string[];
	opened: unknown[][];
	queries: string[];
} =
{
	close: [],
	zoom: [],
	activate: [],
	history: [],
	opened: [],
	queries: [],
};
const B = "BBBBBBBBBBB";
const C = "CCCCCCCCCCC";
const D = "DDDDDDDDDDD";
function paneState(id: string, zoomedId: string | null): PaneState
{
	return {
		id,
		zoomedId,
		backLocations: [],
		forwardLocations: [],
		query: "",
		expandedIds: new Set(),
	};
}
const BOB = paneState(B, "bob");
const storeState:
{
	panes: PaneState[];
	activePaneId: string;
	paneWidths: Record<string, number>;
} & Record<string, unknown> =
{
	panes: [BOB],
	activePaneId: B,
	paneWidths:
	{
		main: 400,
		[B]: 540,
		[C]: 600,
		[D]: 700,
	},
	workspaceWidth: null,
	paneResizing: false,
	leftBarOffset: () => 0,
	setPaneWidths: () =>
	{
	},
	setPaneResizing: () =>
	{
	},
	setWorkspaceWidth: () =>
	{
	},
	setActivePane: (paneId: string) =>
	{
		calls.activate.push(paneId);
	},
	closePane: (paneId: string) =>
	{
		calls.close.push(paneId);
	},
	zoomPane: (paneId: string, zoomedId: string | null) =>
	{
		calls.zoom.push(`${paneId}:${zoomedId ?? "home"}`);
	},
	paneBack: (paneId: string) =>
	{
		calls.history.push(`back:${paneId}`);
	},
	paneForward: (paneId: string) =>
	{
		calls.history.push(`forward:${paneId}`);
	},
	openPane: (zoomedId: string | null, options?: unknown) =>
	{
		calls.opened.push([zoomedId, options]);
		return "NEW";
	},
	setPaneQuery: (paneId: string, query: string) =>
	{
		calls.queries.push(`${paneId}:${query}`);
	},
};

/** Render with `panes` open, restoring the one-pane default afterwards. */
function withPanes<T>(panes: PaneState[], run: () => T): T
{
	storeState.panes = panes;
	try
	{
		return run();
	}
	finally
	{
		storeState.panes = [BOB];
	}
}

vi.mock("../src/client/stores/outline.js", () => (
{
	useOutlineStore: Object.assign(
		(selector?: (state: typeof storeState) => unknown) =>
			selector === undefined ? storeState : selector(storeState),
		{
			getState: () => storeState,
		},
	),
	workspaceWidths: (state: typeof storeState) =>
		["main", ...state.panes.map((pane) => pane.id)].map((id) => state.paneWidths[id] ?? 380),
	workspaceAvailableWidth: () => 1416,
}));

vi.mock("react-router-dom", () => (
{
	useNavigate: () => () =>
	{
	},
}));
vi.mock("@tanstack/react-query", () => (
{
	useQueryClient: () => ({}),
}));

const {PaneContext, paneActivation} = await import("../src/client/components/pane-context.js");

/** Records the pane context each OutlineTree sees, so tests can check bullet zooms stay in the pane. */
const seenPaneZooms: ((id: string | null) => void)[] = [];
const seenPaneIds: string[] = [];
vi.mock("../src/client/components/outline-tree.js", () => (
{
	OutlineTree: ({parentId}: {parentId: string | null}) =>
	{
		const pane = useContext(PaneContext);
		if (pane !== null)
		{
			seenPaneZooms.push(pane.zoom);
			seenPaneIds.push(pane.id);
		}
		return createElement(
			"div",
			{
				className: "outline-tree-mock",
				"data-parent": parentId ?? "home",
			},
		);
	},
}));

type IconButtonProps = Parameters<typeof IconButtonModule.IconButton>[0];
const buttons = new Map<string, IconButtonProps>();
vi.mock("../src/client/components/icon-button.js", async (importOriginal) =>
{
	const actual = await importOriginal<typeof IconButtonModule>();
	return {
		...actual,
		IconButton: (props: IconButtonProps) =>
		{
			if (typeof props.tooltip === "string")
			{
				buttons.set(props.tooltip, props);
			}
			return actual.IconButton(props);
		},
	};
});

/** The pane header's breadcrumbs: records the zoom they show and where their clicks go. */
const crumbProps:
{
	nodeId: string | null;
	onNavigate?: (id: string | null) => void;
	scrollToTop?: () => void;
	sizes?: unknown;
	maxWidth?: number;
	threeDotPosition?: string;
}[] = [];
vi.mock("../src/client/components/breadcrumbs.js", () => (
{
	Breadcrumbs: (props: (typeof crumbProps)[number]) =>
	{
		crumbProps.push(props);
		return createElement(
			"div",
			{
				className: "breadcrumbs-mock",
			},
		);
	},
}));

/** The account's calendar.tooltip_seen as the Today controls read it. */
const tooltipSeen:
{
	value: boolean | null;
} =
{
	value: true,
};
vi.mock("../src/client/hooks/use-preferences.js", async (importOriginal) => (
{
	...(await importOriginal<typeof UsePreferencesModule>()),
	useCalendarTooltipSeen: () => tooltipSeen.value,
}));

/** Today in the pane header: records the zoom it targets. */
const today:
{
	zoomTo: ((id: string) => void) | undefined;
} =
{
	zoomTo: undefined,
};
vi.mock("../src/client/hooks/use-navigate-to-today.js", () => (
{
	useNavigateToToday: (zoomTo?: (id: string) => void) =>
	{
		today.zoomTo = zoomTo;
		return async () => Promise.resolve();
	},
}));

/** The pane's compact search box: records the query it shows and where commits go. */
const searchProps:
{
	query: string;
	compact?: boolean;
	onCommit: (query: string) => void;
}[] = [];
vi.mock("../src/client/components/pane-search-box.js", () => (
{
	PaneSearchBox: (props: (typeof searchProps)[number]) =>
	{
		searchProps.push(props);
		return createElement(
			"div",
			{
				className: "pane-search-mock",
			},
		);
	},
}));

/** The pane's kebab: records the zoom its compactable items act on and whether it carries Today. */
const menuZooms: (string | null)[] = [];
const menuToday: boolean[] = [];
vi.mock("../src/client/components/header-more-menu.js", () => (
{
	HeaderMoreMenu: ({zoomedId, onToday}: {zoomedId: string | null; onToday?: () => void}) =>
	{
		menuZooms.push(zoomedId);
		menuToday.push(onToday !== undefined);
		return createElement(
			"div",
			{
				className: "more-menu-mock",
			},
		);
	},
}));

const {MainPane, PaneWorkspace, SidePanes} = await import("../src/client/components/side-pane.js");

const styles = readFileSync(fileURLToPath(new URL("../src/client/styles.css", import.meta.url)), "utf8");

function render(): string
{
	return renderToStaticMarkup(
		createElement(
			SidePanes,
			{
				onUndo: () =>
				{
				},
				onRedo: () =>
				{
				},
			},
		),
	);
}

describe("SidePanes", () =>
{
	it("renders nothing when no pane is open", () =>
	{
		expect(withPanes([], render)).toBe("");
	});

	it("renders every open pane left to right as fixed-width workspace columns, like upstream", () =>
	{
		const html = withPanes([BOB, paneState(C, "carol"), paneState(D, null)], render);
		const tags = [...html.matchAll(/<div id="pane-[^"]*"[^>]*>/gu)].map(([tag]) => tag);
		const base = "group/pane relative box-border flex-none h-full max-h-full min-h-0 bg-primary flex flex-col";
		const last = "[&amp;_.header]:pr-[var(--pane-workspace-control-width)] [&amp;_.header]:min-w-[280px]";
		const active = "print:block print:!w-auto print:!min-w-0 print:!h-auto print:!max-h-none";
		expect(
			{
				first: html.startsWith(`<div id="pane-${B}"`),
				tags,
			},
		).toStrictEqual(
			{
				first: true,
				tags: [
					[B, 540, `${base} ${active}`],
					[C, 600, `${base} print:hidden`],
					[D, 700, `${base} print:hidden ${last}`],
				].map(
					([id, width, classes]) =>
						`<div id="pane-${id}" data-pane-id="${id}" data-pane-type="item-tree" data-pane-active="${id === B ? "true" : "false"}" class="${classes}" style="width:${width}px;min-width:350px">`,
				),
			},
		);
	});

	it("puts a 6px role=separator on every pane's right edge, the last included, with upstream's aria attributes", () =>
	{
		const html = withPanes([BOB, paneState(C, "carol"), paneState(D, null)], render);
		const separators = [...html.matchAll(/<div aria-controls[^>]*role="separator"[^>]*>/gu)].map(([tag]) => tag);
		const classes =
			"absolute top-0 right-0 bottom-0 w-[6px] cursor-col-resize touch-none select-none border-r border-solid border-primary hover:bg-tertiary focus-visible:bg-tertiary focus-visible:outline-none print:hidden";
		const separator = (n: number, controls: string, min: number, now: number, text: string) =>
			`<div aria-controls="${controls}" aria-label="Resize pane ${n}" aria-orientation="vertical" aria-valuemin="${min}" aria-valuenow="${now}" aria-valuetext="${text}" class="${classes}" data-pane-drag-ignore="true" role="separator" style="z-index:200" tabindex="0">`;
		expect(separators).toStrictEqual([
			separator(2, `pane-${B} pane-${C}`, 350, 540, "540 and 600 pixels"),
			separator(3, `pane-${C} pane-${D}`, 350, 600, "600 and 700 pixels"),
			separator(4, `pane-${D}`, 350, 700, "700 pixels"),
		]);
	});

	it("marks the pane inactive while the main pane is active", () =>
	{
		storeState.activePaneId = "main";
		const html = render();
		storeState.activePaneId = B;
		expect(html).toContain('data-pane-active="false"');
	});

	it("tells each pane's outline which pane it renders in", () =>
	{
		seenPaneIds.length = 0;
		withPanes([BOB, paneState(C, "carol")], render);
		expect(seenPaneIds).toStrictEqual([B, C]);
	});

	it("renders a wf-pane-header with upstream's Back, breadcrumbs, Today and Close pane", () =>
	{
		buttons.clear();
		const html = render();
		expect(html).toContain(
			'<div class="wf-header header bg-primary wf-pane-header border-b border-solid border-primary group-data-[pane-active=true]/pane:border-b-tint flex-shrink-0">',
		);
		expect(
			{
				buttons: [...buttons.keys()],
				backDisabled: buttons.get("Back")?.disabled,
				crumbsAfterBack: html.indexOf("breadcrumbs-mock") > html.indexOf("chevron-left"),
			},
		).toStrictEqual(
			{
				buttons: ["Back", "Today", "Close pane"],
				backDisabled: true,
				crumbsAfterBack: true,
			},
		);
	});

	it("enables Back and shows Forward when the pane has history, stepping that pane's history", () =>
	{
		buttons.clear();
		calls.history.length = 0;
		withPanes(
			[
				{
					...BOB,
					backLocations: [null],
					forwardLocations: ["carol"],
				},
			],
			render,
		);
		buttons.get("Back")?.onClick?.({} as never);
		buttons.get("Forward")?.onClick?.({} as never);
		expect(
			{
				buttons: [...buttons.keys()],
				backDisabled: buttons.get("Back")?.disabled,
				history: calls.history,
			},
		).toStrictEqual(
			{
				buttons: ["Back", "Forward", "Today", "Close pane"],
				backDisabled: false,
				history: [`back:${B}`, `forward:${B}`],
			},
		);
	});

	it("shows the pane's zoom in breadcrumbs that zoom the pane", () =>
	{
		crumbProps.length = 0;
		calls.zoom.length = 0;
		render();
		const crumbs = crumbProps.at(-1);
		crumbs?.onNavigate?.("alice");
		crumbs?.onNavigate?.(null);
		expect(
			{
				nodeId: crumbs?.nodeId,
				zoom: calls.zoom,
				scrolls: typeof crumbs?.scrollToTop,
			},
		).toStrictEqual(
			{
				nodeId: "bob",
				zoom: [`${B}:alice`, `${B}:home`],
				scrolls: "function",
			},
		);
	});

	it("lays pane crumbs out with the pane's width, sizes and left collapse", () =>
	{
		crumbProps.length = 0;
		render();
		const crumbs = crumbProps.at(-1);
		expect(
			{
				sizes: crumbs?.sizes,
				maxWidth: crumbs?.maxWidth,
				threeDotPosition: crumbs?.threeDotPosition,
			},
		).toStrictEqual(
			{
				sizes:
				{
					rightMargin: 8,
					itemGap: 18,
					ellipsisWidth: 28,
				},
				maxWidth: 180,
				threeDotPosition: "left",
			},
		);
	});

	it("zooms the pane, not the main outline, to today", () =>
	{
		calls.zoom.length = 0;
		const html = render();
		today.zoomTo?.("day1");
		expect(
			{
				zoom: calls.zoom,
				hasTodayTarget: html.includes("calendar-day"),
			},
		).toStrictEqual(
			{
				zoom: [`${B}:day1`],
				hasTodayTarget: true,
			},
		);
	});

	it("orders the header's right cluster like upstream: search circle, Today, kebab, Close pane", () =>
	{
		const html = render();
		const order = ["pane-search-mock", "calendar-day", "more-menu-mock", "xmark"].map((marker) =>
			html.indexOf(marker),
		);
		expect(
			{
				found: order.every((index) => index > 0),
				ordered: order.every((index, i) => i === 0 || index > (order[i - 1] ?? 0)),
			},
		).toStrictEqual(
			{
				found: true,
				ordered: true,
			},
		);
	});

	it("moves Today into the kebab when the pane is narrower than 530px, like upstream's width < 530 compaction", () =>
	{
		const widthOf = (width: number) =>
		{
			storeState.paneWidths[B] = width;
			menuToday.length = 0;
			try
			{
				const html = render();
				return {
					todayButton: html.includes("calendar-day"),
					kebabHasToday: menuToday.at(-1),
				};
			}
			finally
			{
				storeState.paneWidths[B] = 540;
			}
		};
		expect(
			{
				narrow: widthOf(350),
				edge: widthOf(529),
				wide: widthOf(530),
			},
		).toStrictEqual(
			{
				narrow:
				{
					todayButton: false,
					kebabHasToday: true,
				},
				edge:
				{
					todayButton: false,
					kebabHasToday: true,
				},
				wide:
				{
					todayButton: true,
					kebabHasToday: false,
				},
			},
		);
	});

	it("hides the kebab's Today row until calendar.tooltip_seen, like upstream's more-menu.menu.header.today", () =>
	{
		const seenAs = (value: boolean | null) =>
		{
			tooltipSeen.value = value;
			storeState.paneWidths[B] = 350;
			menuToday.length = 0;
			try
			{
				render();
				return menuToday.at(-1);
			}
			finally
			{
				tooltipSeen.value = true;
				storeState.paneWidths[B] = 540;
			}
		};
		expect(
			{
				seen: seenAs(true),
				unseen: seenAs(false),
				loading: seenAs(null),
			},
		).toStrictEqual(
			{
				seen: true,
				unseen: false,
				loading: false,
			},
		);
	});

	it("shows the calendar onboarding button in place of the pane's Today until calendar.tooltip_seen", () =>
	{
		const seenAs = (value: boolean | null) =>
		{
			tooltipSeen.value = value;
			try
			{
				const html = render();
				return {
					onboarding: html.includes('class="shape-circle iconButton lg"'),
					calendarDay: html.includes("fa-calendar-day "),
				};
			}
			finally
			{
				tooltipSeen.value = true;
			}
		};
		expect(
			{
				seen: seenAs(true),
				unseen: seenAs(false),
				loading: seenAs(null),
			},
		).toStrictEqual(
			{
				seen:
				{
					onboarding: false,
					calendarDay: true,
				},
				unseen:
				{
					onboarding: true,
					calendarDay: true,
				},
				loading:
				{
					onboarding: false,
					calendarDay: false,
				},
			},
		);
	});

	it("gives the pane a compact search box over its own query that commits to the pane", () =>
	{
		searchProps.length = 0;
		calls.queries.length = 0;
		withPanes(
			[
				{
					...BOB,
					query: "#todo",
				},
			],
			render,
		);
		const search = searchProps.at(-1);
		search?.onCommit("#done");
		expect(
			{
				query: search?.query,
				compact: search?.compact,
				queries: calls.queries,
			},
		).toStrictEqual(
			{
				query: "#todo",
				compact: true,
				queries: [`${B}:#done`],
			},
		);
	});

	it("points each pane's kebab at that pane's zoom", () =>
	{
		menuZooms.length = 0;
		withPanes([BOB, paneState(C, "carol")], render);
		expect(menuZooms).toStrictEqual(["bob", "carol"]);
	});

	it("renders the outline zoomed to the pane's node inside its own scroller", () =>
	{
		const scroller =
			'<div class="relative flex flex-1 min-h-0 flex-col"><div class="flex-1 min-h-0 py-l pr-2xl overflow-auto overscroll-contain relative vertical-scrollable-container print:!overflow-visible pl-[calc(var(--wf-space-xl)+var(--side-pane-menu-gutter))] [--name-left-overhang:60px] [&amp;&gt;.project.root]:w-full [&amp;&gt;.project.root]:max-w-[700px] [&amp;&gt;.project.root]:mx-auto [&amp;&gt;.project.root]:data-[full-width-active=true]:!max-w-none [&amp;&gt;.project.root]:!max-w-none" data-full-width-boundary="true" style="--side-pane-menu-gutter:32px"><div class="outline-tree-mock" data-parent="bob"></div><div class="document-end flex-grow flex-shrink-0 print:hidden" style="height:380px"></div></div></div>';
		expect(render()).toContain(scroller);
	});

	it("wraps the header and body in upstream's split-pane boundary", () =>
	{
		expect(render()).toContain(
			'<div class="flex flex-1 min-h-0 flex-col" data-full-width-boundary="true" data-split-pane="true"><div class="wf-header header',
		);
	});

	it("renders Home's outline for a null pane zoom", () =>
	{
		expect(withPanes([paneState(B, null)], render)).toContain('data-parent="home"');
	});

	it("closes its own pane from its xmark button", () =>
	{
		calls.close.length = 0;
		buttons.clear();
		withPanes([BOB, paneState(C, "carol")], render);
		buttons.get("Close pane")?.onClick?.({} as never);
		expect(calls.close).toStrictEqual([C]);
	});

	it("routes bullet zooms inside each pane to that pane", () =>
	{
		seenPaneZooms.length = 0;
		calls.zoom.length = 0;
		withPanes([BOB, paneState(C, "carol")], render);
		seenPaneZooms[0]?.("dave");
		seenPaneZooms[1]?.("eve");
		expect(calls.zoom).toStrictEqual([`${B}:dave`, `${C}:eve`]);
	});
});

describe("PaneWorkspace", () =>
{
	function renderWorkspace(): string
	{
		return renderToStaticMarkup(createElement(PaneWorkspace, null, createElement("i")));
	}

	const eight =
		"[&amp;_[data-full-width-boundary].vertical-scrollable-container]:overflow-x-hidden [&amp;_[data-full-width-boundary].vertical-scrollable-container]:overflow-y-auto [&amp;_[data-full-width-boundary].vertical-scrollable-container]:overscroll-x-auto [&amp;_[data-full-width-boundary].vertical-scrollable-container]:overscroll-y-contain [&amp;_[data-full-width-boundary]&gt;.vertical-scrollable-container]:overflow-x-hidden [&amp;_[data-full-width-boundary]&gt;.vertical-scrollable-container]:overflow-y-auto [&amp;_[data-full-width-boundary]&gt;.vertical-scrollable-container]:overscroll-x-auto [&amp;_[data-full-width-boundary]&gt;.vertical-scrollable-container]:overscroll-y-contain";
	const control =
		'<div class="wf-header pane-workspace-control box-border absolute top-0 right-0 flex h-[var(--wf-header-height)] w-[var(--pane-workspace-control-width)] items-center justify-center border-x border-solid border-primary bg-primary [&amp;_.iconButton]:text-primary print:hidden" style="z-index:200">';

	it("is a clipped full-height row holding the pane scroll container and the workspace control, like upstream", () =>
	{
		const html = withPanes([BOB, paneState(C, "carol")], renderWorkspace);
		expect(html.slice(0, html.indexOf('<div role="button"'))).toBe(
			`<div class="relative flex h-screen max-h-screen min-h-0 items-stretch overflow-hidden bg-primary print:block print:!mr-0 print:!h-auto print:!max-h-none print:!overflow-visible ${eight}" data-pane-workspace="true" style="--pane-workspace-control-width:var(--wf-header-height);--pane-workspace-left-control-width:calc(var(--wf-space-s) + 36px);margin-right:8px"><div class="flex min-w-0 min-h-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden print:block print:!overflow-visible [&amp;_.wf-pane-header]:cursor-grab" data-pane-reordering="false" data-pane-scroll-container="true"><i></i></div>${control}`,
		);
	});

	it("renders the workspace control once, as a direct child of the workspace after the scroll container", () =>
	{
		const html = withPanes([BOB, paneState(C, "carol")], renderWorkspace);
		expect(
			{
				count: html.split(control).length - 1,
				afterScroller: html.indexOf(control) > html.indexOf("</div>"),
			},
		).toStrictEqual(
			{
				count: 1,
				afterScroller: true,
			},
		);
	});

	it("opens another pane on the last pane's zoom from the control's New pane button, after it", () =>
	{
		calls.opened.length = 0;
		buttons.clear();
		withPanes([BOB, paneState(C, "carol")], renderWorkspace);
		buttons.get("New pane")?.onClick?.({} as never);
		expect(
			{
				shortcut: buttons.get("New pane")?.shortcut,
				opened: calls.opened,
			},
		).toStrictEqual(
			{
				shortcut: "⌃R",
				opened: [
					[
						"carol",
						{
							sourcePaneId: C,
						},
					],
				],
			},
		);
	});

	it("appends a spacer as wide as the workspace while a divider is dragged", () =>
	{
		storeState.paneResizing = true;
		const html = withPanes([BOB], renderWorkspace);
		storeState.paneResizing = false;
		expect(html).toContain(
			'<i></i><div aria-hidden="true" class="flex-none print:hidden" style="width:1416px"></div>',
		);
	});

	it("lays nothing out in the single-document layout", () =>
	{
		expect(withPanes([], renderWorkspace)).toBe('<div class="contents"><div class="contents"><i></i></div></div>');
	});
});

describe("MainPane", () =>
{
	function renderMain(): string
	{
		return renderToStaticMarkup(createElement(MainPane, null, createElement("i")));
	}

	it("has no pane element in the single-document layout, only layout-free wrappers", () =>
	{
		const html = withPanes([], renderMain);
		expect(
			{
				html,
				hasPane: html.includes("data-pane-id"),
			},
		).toStrictEqual(
			{
				html: '<div class="main-pane contents"><div class="contents"><i></i></div></div>',
				hasPane: false,
			},
		);
	});

	it("is active while a pane is open and the main pane was focused last", () =>
	{
		storeState.activePaneId = "main";
		const html = renderMain();
		storeState.activePaneId = B;
		expect(html).toContain('data-pane-active="true"');
	});

	it("is inactive while another pane is active", () =>
	{
		expect(renderMain()).toContain('data-pane-active="false"');
	});

	it("becomes the workspace's first pane, at its pixel width with its body wrapper and separator, while a pane is open", () =>
	{
		const html = renderMain();
		const separator = html.slice(html.indexOf("<div aria-controls"));
		expect(
			{
				head: html.slice(0, html.indexOf("<i>")),
				separatorLabel: /aria-label="([^"]*)"/u.exec(separator)?.[1],
				separatorControls: /aria-controls="([^"]*)"/u.exec(separator)?.[1],
			},
		).toStrictEqual(
			{
				head: '<div id="pane-main" data-pane-id="main" data-pane-type="item-tree" data-pane-active="false" class="main-pane group/pane relative box-border flex-none h-full max-h-full min-h-0 bg-primary flex flex-col print:hidden [&amp;_.header]:pl-[var(--pane-workspace-left-control-width)] [&amp;_.header]:min-w-[280px]" style="width:400px;min-width:350px"><div class="flex flex-1 min-h-0 flex-col" data-full-width-boundary="true" data-split-pane="true">',
				separatorLabel: "Resize pane 1",
				separatorControls: `pane-main pane-${B}`,
			},
		);
	});

	it("prints only while it is the active pane", () =>
	{
		storeState.activePaneId = "main";
		const html = renderMain();
		storeState.activePaneId = B;
		expect(html).toContain("print:block print:!w-auto print:!min-w-0 print:!h-auto print:!max-h-none");
	});

	it("is never active without a pane open, so its header keeps the plain border", () =>
	{
		storeState.activePaneId = "main";
		const html = withPanes([], renderMain);
		storeState.activePaneId = B;
		expect(html).toContain('<div class="main-pane contents">');
	});
});

describe("paneActivation", () =>
{
	it("activates the pane on pointerdown and focusin inside it, like upstream", () =>
	{
		const activated: string[] = [];
		const handlers = paneActivation(B, (paneId) =>
		{
			activated.push(paneId);
		});
		handlers.onPointerDown();
		handlers.onFocus();
		expect(activated).toStrictEqual([B, B]);
	});
});

describe("side pane layout CSS", () =>
{
	it("lets each pane header flow inside its pane", () =>
	{
		expect(cssBlock(styles, "[data-pane-workspace] [data-split-pane] > .header")).toStrictEqual(
			{
				position: "static",
				"flex-shrink": "0",
			},
		);
	});

	it("no longer borders the panes, pads their scrollers or styles the old resize handle", () =>
	{
		expect(
			[".side-pane", ".side-pane-scroller", ".pane-resize-handle"].map((selector) =>
				styles.includes(`\n${selector} {`),
			),
		).toStrictEqual([false, false, false]);
	});
});
