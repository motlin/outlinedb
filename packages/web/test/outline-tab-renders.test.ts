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
const {useOutlineStore} = await import("../src/client/stores/outline.js");
const {fetchChildren} = await import("../src/client/hooks/use-nodes.js");
const {queryClientDefaults} = await import("../src/client/query-retry.js");

const ROWS = 300;

function row(index: number): NodeResponse {
	return {
		id: `n${index}`,
		parent_id: null,
		name: `Row ${index}`,
		note: null,
		priority: index,
		data: {layoutMode: null},
		completedAt: null,
		createdAt: 0,
		modifiedAt: 0,
		hasChildren: false,
	};
}

const rows = Array.from({length: ROWS}, (_, index) => row(index));
// The app's query defaults (60 s staleness, rows shared by id), without retries.
const queryClient = new QueryClient({
	defaultOptions: {...queryClientDefaults, queries: {...queryClientDefaults.queries, retry: false}},
});
const requests: string[] = [];
let root: Root | undefined;

/** A `.children` slide still running: it holds its inline `will-change` until the slide ends. */
function sliding(): boolean {
	return [...document.querySelectorAll<HTMLElement>(".children")].some((el) => el.style.willChange !== "");
}

/**
 * Wait out pending renders, every in-flight query and every running slide, so neither a late response nor a slide
 * ending (a 220 ms fallback timer, which a loaded CI runner stretches) lands outside the measured window.
 */
async function settle(): Promise<void> {
	do {
		await act(async () => {
			await new Promise((resolve) => {
				setTimeout(resolve, 50);
			});
		});
	} while (queryClient.isFetching() > 0 || queryClient.isMutating() > 0 || sliding());
}

beforeAll(async () => {
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
	vi.stubGlobal(
		"fetch",
		vi.fn<typeof fetch>(async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			requests.push(`${init?.method ?? "GET"} ${url}`);
			// The server agrees with the optimistic splice: it answers the lists the cache already shows.
			const cached = (parentId: string | null) =>
				queryClient.getQueryData<NodeResponse[]>(nodeKeys.children(parentId)) ?? [];
			if (url.includes("/move")) {
				return Response.json({nodes: cached("n9")});
			}
			if (url.endsWith("/api/v1/preferences")) {
				// Preferences unavailable: a settled answer, unlike a 404 that every new observer would refetch.
				return Response.json({error: null}, {status: 503});
			}
			if (url.includes("/backlinks")) {
				return Response.json({rootId: null, items: []});
			}
			if (url.includes("/expansion")) {
				return Response.json({});
			}
			if (url.endsWith("/api/v1/nodes")) {
				return Response.json({nodes: rows});
			}
			if (url.includes("/changes")) {
				const since = url.includes("since=");
				return Response.json({
					latest: since ? "2" : "1",
					reset: false,
					changedIds: since ? ["n10"] : [],
					deletedIds: [],
					children: since
						? [
								{parentId: null, nodes: cached(null)},
								{parentId: "n9", nodes: cached("n9")},
							]
						: [],
				});
			}
			return Promise.resolve(url.includes("/children") ? Response.json(rows) : Response.json({}, {status: 404}));
		}),
	);
	// A loaded outline has taken the change feed's mark, so a write reads only what changed since.
	await fetchChildren(null);
	queryClient.setQueryData(nodeKeys.children(null), rows);
	queryClient.setQueryData(nodeKeys.children("n9"), []);
	for (const node of rows) {
		queryClient.setQueryData(nodeKeys.detail(node.id), node);
	}
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	act(() => {
		root?.render(
			createElement(
				QueryClientProvider,
				{client: queryClient},
				createElement(MemoryRouter, null, createElement(OutlineView)),
			),
		);
	});
	await settle();
	act(() => {
		useOutlineStore.setState({editingId: "n10"});
	});
	await settle();
});

afterAll(() => {
	act(() => {
		root?.unmount();
	});
	vi.unstubAllGlobals();
});

describe("Tab render and request count on a large outline", () => {
	it("expands the previous sibling in the same commit as the splice, re-rendering only the two rows involved", async () => {
		const editor = document.querySelector<HTMLElement>('.innerContentContainer.editing[data-node-id="n10"]');
		renders.clear();
		requests.length = 0;
		act(() => {
			editor?.dispatchEvent(
				// oxlint-disable-next-line typescript/no-deprecated -- the keymap reads `which`, which happy-dom fills from `keyCode`.
				new KeyboardEvent("keydown", {key: "Tab", code: "Tab", keyCode: 9, bubbles: true, cancelable: true}),
			);
		});
		await settle();
		expect({
			editing: editor !== null,
			newParentChildren: queryClient
				.getQueryData<NodeResponse[]>(nodeKeys.children("n9"))
				?.map((node) => node.id),
			// The previous sibling once as it opens with the row spliced in and the row once as it mounts under it,
			// then the previous sibling once as its `.children` element mounts and starts the slide-down and once
			// more when the slide ends; no other row of the 300.
			outlineRows: renders.get("OutlineRow") ?? 0,
			nodeRequests: requests.filter((request) => request.includes("/api/v1/nodes")),
		}).toStrictEqual({
			editing: true,
			newParentChildren: ["n10"],
			outlineRows: 4,
			nodeRequests: [
				"GET /api/v1/nodes/n9/backlinks",
				"POST /api/v1/nodes/n10/move",
				"GET /api/v1/nodes/changes?since=1",
			],
		});
	});
});
