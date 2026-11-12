// @vitest-environment happy-dom
import {renders} from "./helpers/render-counter.js"; // Before react-dom, which looks for the DevTools hook it installs when it loads.
import {afterEach, describe, expect, it, afterAll, beforeAll, beforeEach, vi} from "vite-plus/test";
import {focusedSidePaneId} from "../src/client/left-bar-pane-nav.js";
import {useOutlineStore} from "../src/client/stores/outline.js";
import type {Root} from "react-dom/client";
import type {NodeResponse} from "../src/node-types.js";
import {act, createElement} from "react";
import {createRoot} from "react-dom/client";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {FilesListRows} from "../src/client/components/left-bar-files-list.js";
import {nodeKeys} from "../src/client/node-cache.js";
import type {Star} from "@outlinedb/shared";
import {StarredSection} from "../src/client/components/left-sidebar.js";

declare global {
	// React reads this to know act() wraps every update.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

describe("left bar pane nav", () => {
	afterEach(() => {
		useOutlineStore.getState().closeAllPanes();
		document.body.innerHTML = "";
	});

	describe("focusedSidePaneId", () => {
		it("is null with no pane open", () => {
			expect(focusedSidePaneId()).toBeNull();
		});

		it("is the active side pane", () => {
			const id = useOutlineStore.getState().openPane("alice");
			expect(focusedSidePaneId()).toBe(id);
		});

		it("prefers the pane holding the focused element", () => {
			const first = useOutlineStore.getState().openPane("alice");
			const second = useOutlineStore.getState().openPane("bob");
			document.body.innerHTML = `<div data-pane-id="${first}"><input id="x"></div>`;
			document.querySelector<HTMLInputElement>("#x")?.focus();
			expect({focused: focusedSidePaneId(), active: useOutlineStore.getState().activePaneId}).toStrictEqual({
				focused: first,
				active: second,
			});
		});

		it("is null when the main pane holds the focus", () => {
			useOutlineStore.getState().openPane("alice");
			document.body.innerHTML = '<div data-pane-id="main"><input id="x"></div>';
			document.querySelector<HTMLInputElement>("#x")?.focus();
			expect(focusedSidePaneId()).toBeNull();
		});
	});
});

describe("left bar renders", () => {
	function node(id: string, priority: number): NodeResponse {
		return {
			id,
			parent_id: null,
			name: id,
			note: null,
			priority,
			data: {layoutMode: null},
			completedAt: null,
			createdAt: 0,
			modifiedAt: 0,
			hasChildren: false,
		};
	}

	const rows = [node("alice", 100), node("bob", 200), node("carol", 300)];
	const queryClient = new QueryClient({
		defaultOptions: {queries: {retry: false, staleTime: Number.POSITIVE_INFINITY}},
	});
	let root: Root | undefined;

	beforeAll(() => {
		globalThis.IS_REACT_ACT_ENVIRONMENT = true;
		queryClient.setQueryData(nodeKeys.children(null), rows);
		root = createRoot(document.createElement("div"));
		act(() => {
			root?.render(
				createElement(
					QueryClientProvider,
					{client: queryClient},
					createElement(FilesListRows, {parentId: null, depth: 0, section: "home"}),
				),
			);
		});
	});

	afterAll(() => {
		act(() => {
			root?.unmount();
		});
	});

	describe("left bar files list render count", () => {
		it("re-renders only the row whose node a save changed", async () => {
			renders.clear();
			await act(async () => {
				queryClient.setQueryData(nodeKeys.children(null), [{...rows[0], name: "Alice!"}, rows[1], rows[2]]);
				await new Promise((resolve) => {
					setTimeout(resolve, 20);
				});
			});
			expect(renders.get("FilesListBranch") ?? 0).toBe(1);
		});
	});
});

describe("left bar starred requests", () => {
	const IDS = [
		"1a2b3c4d-0000-4000-8000-000000000001",
		"1a2b3c4d-0000-4000-8000-000000000002",
		"1a2b3c4d-0000-4000-8000-000000000003",
	];

	function node(id: string): NodeResponse {
		return {
			id,
			parent_id: null,
			name: `Page ${id.slice(-1)}`,
			note: null,
			priority: 0,
			data: {layoutMode: null},
			completedAt: null,
			createdAt: 0,
			modifiedAt: 0,
			hasChildren: false,
		};
	}

	const stars: Star[] = [
		{key: IDS[0], nodeId: IDS[0], query: null, name: null, position: 0},
		{key: `${IDS[1]}_#todo`, nodeId: IDS[1], query: "#todo", name: null, position: 1},
		{key: IDS[2], nodeId: IDS[2], query: null, name: null, position: 2},
	];

	let requests: string[];

	async function settle(): Promise<void> {
		await act(async () => {
			await new Promise((resolve) => {
				setTimeout(resolve, 20);
			});
		});
	}

	let root: Root | undefined;

	beforeEach(() => {
		globalThis.IS_REACT_ACT_ENVIRONMENT = true;
		requests = [];
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>(async (input) => {
				const url = input instanceof Request ? input.url : input.toString();
				requests.push(url);
				if (url === "/api/v1/stars") {
					return Promise.resolve(Response.json({stars, nodes: IDS.map(node)}));
				}
				const id = url.slice(url.lastIndexOf("/") + 1);
				return Promise.resolve(Response.json({node: node(id)}));
			}),
		);
	});

	afterEach(() => {
		act(() => {
			root?.unmount();
		});
		vi.unstubAllGlobals();
	});

	describe("Starred section requests", () => {
		it("names every starred row from the one stars request", async () => {
			const queryClient = new QueryClient({defaultOptions: {queries: {retry: false, staleTime: 60_000}}});
			const container = document.createElement("div");
			root = createRoot(container);
			act(() => {
				root?.render(createElement(QueryClientProvider, {client: queryClient}, createElement(StarredSection)));
			});
			// One pass lands the stars; the next lets any row's own node request land.
			await settle();
			await settle();

			// The date settings for pill names are the app-wide preferences query, shared with every other surface.
			expect({
				requests: requests.filter((url) => url !== "/api/v1/preferences"),
				text: container.textContent,
			}).toStrictEqual({
				requests: ["/api/v1/stars"],
				text: "StarredPage 1#todo in Page 2Page 3",
			});
		});
	});
});
