// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import type {Root} from "react-dom/client";
import type {NodeResponse, OutlineViewList} from "../src/node-types.js";

declare global {
	// React reads this to know act() wraps every update.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const {act, createElement} = await import("react");
const {createRoot} = await import("react-dom/client");
const {QueryClient, QueryClientProvider} = await import("@tanstack/react-query");
const {MemoryRouter} = await import("react-router-dom");
const {OutlineView} = await import("../src/client/app.js");
const {useOutlineStore} = await import("../src/client/stores/outline.js");
const {initialRowBudget} = await import("../src/client/render-window.js");

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

const NO_BACKLINKS = {rootId: null, items: []};

// Home holds collapsed alice and zed; alice > {bob > carol > dan, erin > fay} and zed > yan > xia, with bob, carol,
// erin and yan expanded.
const children: Record<string, NodeResponse[]> = {
	alice: [row("bob", "alice", 0, true), row("erin", "alice", 1, true)],
	bob: [row("carol", "bob", 0, true)],
	carol: [row("dan", "carol", 0, false)],
	erin: [row("fay", "erin", 0, false)],
	zed: [row("yan", "zed", 0, true)],
	yan: [row("xia", "yan", 0, false)],
};
const homeList: OutlineViewList = {
	parentId: null,
	nodes: [row("alice", null, 0, true), row("zed", null, 1, true)],
	backlinks: null,
};
const list = (parentId: string): OutlineViewList => ({
	parentId,
	nodes: children[parentId] ?? [],
	backlinks: NO_BACKLINKS,
});
// Both answer later than one settle() step, as on a loaded machine, so no test may assert before the views land.
const views: Record<string, {lists: OutlineViewList[]; delayMs: number}> = {
	alice: {lists: [list("alice"), list("bob"), list("carol"), list("erin")], delayMs: 60},
	// Answers later than alice's, so two subtree loads that each committed alone would show as two commits.
	zed: {lists: [list("zed"), list("yan")], delayMs: 70},
};

let root: Root | undefined;
let queryClient: InstanceType<typeof QueryClient> | undefined;
let requests: string[] = [];
let viewBodies: unknown[] = [];

beforeEach(() => {
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
	requests = [];
	viewBodies = [];
	useOutlineStore.setState(useOutlineStore.getInitialState(), true);
	useOutlineStore.setState({expandedIds: new Set(["bob", "carol", "erin", "yan"])});
	vi.stubGlobal(
		"fetch",
		vi.fn<typeof fetch>(async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			requests.push(url);
			if (url.endsWith("/api/v1/nodes/view")) {
				const body = JSON.parse(init?.body as string) as {rootId: string | null};
				viewBodies.push(body);
				const view = body.rootId === null ? undefined : views[body.rootId];
				await new Promise((resolve) => {
					setTimeout(resolve, view?.delayMs ?? 0);
				});
				return Response.json({lists: view?.lists ?? [homeList]});
			}
			if (url.endsWith("/api/v1/nodes/children")) {
				const {parentIds} = JSON.parse(init?.body as string) as {parentIds: string[]};
				return Response.json({children: Object.fromEntries(parentIds.map((id) => [id, children[id] ?? []]))});
			}
			if (url.endsWith("/api/v1/expansion")) {
				return Response.json({});
			}
			if (url.endsWith("/backlinks")) {
				return Response.json(NO_BACKLINKS);
			}
			if (url.endsWith("/api/v1/nodes")) {
				return Response.json({nodes: homeList.nodes});
			}
			return Response.json({}, {status: 404});
		}),
	);
});

afterEach(() => {
	act(() => {
		root?.unmount();
	});
	root = undefined;
	queryClient = undefined;
	vi.unstubAllGlobals();
});

function busy(): boolean {
	return (queryClient?.isFetching() ?? 0) > 0 || (queryClient?.isMutating() ?? 0) > 0;
}

/**
 * Wait out every in-flight query and mutation plus one more render window after the last lands, so a view reply that
 * arrives late on a loaded machine still commits before the test asserts.
 */
async function settle(): Promise<void> {
	let wasBusy: boolean;
	do {
		wasBusy = busy();
		await act(async () => {
			await new Promise((resolve) => {
				setTimeout(resolve, 20);
			});
		});
	} while (wasBusy || busy());
}

function shownRows(container: HTMLElement): string[] {
	const ids = [...container.querySelectorAll("[data-node-id]")].map((element) =>
		element.getAttribute("data-node-id"),
	);
	return [...new Set(ids.filter((id) => id !== null))];
}

/** Mount the outline on Home and wait for its first view to load. */
async function mountHome(): Promise<HTMLElement> {
	const container = document.createElement("div");
	document.body.append(container);
	const client = new QueryClient({defaultOptions: {queries: {retry: false, staleTime: 60_000}}});
	queryClient = client;
	root = createRoot(container);
	act(() => {
		root?.render(
			createElement(QueryClientProvider, {client}, createElement(MemoryRouter, null, createElement(OutlineView))),
		);
	});
	await settle();
	return container;
}

/** Run `action`, wait for the loads it starts to settle, and return the rows each commit that changed them showed. */
async function commitsAfter(container: HTMLElement, action: () => void): Promise<string[][]> {
	requests = [];
	viewBodies = [];
	// Each mutation batch is one React commit.
	const commits: string[][] = [shownRows(container)];
	const observer = new MutationObserver(() => {
		const ids = shownRows(container);
		if (JSON.stringify(ids) !== JSON.stringify(commits.at(-1))) {
			commits.push(ids);
		}
	});
	observer.observe(container, {childList: true, subtree: true});
	act(action);
	await settle();
	observer.disconnect();
	return commits.slice(1);
}

function viewBody(rootId: string, expandedIds: string[]) {
	return {
		rootId,
		expandedIds,
		limit: initialRowBudget(window.innerHeight),
		showCompleted: useOutlineStore.getState().showCompleted,
	};
}

describe("expanding a row", () => {
	it("loads the row's expanded subtree in one request and mounts every level in one commit", async () => {
		const container = await mountHome();
		const arrow = container
			.querySelector('[data-node-id="alice"]')
			?.closest(".name")
			?.querySelector('button[aria-expanded="false"]');
		if (!(arrow instanceof HTMLElement)) {
			throw new TypeError("alice's expand arrow did not render");
		}

		const commits = await commitsAfter(container, () => {
			arrow.click();
		});

		expect({
			commits,
			treeRequests: requests.filter((url) => url.includes("/children") || url.endsWith("/backlinks")),
			viewBodies,
		}).toStrictEqual({
			commits: [["alice", "bob", "carol", "dan", "erin", "fay", "zed"]],
			treeRequests: [],
			viewBodies: [viewBody("alice", ["bob", "carol", "erin", "yan", "alice"])],
		});
	});

	it("mounts sibling rows expanded together in one commit, one subtree request each", async () => {
		const container = await mountHome();

		const commits = await commitsAfter(container, () => {
			useOutlineStore.getState().replaceExpanded(new Set(["bob", "carol", "erin", "yan", "alice", "zed"]));
		});

		const expanded = ["bob", "carol", "erin", "yan", "alice", "zed"];
		expect({
			commits,
			treeRequests: requests.filter((url) => url.includes("/children") || url.endsWith("/backlinks")),
			viewBodies,
		}).toStrictEqual({
			commits: [["alice", "bob", "carol", "dan", "erin", "fay", "zed", "yan", "xia"]],
			treeRequests: [],
			viewBodies: [viewBody("alice", expanded), viewBody("zed", expanded)],
		});
	});
});
