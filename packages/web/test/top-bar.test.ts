import {describe, expect, it, vi} from "vite-plus/test";
import type * as UsePreferencesModule from "../src/client/hooks/use-preferences.js";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import type * as IconButtonModule from "../src/client/components/icon-button.js";
import type {GearMenuHeaderItem} from "../src/client/components/main-menu-model.js";
import {cssBlock, cssBlockText, hasSelector} from "./helpers/css-block.js";

const pickerCalls: unknown[] = [];
const openPaneCalls: unknown[][] = [];
const closePaneCalls: unknown[][] = [];
const storeState: {zoomedNodeId: string | null; panes: {id: string; zoomedId: string | null}[]} & Record<
	string,
	unknown
> = {
	zoomedNodeId: "alice",
	panes: [],
	openPane: (zoomedId: string | null, options?: unknown) => {
		openPaneCalls.push([zoomedId, options]);
		return "NEW";
	},
	toggleLeftBar: () => {},
	searchInput: "",
	setSearchInput: () => {},
	searchFocused: false,
	setSearchFocused: () => {},
	showCompleted: false,
	searchQuery: "",
	openSettings: () => {},
	openPresentation: () => {},
	leftBarOffset: () => 0,
	leftBarMode: "drawerClosed",
	nav: {current: null, back: [], forward: []},
	mainPaneHistory: {back: [], forward: []},
	showItemTypePicker: (picker: unknown) => {
		pickerCalls.push(picker);
	},
};

vi.mock("../src/client/stores/outline.js", () => ({
	useOutlineStore: (selector?: (state: typeof storeState) => unknown) =>
		selector === undefined ? storeState : selector(storeState),
}));
vi.mock("../src/client/hooks/use-starred.js", () => ({
	STARS_UNAVAILABLE_TOOLTIP: "Stars need Workflowy login",
	useRecordStarViews: () => {},
	useStarActions: () => ({toggleStar: async () => Promise.resolve(true)}),
	useStarredLocations: () => [],
	useStars: () => ({stars: [], unavailable: false}),
}));
/** The account's calendar.tooltip_seen as the Today controls read it. */
const tooltipSeen: {value: boolean | null} = {value: true};
vi.mock("../src/client/hooks/use-preferences.js", async (importOriginal) => ({
	...(await importOriginal<typeof UsePreferencesModule>()),
	useCalendarTooltipSeen: () => tooltipSeen.value,
}));

vi.mock("react-router-dom", () => ({useNavigate: () => () => {}}));
vi.mock("@tanstack/react-query", () => ({useQueryClient: () => ({}), useQuery: () => ({data: undefined})}));
const toggleState = {toggleCompleted: (): void => {}};
vi.mock("../src/client/hooks/use-show-completed-toggle.js", () => ({
	useShowCompletedToggle: () => toggleState.toggleCompleted,
}));
vi.mock("../src/client/navigation.js", () => ({
	stepNav: () => {},
	useNavStackSync: () => {},
	closeMainPane: () => {
		closePaneCalls.push(["closeMainPane"]);
	},
}));
const nodeState: {hasChildren: boolean; rootChildren: {id: string}[]; layoutMode: string | null} = {
	hasChildren: true,
	rootChildren: [{id: "r1"}],
	layoutMode: null,
};
const homeState: {layoutMode: string | undefined} = {layoutMode: undefined};

const expandAllCalls: [string | null, boolean][] = [];

vi.mock("../src/client/hooks/use-nodes.js", async () => {
	const {noopMutation} = await import("./helpers/stable-mutation.js");
	return {
		useExpandAll: () => (rootId: string | null, open: boolean) => {
			expandAllCalls.push([rootId, open]);
		},
		useUpdateNode: () => noopMutation,
		useCreateNode: () => noopMutation,
		useDeleteNode: () => noopMutation,
		useMoveNode: () => noopMutation,
		useNode: (nodeId: string | null) => ({
			data:
				nodeId === null
					? undefined
					: {id: nodeId, hasChildren: nodeState.hasChildren, data: {layoutMode: nodeState.layoutMode}},
		}),
		useHome: () => ({data: homeState.layoutMode === undefined ? undefined : {layoutMode: homeState.layoutMode}}),
		useChildren: () => ({data: nodeState.rootChildren}),
	};
});
vi.mock("../src/client/components/breadcrumbs.js", () => ({
	Breadcrumbs: () => createElement("div", {className: "breadcrumbs-mock"}),
}));
const media = {wide: true};
const breakpointCalls: number[] = [];
vi.mock("../src/client/hooks/use-breakpoint.js", () => ({
	useBreakpoint: (min: number) => {
		breakpointCalls.push(min);
		return media.wide;
	},
}));

interface CapturedGearMenuProps {
	headerItems?: GearMenuHeaderItem[];
	onExpandAll?: () => void;
	onCollapseAll?: () => void;
}
const gearMenuProps: CapturedGearMenuProps = {};
vi.mock("../src/client/components/main-menu-rows.js", () => ({
	useMainMenuRows: (props: CapturedGearMenuProps) => {
		gearMenuProps.headerItems = props.headerItems;
		gearMenuProps.onExpandAll = props.onExpandAll;
		gearMenuProps.onCollapseAll = props.onCollapseAll;
		return [];
	},
}));

/** Props of every IconButton rendered, keyed by data-handbook. */
type IconButtonProps = Parameters<typeof IconButtonModule.IconButton>[0];

const iconButtonProps = new Map<string, IconButtonProps>();

vi.mock("../src/client/components/icon-button.js", async (importOriginal) => {
	const actual = await importOriginal<typeof IconButtonModule>();
	return {
		...actual,
		IconButton: (props: IconButtonProps) => {
			const handbook = props["data-handbook"];
			if (handbook !== undefined) {
				iconButtonProps.set(handbook, props);
			}
			if (props.tooltip === "Share") {
				iconButtonProps.set("share", props);
			}
			if (props.tooltip === "New pane") {
				iconButtonProps.set("new_pane", props);
			}
			if (props.tooltip === "Close pane") {
				iconButtonProps.set("close_pane", props);
			}
			return actual.IconButton(props);
		},
	};
});

const {TopBar, createPeekController} = await import("../src/client/components/top-bar.js");

const styles = readFileSync(fileURLToPath(new URL("../src/client/styles.css", import.meta.url)), "utf8");

const VOID_TAGS = new Set(["input", "img", "br", "hr"]);

/** Class attributes of the root element's direct children. */
function rootChildClasses(html: string): string[] {
	const classes: string[] = [];
	let depth = 0;
	for (const match of html.matchAll(/<(\/?)([a-z]+)([^>]*?)(\/?)>/gu)) {
		const [, closing, tag, attributes, selfClosing] = match;
		if (closing === "/") {
			depth--;
			continue;
		}
		if (depth === 1) {
			classes.push(/class="([^"]*)"/u.exec(attributes)?.[1] ?? "");
		}
		if (selfClosing !== "/" && !VOID_TAGS.has(tag)) {
			depth++;
		}
	}
	return classes;
}

describe("TopBar markup", () => {
	const html = renderToStaticMarkup(createElement(TopBar));

	it("renders upstream's wf-header root", () => {
		expect(html.slice(0, html.indexOf(">") + 1)).toBe(
			'<div class="wf-header header bg-primary border-b border-solid border-primary" style="left:0;z-index:200">',
		);
	});

	it("adds the pane-active border class only while a pane is open", () => {
		storeState.panes = [{id: "BBBBBBBBBBB", zoomedId: "bob"}];
		const withPane = renderToStaticMarkup(createElement(TopBar));
		storeState.panes = [];
		expect(withPane.slice(0, withPane.indexOf(">") + 1)).toContain(
			"group-data-[pane-active=true]/pane:border-b-tint",
		);
	});

	it("offsets the header by the pinned left bar width", () => {
		storeState.leftBarOffset = () => 296;
		const pinned = renderToStaticMarkup(createElement(TopBar));
		storeState.leftBarOffset = () => 0;
		expect(pinned.slice(0, pinned.indexOf(">") + 1)).toBe(
			'<div class="wf-header header bg-primary border-b border-solid border-primary" style="left:296px;z-index:200">',
		);
	});

	it("renders upstream's flat child order", () => {
		expect(rootChildClasses(html)).toStrictEqual([
			"",
			"pagination",
			"breadcrumbs-mock",
			"ml-auto flex self-stretch items-center gap-xs flex-shrink-0",
		]);
	});
});

function renderWithNav(canGoBack: boolean, canGoForward: boolean): string {
	const home = {id: null, query: null};
	storeState.nav = {current: home, back: canGoBack ? [home] : [], forward: canGoForward ? [home] : []};
	return renderToStaticMarkup(createElement(TopBar));
}

/** Inner HTML of the `.pagination` element with svg path data stripped. */
function paginationInner(html: string): string {
	const start = html.indexOf('<div class="pagination">') + '<div class="pagination">'.length;
	const end = html.indexOf('<div class="breadcrumbs-mock">');
	return html
		.slice(start, end)
		.replace(/<\/div>$/u, "")
		.replaceAll(/ d="[^"]*"/gu, "");
}

function svg(name: string, width: number): string {
	return `<svg aria-hidden="true" focusable="false" data-prefix="fal" data-icon="${name}" class="svg-inline--fa fa-${name} fa-1x " role="img" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} 512"><path fill="currentColor"></path></svg>`;
}

describe("TopBar left controls", () => {
	it("renders a disabled Back and no Forward on an empty stack", () => {
		expect(paginationInner(renderWithNav(false, false))).toBe(
			`<div role="button" tabindex="-1" aria-disabled="true" data-handbook="nav.back" icon="chevron-left" class="iconButton lg shape-circle disabled">${svg("chevron-left", 320)}</div>`,
		);
	});

	it("steps the main pane history instead of the app stacks while a pane is open", () => {
		const home = {id: null, query: null};
		storeState.panes = [{id: "BBBBBBBBBBB", zoomedId: "bob"}];
		storeState.mainPaneHistory = {back: [home], forward: []};
		const html = renderWithNav(false, true);
		storeState.panes = [];
		storeState.mainPaneHistory = {back: [], forward: []};
		expect(paginationInner(html)).toBe(
			`<div role="button" tabindex="0" data-handbook="nav.back" icon="chevron-left" class="iconButton lg shape-circle">${svg("chevron-left", 320)}</div>`,
		);
	});

	it("renders enabled Back and a sm:flex Forward when both stacks are non-empty", () => {
		expect(paginationInner(renderWithNav(true, true))).toBe(
			`<div role="button" tabindex="0" data-handbook="nav.back" icon="chevron-left" class="iconButton lg shape-circle">${svg("chevron-left", 320)}</div>` +
				`<div role="button" tabindex="0" data-handbook="nav.forward" icon="chevron-right" class="sm:flex hidden iconButton lg shape-circle">${svg("chevron-right", 320)}</div>`,
		);
	});

	it("renders the hamburger as a toggle_leftbar IconButton without a tooltip", () => {
		const html = renderWithNav(false, false);
		const wrapper = html.slice(html.indexOf(">") + 1, html.indexOf('<div class="pagination">'));
		expect(wrapper.replaceAll(/ d="[^"]*"/gu, "")).toBe(
			`<div style="position:relative"><div role="button" tabindex="0" data-handbook="toggle_leftbar" class="iconButton lg shape-circle">${svg("bars", 448)}</div></div>`,
		);
	});

	it("replaces the hamburger with upstream's w-l spacer while the left bar is pinned", () => {
		storeState.leftBarMode = "alwaysOpen";
		const html = renderWithNav(false, false);
		storeState.leftBarMode = "drawerClosed";
		expect(html.slice(html.indexOf(">") + 1, html.indexOf('<div class="pagination">'))).toBe(
			'<div class="w-l"></div>',
		);
	});
});

/** Inner HTML of the right cluster. */
function clusterHtml(html: string): string {
	const marker = '<div class="ml-auto flex self-stretch items-center gap-xs flex-shrink-0">';
	return html.slice(html.indexOf(marker) + marker.length);
}

/** Ordered identifiers of the right-cluster controls. */
function clusterSequence(html: string): string[] {
	const tokens = clusterHtml(html).matchAll(
		/fa-calendar-day\b|fa-user-plus|fa-xmark\b|viewBox="0 0 33 30"|data-handbook="([^"]+)"|class="[^"]*\bgearMenu\b/gu,
	);
	return [...tokens].map((match) => {
		if (match[0] === 'viewBox="0 0 33 30"') {
			return "new_pane";
		}
		if (match[0].startsWith("data-handbook")) {
			return match[1] === "search.search" ? "search" : match[1];
		}
		if (match[0] === "fa-user-plus") {
			return "share";
		}
		if (match[0] === "fa-xmark") {
			return "close_pane";
		}
		return match[0] === "fa-calendar-day" ? "today" : "gearMenu";
	});
}

function renderCluster(zoomedNodeId: string | null, hasChildren: boolean, rootChildren: {id: string}[]): string {
	storeState.zoomedNodeId = zoomedNodeId;
	nodeState.hasChildren = hasChildren;
	nodeState.rootChildren = rootChildren;
	const html = renderToStaticMarkup(createElement(TopBar));
	storeState.zoomedNodeId = "alice";
	nodeState.hasChildren = true;
	nodeState.rootChildren = [{id: "r1"}];
	return html;
}

describe("TopBar right cluster", () => {
	it("orders the zoomed controls like upstream", () => {
		expect(clusterSequence(renderCluster("alice", true, []))).toStrictEqual([
			"search",
			"today",
			"share",
			"present_it",
			"starring.star",
			"complete.toggle",
			"bullet.layout",
			"gearMenu",
			"new_pane",
		]);
	});

	it("drops the star at root and keeps Present when root has children", () => {
		expect(clusterSequence(renderCluster(null, false, [{id: "r1"}]))).toStrictEqual([
			"search",
			"today",
			"present_it",
			"complete.toggle",
			"bullet.layout",
			"gearMenu",
			"new_pane",
		]);
	});

	it("renders the kebab as a ButtonMenu trigger, not a hand-built gear menu", () => {
		const html = renderCluster("alice", true, []);
		expect({
			trigger: html.includes('<div tabindex="0" class="relative outline-none menu gearMenu">'),
			handBuilt: html.includes("gear-menu"),
		}).toStrictEqual({trigger: true, handBuilt: false});
	});

	it("hides Present when the zoomed node has no children", () => {
		expect(clusterSequence(renderCluster("alice", false, [{id: "r1"}]))).not.toContain("present_it");
	});

	it("hides Present at an empty root", () => {
		expect(clusterSequence(renderCluster(null, true, []))).not.toContain("present_it");
	});

	it("renders the kebab wrapper without a tooltip or blue dot", () => {
		const cluster = clusterHtml(renderCluster("alice", true, []));
		const kebab = cluster.slice(
			cluster.indexOf('<div tabindex="0" class="relative outline-none menu gearMenu">'),
			cluster.indexOf('<div class="self-stretch border-l'),
		);
		expect(kebab.replaceAll(/ d="[^"]*"/gu, "")).toBe(
			'<div tabindex="0" class="relative outline-none menu gearMenu"><div><div role="button" tabindex="0" class="iconButton lg shape-circle">' +
				'<svg aria-hidden="true" focusable="false" data-prefix="fal" data-icon="ellipsis-vertical" class="svg-inline--fa fa-ellipsis-vertical fa-lg " role="img" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 512"><path fill="currentColor"></path></svg>' +
				"</div></div></div>",
		);
		expect(cluster).not.toContain("w-[7px]");
		expect(cluster).not.toContain('role="tooltip"');
	});

	it("renders Today as a bare div around a calendar-day IconButton", () => {
		const cluster = clusterHtml(renderCluster("alice", true, [])).replaceAll(/ d="[^"]*"/gu, "");
		expect(cluster).toContain(
			`<div><div role="button" tabindex="0" class="iconButton lg shape-circle">${svg("calendar-day", 448)}</div></div>`,
		);
	});

	it("shows the calendar onboarding button in place of Today until calendar.tooltip_seen, and nothing while loading", () => {
		const seenAs = (value: boolean | null) => {
			tooltipSeen.value = value;
			try {
				const cluster = clusterHtml(renderCluster("alice", true, []));
				return {
					onboarding: cluster.includes('class="shape-circle iconButton lg"'),
					calendarDay: cluster.includes("fa-calendar-day "),
				};
			} finally {
				tooltipSeen.value = true;
			}
		};
		expect({seen: seenAs(true), unseen: seenAs(false), loading: seenAs(null)}).toStrictEqual({
			seen: {onboarding: false, calendarDay: true},
			unseen: {onboarding: true, calendarDay: true},
			loading: {onboarding: false, calendarDay: false},
		});
	});

	it("renders no Calendar popover", () => {
		const html = renderCluster("alice", true, []);
		expect(html).not.toContain("top-bar-calendar-container");
		expect(html).not.toContain("calendar-panel");
	});
});

function renderWithPane(): string {
	storeState.panes = [{id: "BBBBBBBBBBB", zoomedId: "bob"}];
	const html = renderCluster("alice", true, [{id: "r1"}]);
	storeState.panes = [];
	return html;
}

/** Outer HTML of the New pane separator and IconButton, svg path data stripped. */
function newPaneHtml(html: string): string {
	const start = html.indexOf('<div class="self-stretch border-l border-solid border-primary mx-s">');
	const end = html.indexOf("</svg></div>", start) + "</svg></div>".length;
	return html.slice(start, end).replaceAll(/ d="[^"]*"/gu, "");
}

describe("TopBar as the first pane's header", () => {
	const header = (html: string) => html.slice(0, html.indexOf(">") + 1);

	it("uses the pane header's inline reset instead of the fixed offset", () => {
		expect(header(renderWithPane())).toBe(
			'<div class="wf-header header bg-primary wf-pane-header border-b border-solid border-primary group-data-[pane-active=true]/pane:border-b-tint flex-shrink-0" style="position:relative;top:auto;right:auto;left:auto;height:auto;min-height:var(--wf-header-height);z-index:auto;transition:none">',
		);
	});

	it("renders the compact 36px search circle, not the header search box", () => {
		const html = renderWithPane();
		expect({
			input: html.includes('data-pane-search-input="true"'),
			legacy: html.includes('id="srch-input"'),
			circle: html.includes(
				'class="relative shrink-0 max-w-[60vw] transition-[width] duration-300 ease-base hover:!bg-tertiary searchBox" style="width:36px;height:36px;border-radius:18px"',
			),
		}).toStrictEqual({input: true, legacy: false, circle: true});
	});

	it("renders Today as a direct IconButton with no wrapper div", () => {
		const cluster = clusterHtml(renderWithPane());
		expect(cluster).not.toMatch(/<div><div role="button"[^>]*><svg[^>]*fa-calendar-day/u);
		expect(cluster.indexOf("fa-calendar-day")).toBeGreaterThan(-1);
	});

	it("moves the bars toggle into a fixed left control, the header's last child, while the left bar is closed", () => {
		const html = renderWithPane();
		const control = html.indexOf('<div class="pane-workspace-control');
		expect({
			control: html.slice(control, html.indexOf(">", control) + 1),
			last: html.endsWith("</div></div></div>") && html.indexOf('data-handbook="toggle_leftbar"') > control,
			leading: html.indexOf('data-handbook="toggle_leftbar"') > html.indexOf('class="pagination"'),
		}).toStrictEqual({
			control:
				'<div class="pane-workspace-control empty:hidden box-border fixed top-0 left-0 flex h-[var(--wf-header-height)] w-[var(--pane-workspace-left-control-width)] items-center justify-start pl-[var(--wf-space-s)] bg-primary" style="z-index:200">',
			last: true,
			leading: true,
		});
	});

	it("keeps the 16px spacer and no left control while the left bar is pinned", () => {
		storeState.leftBarMode = "alwaysOpen";
		const html = renderWithPane();
		storeState.leftBarMode = "drawerClosed";
		expect({
			control: html.includes("pane-workspace-control"),
			spacer: html.includes('<div class="w-l">'),
		}).toStrictEqual({
			control: false,
			spacer: true,
		});
	});

	it("keeps the single-document header unchanged: leading toggle, wrapped Today, no control", () => {
		const html = renderCluster("alice", true, []);
		expect({
			control: html.includes("pane-workspace-control"),
			legacy: html.includes('id="srch-input"'),
			wrapped: /<div><div role="button"[^>]*>(?:(?!<\/div>).)*fa-calendar-day/u.test(clusterHtml(html)),
		}).toStrictEqual({control: false, legacy: true, wrapped: true});
	});
});

describe("TopBar New pane", () => {
	it("renders upstream's separator and 30x27 columns-plus IconButton after the kebab", () => {
		expect(newPaneHtml(renderCluster("alice", true, []))).toBe(
			'<div class="self-stretch border-l border-solid border-primary mx-s"></div>' +
				'<div role="button" tabindex="0" class="iconButton lg shape-circle">' +
				'<svg aria-hidden="true" focusable="false" width="30" height="27" viewBox="0 0 33 30" fill="none" xmlns="http://www.w3.org/2000/svg">' +
				'<path fill-rule="evenodd" clip-rule="evenodd" fill="currentColor"></path><path fill="currentColor"></path></svg></div>',
		);
	});

	it("shows the ⌃R shortcut in its New pane tooltip", () => {
		renderCluster("alice", true, []);
		const props = iconButtonProps.get("new_pane");
		expect({tooltip: props?.tooltip, shortcut: props?.shortcut}).toStrictEqual({
			tooltip: "New pane",
			shortcut: "⌃R",
		});
	});

	it("opens a pane on the zoomed node from the main pane", () => {
		openPaneCalls.length = 0;
		renderCluster("alice", true, []);
		iconButtonProps.get("new_pane")?.onClick?.({} as never);
		expect(openPaneCalls).toStrictEqual([["alice", {sourcePaneId: "main"}]]);
	});

	it("opens a pane on Home at root", () => {
		openPaneCalls.length = 0;
		renderCluster(null, true, [{id: "r1"}]);
		iconButtonProps.get("new_pane")?.onClick?.({} as never);
		expect(openPaneCalls).toStrictEqual([[null, {sourcePaneId: "main"}]]);
	});

	it("swaps New pane for Close pane and compacts the cluster while a pane is open", () => {
		expect(clusterSequence(renderWithPane())).toStrictEqual([
			"search",
			"today",
			"gearMenu",
			"close_pane",
			"toggle_leftbar",
		]);
	});

	it("renders Close pane as upstream's tertiary xmark", () => {
		const cluster = clusterHtml(renderWithPane()).replaceAll(/ d="[^"]*"/gu, "");
		expect(cluster).toContain(
			`<div role="button" tabindex="0" class="text-tertiary hover:text-on-surface flex-shrink-0 iconButton lg shape-circle">${svg("xmark", 384)}</div>`,
		);
	});

	it("marks the main header a draggable pane header only while a pane is open", () => {
		expect({
			single: renderCluster("alice", true, []).includes("wf-pane-header"),
			panes: renderWithPane().includes('class="wf-header header bg-primary wf-pane-header border-b'),
		}).toStrictEqual({single: false, panes: true});
	});

	it("closes the main pane, so the first pane becomes the main outline", () => {
		closePaneCalls.length = 0;
		renderWithPane();
		iconButtonProps.get("close_pane")?.onClick?.({} as never);
		expect(closePaneCalls).toStrictEqual([["closeMainPane"]]);
	});

	it("moves the compactable actions into the more menu while a pane is open", () => {
		renderWithPane();
		expect(gearMenuProps.headerItems?.map((item) => item.label)).toStrictEqual([
			"Share",
			"Present",
			"Star",
			"Show completed",
			"Change layout",
		]);
	});
});

function renderCompact(zoomedNodeId: string | null): string {
	media.wide = false;
	const html = renderCluster(zoomedNodeId, true, [{id: "r1"}]);
	media.wide = true;
	return html;
}

describe("TopBar compact mode under 701px", () => {
	it("compacts at upstream's 701px breakpoint", () => {
		breakpointCalls.length = 0;
		renderCompact("alice");
		expect(breakpointCalls.includes(701)).toBe(true);
	});

	it("keeps only search, Today, the kebab and New pane in the cluster", () => {
		expect(clusterSequence(renderCompact("alice"))).toStrictEqual(["search", "today", "gearMenu", "new_pane"]);
	});

	it("prepends the compactable actions to the more menu", () => {
		renderCompact("alice");
		expect(gearMenuProps.headerItems?.map((item) => item.label)).toStrictEqual([
			"Share",
			"Present",
			"Star",
			"Show completed",
			"Change layout",
		]);
	});

	it("drops Share and Star from the more menu at root", () => {
		renderCompact(null);
		expect(gearMenuProps.headerItems?.map((item) => item.label)).toStrictEqual([
			"Present",
			"Show completed",
			"Change layout",
		]);
	});

	it("runs the same actions from the more menu", () => {
		const toggleCompleted = vi.fn<() => void>();
		toggleState.toggleCompleted = toggleCompleted;
		renderCompact("alice");
		toggleState.toggleCompleted = () => {};
		gearMenuProps.headerItems?.find((item) => item.label === "Show completed")?.onSelect();
		expect(toggleCompleted).toHaveBeenCalledOnce();
	});

	it("passes no header items when wide", () => {
		renderCluster("alice", true, []);
		expect(gearMenuProps.headerItems).toStrictEqual([]);
	});
});

/** Outer HTML of the complete.toggle IconButton, svg path data stripped. */
function completedToggleHtml(html: string): string {
	const start = html.lastIndexOf("<div", html.indexOf('data-handbook="complete.toggle"'));
	const end = html.indexOf("</svg></div>", start) + "</svg></div>".length;
	return html.slice(start, end).replaceAll(/ d="[^"]*"/gu, "");
}

function svgStyled(name: string, width: number, style: string): string {
	return svg(name, width).replace(' 512"><path', ` 512" style="${style}"><path`);
}

describe("TopBar share button", () => {
	it("opens the zoomed node on workflowy.com in a new tab", () => {
		const open = vi.fn<typeof window.open>();
		vi.stubGlobal("window", {open});
		renderCluster("21757ea6-e49b-4392-aa5b-aeda6fe0c1bb", true, []);
		const onClick = iconButtonProps.get("share")?.onClick as () => void;
		onClick();
		vi.unstubAllGlobals();
		expect(open.mock.calls).toStrictEqual([["https://workflowy.com/#/aeda6fe0c1bb", "_blank", "noopener"]]);
	});

	it("renders a user-plus IconButton without a handbook", () => {
		const cluster = clusterHtml(renderCluster("alice", true, [])).replaceAll(/ d="[^"]*"/gu, "");
		expect(cluster).toContain(
			`<div role="button" tabindex="0" class="iconButton lg shape-circle">${svg("user-plus", 640)}</div>`,
		);
	});
});

describe("TopBar show completed toggle", () => {
	it("toggles completed directly on click, with no popup", () => {
		const toggleCompleted = vi.fn<() => void>();
		toggleState.toggleCompleted = toggleCompleted;
		const html = renderToStaticMarkup(createElement(TopBar));
		toggleState.toggleCompleted = () => {};
		const onClick = iconButtonProps.get("complete.toggle")?.onClick as () => void;
		onClick();
		expect(toggleCompleted).toHaveBeenCalledOnce();
		expect(html).not.toContain("hide-completed-popup");
		expect(html).not.toContain("top-bar-completed-container");
		expect(html).not.toContain('aria-haspopup="true" data-handbook="complete.toggle"');
	});

	it("renders an untinted check with a Show completed tooltip when hidden", () => {
		const html = renderToStaticMarkup(createElement(TopBar));
		expect(completedToggleHtml(html)).toBe(
			`<div role="button" tabindex="0" data-handbook="complete.toggle" class="iconButton lg shape-circle">${svg("check", 448)}</div>`,
		);
		expect(iconButtonProps.get("complete.toggle")?.tooltip).toBe("Show completed");
		expect(iconButtonProps.get("complete.toggle")?.shortcut).toBeUndefined();
	});

	it("renders no toggle, and no more-menu entry, while the search forces completed rows", () => {
		storeState.searchQuery = "is:complete";
		const forced = renderToStaticMarkup(createElement(TopBar));
		renderCompact("alice");
		const forcedLabels = gearMenuProps.headerItems?.map((item) => item.label);
		storeState.searchQuery = "rc";
		const plain = renderToStaticMarkup(createElement(TopBar));
		storeState.searchQuery = "";
		expect({
			forced: forced.includes('data-handbook="complete.toggle"'),
			forcedLabels,
			plain: plain.includes('data-handbook="complete.toggle"'),
		}).toStrictEqual({forced: false, forcedLabels: ["Share", "Present", "Star", "Change layout"], plain: true});
	});

	it("tints the check svg and offers Hide completed when shown", () => {
		storeState.showCompleted = true;
		const html = renderToStaticMarkup(createElement(TopBar));
		storeState.showCompleted = false;
		expect(completedToggleHtml(html)).toBe(
			`<div role="button" tabindex="0" data-handbook="complete.toggle" class="iconButton lg shape-circle">${svgStyled("check", 448, "color:var(--wf-text-tint)")}</div>`,
		);
		expect(iconButtonProps.get("complete.toggle")?.tooltip).toBe("Hide completed");
		expect(iconButtonProps.get("complete.toggle")?.shortcut).toBeUndefined();
	});
});

describe("header CSS", () => {
	it("ports upstream's .header rule (content-box by default)", () => {
		expect(cssBlock(styles, ".header")).toStrictEqual({
			position: "fixed",
			top: "0",
			right: "0",
			height: "var(--wf-header-height)",
			display: "flex",
			"min-width": "320px",
			padding: "0 var(--wf-space-m) 0 var(--wf-space-s)",
			"align-items": "center",
			"user-select": "none",
			color: "var(--wf-text-primary) !important",
		});
	});

	it("ports upstream's pagination and text color rules", () => {
		expect(cssBlock(styles, ".header .pagination")).toStrictEqual({display: "flex", "flex-direction": "row"});
		expect(
			cssBlock(styles, ".header :is(.iconButton), .header :is(.breadcrumbs), .header :is(.breadcrumb-item)"),
		).toStrictEqual({color: "var(--wf-text-primary) !important"});
	});

	it("hides the header when printing", () => {
		expect(cssBlockText(styles, "@media print").replaceAll(/\s+/gu, "")).toBe(".header{display:none!important;}");
	});

	it("drops the old top-bar layout rules and the offline-banner override", () => {
		expect(hasSelector(styles, /\.top-bar(-left|-right|-nav-buttons)?\s*[{,]/u)).toBe(false);
		expect(hasSelector(styles, /offline-banner/u)).toBe(false);
	});

	it("drops the local-only Calendar popover rules", () => {
		expect(hasSelector(styles, /\.(calendar-panel|calendar-day|top-bar-calendar-container)\b/u)).toBe(false);
	});
});

describe("TopBar Expand all / Collapse all", () => {
	it("acts on the zoomed item's whole subtree, and on Home when not zoomed", () => {
		expandAllCalls.length = 0;
		renderToStaticMarkup(createElement(TopBar));
		gearMenuProps.onExpandAll?.();
		gearMenuProps.onCollapseAll?.();
		storeState.zoomedNodeId = null;
		renderToStaticMarkup(createElement(TopBar));
		storeState.zoomedNodeId = "alice";
		gearMenuProps.onExpandAll?.();

		expect(expandAllCalls).toStrictEqual([
			["alice", true],
			["alice", false],
			[null, true],
		]);
	});
});

/** The data-icon of the Change layout button's svg. */
function layoutIcon(html: string): string | undefined {
	const button = html.slice(html.indexOf('data-handbook="bullet.layout"'));
	return /data-icon="([^"]*)"/u.exec(button)?.[1];
}

/** The wrapper markup around the Change layout button, from the ButtonMenu trigger to the end of the IconButton. */
function layoutControl(html: string): string {
	const marker = 'data-handbook="bullet.layout"';
	const start = html.lastIndexOf('<div tabindex="0"', html.indexOf(marker));
	const end = html.indexOf("</svg></div></div></div>", html.indexOf(marker)) + "</svg></div></div></div>".length;
	return html.slice(start, end).replaceAll(/ d="[^"]*"/gu, "");
}

describe("TopBar Change layout button", () => {
	it("renders a ButtonMenu trigger around the zoomed item's type icon", () => {
		nodeState.layoutMode = "h2";
		const html = renderToStaticMarkup(createElement(TopBar));
		nodeState.layoutMode = null;
		expect(layoutIcon(html)).toBe("h2");
		expect(layoutControl(html)).toBe(
			`<div tabindex="0" class="relative outline-none menu "><div><div role="button" tabindex="0" data-handbook="bullet.layout" class="iconButton lg shape-circle">${svg("h2", 640)}</div></div></div>`,
		);
	});

	it("opens no picker from the button itself", () => {
		pickerCalls.length = 0;
		renderToStaticMarkup(createElement(TopBar));
		expect(pickerCalls).toStrictEqual([]);
	});

	it("shows Home's layout icon at Home", () => {
		storeState.zoomedNodeId = null;
		homeState.layoutMode = "board";
		const html = renderToStaticMarkup(createElement(TopBar));
		homeState.layoutMode = undefined;
		storeState.zoomedNodeId = "alice";
		expect(layoutIcon(html)).toBe("columns-3");
	});

	it("opens the picker over the last visible flyout from the compact more menu", () => {
		pickerCalls.length = 0;
		renderCompact("alice");
		const rect = (left: number, top: number, width: number, height: number) => ({
			getBoundingClientRect: () => ({left, top, width, height}),
		});
		vi.stubGlobal("document", {
			querySelectorAll: (selector: string) =>
				selector === ".flyout.menu" ? [rect(10, 10, 0, 0), rect(600, 50, 228, 500), rect(0, 0, 0, 0)] : [],
		});
		gearMenuProps.headerItems?.find((item) => item.label === "Change layout")?.onSelect();
		vi.unstubAllGlobals();
		expect(pickerCalls).toStrictEqual([{nodeIds: ["alice"], position: {top: 46, left: 714}}]);
	});
});

describe("createPeekController", () => {
	function setup(hovered = false) {
		const calls: string[] = [];
		const controller = createPeekController({
			open: () => {
				calls.push("open");
			},
			close: () => {
				calls.push("close");
			},
			isHovered: () => hovered,
		});
		return {calls, controller};
	}

	it("opens the drawer on enter and closes it 200ms after leave", () => {
		vi.useFakeTimers();
		const {calls, controller} = setup();
		controller.enter();
		expect(calls).toStrictEqual(["open"]);
		controller.leave();
		vi.advanceTimersByTime(199);
		expect(calls).toStrictEqual(["open"]);
		vi.advanceTimersByTime(1);
		expect(calls).toStrictEqual(["open", "close"]);
		vi.advanceTimersByTime(1000);
		vi.useRealTimers();
		expect(calls).toStrictEqual(["open", "close"]);
	});

	it("keeps the drawer open when the pointer reached the left bar", () => {
		vi.useFakeTimers();
		const {calls, controller} = setup(true);
		controller.enter();
		controller.leave();
		vi.advanceTimersByTime(200);
		vi.useRealTimers();
		expect(calls).toStrictEqual(["open"]);
	});

	it("cancels a pending close when the pointer re-enters", () => {
		vi.useFakeTimers();
		const {calls, controller} = setup();
		controller.enter();
		controller.leave();
		vi.advanceTimersByTime(100);
		controller.enter();
		vi.advanceTimersByTime(500);
		vi.useRealTimers();
		expect(calls).toStrictEqual(["open", "open"]);
	});
});
