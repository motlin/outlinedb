// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import type {Root} from "react-dom/client";
import type {Star} from "@outlinedb/shared";
import type {NodeResponse} from "../src/node-types.js";

declare global {
	// React reads this to know act() wraps every update.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const {act, createElement} = await import("react");
const {createRoot} = await import("react-dom/client");
const {QueryClient, QueryClientProvider} = await import("@tanstack/react-query");
const {StarredSection} = await import("../src/client/components/left-sidebar.js");

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
