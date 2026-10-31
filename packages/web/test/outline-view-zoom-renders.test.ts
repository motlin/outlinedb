// @vitest-environment happy-dom
import {afterAll, beforeAll, describe, expect, it, vi} from "vite-plus/test";
import type {Root} from "react-dom/client";
import {renders} from "./helpers/render-counter.js";
import type {NodeResponse} from "../src/node-types.js";

declare global {
	// React reads this to know act() wraps every update.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const {act, createElement} = await import("react");
const {createRoot} = await import("react-dom/client");
const {QueryClient, QueryClientProvider} = await import("@tanstack/react-query");
const {MemoryRouter} = await import("react-router-dom");
const {OutlineView} = await import("../src/client/app.js");
const {nodeKeys} = await import("../src/client/node-cache.js");
const {EMPTY_PREFERENCES, preferenceKeys} = await import("../src/client/hooks/use-preferences.js");
const {accountKeys} = await import("../src/client/hooks/use-account.js");
const {starKeys} = await import("../src/client/hooks/use-starred.js");
const {useOutlineStore} = await import("../src/client/stores/outline.js");
const {afterNextPaint} = await import("../src/client/after-paint.js");
const {RESIZE_DEBOUNCE_MS} = await import("../src/client/hooks/use-container-rect.js");

const ROWS = 55;

function row(id: string, parentId: string | null, priority: number, hasChildren: boolean): NodeResponse {
	return {
		id,
		parent_id: parentId,
		name: id,
		note: null,
		priority,
		data: {layoutMode: null},
		completedAt: null,
		createdAt: 0,
		modifiedAt: 0,
		hasChildren,
		hasUncompletedChildren: hasChildren,
	};
}

// Home holds 55 rows; the first, "parent", holds 55 leaves of its own.
const homeRows = Array.from({length: ROWS}, (_, i) => row(i === 0 ? "parent" : `home${i}`, null, i, i === 0));
const childRows = Array.from({length: ROWS}, (_, i) => row(`child${i}`, "parent", i, false));

const queryClient = new QueryClient({defaultOptions: {queries: {retry: false, staleTime: Number.POSITIVE_INFINITY}}});
let root: Root | undefined;

/**
 * Waits out the row window's growth: the hook queues its step of slack below the fold with `afterNextPaint` when the
 * view commits, so a paint queued after that commit resolves after the step lands, however long the event loop stalls.
 */
async function afterRowWindowGrows(): Promise<void> {
	await act(async () => {
		await afterNextPaint();
	});
}

/**
 * Waits out the crumbs' first container measure, which `useContainerRect` queues on mount for `RESIZE_DEBOUNCE_MS`:
 * a timeout as long, queued after the mount, fires after it.
 */
async function afterCrumbsMeasure(): Promise<void> {
	await act(async () => {
		await new Promise((resolve) => {
			setTimeout(resolve, RESIZE_DEBOUNCE_MS);
		});
	});
}

/** Components rendered, by name, since `renders.clear()`. */
function renderMap(): Record<string, number> {
	return Object.fromEntries(renders);
}

let mounted: Record<string, number> = {};

/** The test's providers, which mount alongside the view. */
const PROVIDERS = {QueryClientProvider: 1, MemoryRouter: 1, Router: 1};

/** The page shell around the panes, each mounted once. */
const SHELL = {
	OutlineView: 1,
	OfflineNotice: 1,
	PaneWorkspace: 1,
	MainPane: 1,
	MainOutline: 1,
	SearchCountIndicator: 1,
	SidePanes: 1,
	RightBar: 1,
	RelatedNodesPanel: 1,
	CommandPaletteHost: 1,
	JumpMenu: 1,
	AlertDialog: 1,
	LinkPopupHost: 1,
	LocationPickerHost: 1,
	MirrorsDialogHost: 1,
	ChangelogHost: 1,
	ExportDialog: 1,
	SelectionMenu: 1,
	Settings: 1,
	PresentationMode: 1,
	ErrorNotifications: 1,
	AppMessages: 1,
	GuiBanner: 1,
	GlobalCommands: 1,
};

/** The header parts a zoom re-renders: they show the zoomed location. */
const HEADER = {
	TopBar: 1,
	Breadcrumbs: 1,
	SearchBox: 1,
	SearchHelpers: 1,
	Flyout: 1,
	FlyoutSurface: 1,
	HeaderMoreMenu: 1,
	// Today, or the calendar onboarding button until its tooltip is seen.
	CalendarTodayControl: 1,
	// The kebab's and the Change layout button's.
	ButtonMenu: 2,
	LayoutButtonMenu: 1,
};

/** The left bar's frame around its Home rows. */
const LEFT_BAR = {
	LeftBar: 1,
	LeftBarDropBar: 1,
	LeftBarSections: 1,
	RecordStarViews: 1,
	TodayRow: 1,
	StarredSection: 1,
	LeftBarSection: 1,
	HomeSectionName: 1,
	FilesListRows: 1,
	NewNodeButton: 1,
};

/** The outline's frame, rendered once for the first row window and again as the window grows to every row. */
const TREE_FRAME = {
	OutlineTree: 2,
	ZoomRootRow: 2,
	RootOutlineChildren: 2,
	OutlineChildren: 2,
	RenderSentinel: 1,
	AddChildButton: 2,
};

beforeAll(async () => {
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
	vi.stubGlobal(
		"fetch",
		vi.fn<typeof fetch>(async () => Promise.resolve(Response.json({}, {status: 404}))),
	);
	// Everything both views read is cached, as after a page load and a bullet click's view load.
	queryClient.setQueryData(starKeys.all, {stars: [], unavailable: false});
	queryClient.setQueryData(accountKeys.all, null);
	// A seen calendar tooltip keeps the plain Today, so the counts cover the header the account usually shows.
	queryClient.setQueryData(preferenceKeys.all, {
		preferences: {...EMPTY_PREFERENCES, calendarTooltipSeen: true},
		available: true,
		error: null,
	});
	queryClient.setQueryData(nodeKeys.children(null), homeRows);
	queryClient.setQueryData(nodeKeys.children("parent"), childRows);
	queryClient.setQueryData(nodeKeys.backlinks("parent"), {rootId: "parent", items: []});
	queryClient.setQueryData(nodeKeys.ancestors("parent"), []);
	for (const node of [...homeRows, ...childRows]) {
		queryClient.setQueryData(nodeKeys.detail(node.id), node);
	}
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	renders.clear();
	act(() => {
		root?.render(
			createElement(
				QueryClientProvider,
				{client: queryClient},
				createElement(MemoryRouter, null, createElement(OutlineView)),
			),
		);
	});
	await afterRowWindowGrows();
	await afterCrumbsMeasure();
	mounted = renderMap();
});

afterAll(() => {
	act(() => {
		root?.unmount();
	});
	vi.unstubAllGlobals();
});

describe("55-row OutlineView renders", () => {
	// 299 renders, from 570: each left-bar row is one component, and each outline row three.
	it("mounts each component once, beyond the rows' three, the row window's second pass, and the crumbs' measure", () => {
		expect(mounted).toStrictEqual({
			...PROVIDERS,
			...SHELL,
			...HEADER,
			// Once to mount and once more when the crumbs measure their container: the Home crumb and its icon button.
			Breadcrumbs: 2,
			BreadcrumbItem: 2,
			DocumentTitle: 1,
			FaIcon: 18,
			IconButton: 13,
			NewPaneIcon: 1,
			...LEFT_BAR,
			FilesListBranch: ROWS,
			...TREE_FRAME,
			OutlineRow: ROWS,
			NodeName: ROWS,
			RestingText: ROWS,
		});
	});

	it("swaps a bullet click's zoom into 55 rows rendering the rows, the header, and the tree's frame", async () => {
		renders.clear();
		act(() => {
			useOutlineStore.getState().zoom("parent");
		});
		await afterRowWindowGrows();
		// 205 renders, from 523: no page shell, no left bar beyond the row that becomes current, no header icon that
		// did not change, and no row text twice.
		expect(renderMap()).toStrictEqual({
			...HEADER,
			BreadcrumbItem: 1,
			// The tab title follows the zoom.
			DocumentTitle: 1,
			FaIcon: 2,
			IconButton: 13,
			StarButton: 1,
			StarIcon: 1,
			GlobalCommands: 1,
			RecordStarViews: 1,
			FilesListBranch: 1,
			MainOutline: 1,
			SearchCountIndicator: 1,
			...TREE_FRAME,
			OutlineRow: ROWS,
			NodeName: ROWS,
			// The rows' and the zoomed title's.
			RestingText: ROWS + 1,
		});
	});
});
