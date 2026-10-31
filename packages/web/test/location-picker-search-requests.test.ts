// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import type {Root} from "react-dom/client";

declare global {
	// React reads this to know act() wraps every update.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const {act, createElement} = await import("react");
const {createRoot} = await import("react-dom/client");
const {QueryClient, QueryClientProvider} = await import("@tanstack/react-query");
const {LocationPickerHost} = await import("../src/client/components/location-picker-host.js");
const {useOutlineStore} = await import("../src/client/stores/outline.js");
const {nodeKeys} = await import("../src/client/node-cache.js");
const {EMPTY_PREFERENCES} = await import("../src/client/hooks/use-preferences.js");

/** Each `/api/search/locations` request in order, with a resolver to answer it later. */
let searches: {query: string; answer: (label?: string) => void}[];

let relatedRequests: {nodeId: string; type: string}[];

/** Root metadata `ai.embeddingStatus` the stubbed preferences answer. */
let aiEmbeddingStatus: string | null;

let root: Root | undefined;

beforeEach(() => {
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
	searches = [];
	relatedRequests = [];
	aiEmbeddingStatus = "finished";
	sessionStorage.clear();
	vi.stubGlobal(
		"fetch",
		vi.fn<typeof fetch>(async (input, init) => {
			const url = input instanceof Request ? input.url : input.toString();
			if (url === "/api/search/locations") {
				const {query} = JSON.parse(init?.body as string) as {query: string};
				return new Promise<Response>((resolve) => {
					searches.push({
						query,
						answer: (label) => {
							resolve(
								Response.json({
									results:
										label === undefined
											? []
											: [{id: `hit-${label}`, labelHtml: label, ancestors: []}],
								}),
							);
						},
					});
				});
			}
			if (url === "/api/related") {
				const body = JSON.parse(init?.body as string) as {nodeId: string; type: string};
				relatedRequests.push(body);
				return Response.json({
					results: [
						{id: "rel1", name: "Related <b>One</b>", note: null, distance: 0.2, path: ["Top", "Mid"]},
					],
				});
			}
			if (url.endsWith("/ancestors")) {
				return Response.json({ancestors: []});
			}
			if (url === "/api/v1/preferences") {
				return Response.json({...EMPTY_PREFERENCES, aiEmbeddingStatus});
			}
			if (url === "/api/v1/stars") {
				return Response.json({stars: [], nodes: []});
			}
			return Response.json({});
		}),
	);
});

afterEach(() => {
	act(() => {
		useOutlineStore.getState().closeLocationPicker(undefined);
		root?.unmount();
	});
	vi.unstubAllGlobals();
});

async function flush(): Promise<void> {
	await act(async () => {
		// A macrotask turn drains every promise chain the stubbed fetch started, however loaded the machine is.
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 0);
		});
	});
}

function type(input: HTMLInputElement, value: string): void {
	act(() => {
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
		input.dispatchEvent(new Event("input", {bubbles: true}));
	});
}

describe("Location picker search requests", () => {
	it("requests on every keystroke without a debounce, and a stale reply never replaces the latest", async () => {
		const queryClient = new QueryClient({defaultOptions: {queries: {retry: false, staleTime: 60_000}}});
		const container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		act(() => {
			root?.render(createElement(QueryClientProvider, {client: queryClient}, createElement(LocationPickerHost)));
			void useOutlineStore
				.getState()
				.openLocationPicker({forItemId: "item", headerText: "Move To..."}, {x: 0, y: 0});
		});
		await flush();
		const input = document.querySelector<HTMLInputElement>('input[placeholder="Find location..."]');
		if (input === null) {
			throw new Error("picker input missing");
		}

		type(input, "a");
		type(input, "ab");
		const requested = searches.map((search) => search.query);

		// The latest reply lands first, then the stale one arrives late.
		searches[1]?.answer("LatestHit");
		await flush();
		searches[0]?.answer("StaleHit");
		await flush();

		const text = document.body.textContent;
		expect({
			requested,
			latest: text.includes("LatestHit"),
			stale: text.includes("StaleHit"),
		}).toStrictEqual({requested: ["a", "ab"], latest: true, stale: false});
	});
});

describe("Location picker options", () => {
	async function mount(): Promise<void> {
		const queryClient = new QueryClient({defaultOptions: {queries: {retry: false, staleTime: 60_000}}});
		const container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		act(() => {
			root?.render(createElement(QueryClientProvider, {client: queryClient}, createElement(LocationPickerHost)));
		});
		await flush();
	}

	it("lists an eager searcher's results with no query and no create rows when it has no action", async () => {
		await mount();
		act(() => {
			void useOutlineStore.getState().openLocationPicker(
				{
					forItemId: "a",
					headerText: "Select child...",
					searcher: {eager: true, action: false, search: () => [{id: "c1", labelHtml: "C1"}]},
				},
				{x: 0, y: 0},
			);
		});
		await flush();
		const items = [...document.querySelectorAll("a.menuItem")];
		expect(items.map((item) => item.querySelector("[data-menu-item-label]")?.textContent)).toStrictEqual(["C1"]);
		expect(document.body.textContent).not.toContain('New "');
	});

	it("names the sub-action in footer B", async () => {
		await mount();
		act(() => {
			void useOutlineStore
				.getState()
				.openLocationPicker(
					{forItemId: "a", headerText: "Mirror...", subActionName: "Mirror to"},
					{x: 0, y: 0},
				);
		});
		await flush();
		type(document.querySelector<HTMLInputElement>("input[placeholder='Find location...']")!, "x");
		await flush();
		expect(document.body.innerHTML).toContain('<div>Mirror to "x" in…</div>');
	});

	it("hides the input when getFilter supplies the query", async () => {
		await mount();
		act(() => {
			void useOutlineStore
				.getState()
				.openLocationPicker({forItemId: "a", headerText: "Move...", getFilter: () => "qz"}, {x: 0, y: 0});
		});
		await flush();
		expect(document.querySelector("input[placeholder='Find location...']")).toBeNull();
		expect(searches.map((search) => search.query)).toStrictEqual(["qz"]);
	});
});

describe("Location picker related nodes", () => {
	async function openRelated(): Promise<string[]> {
		const queryClient = new QueryClient({defaultOptions: {queries: {retry: false, staleTime: 60_000}}});
		const container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		act(() => {
			root?.render(createElement(QueryClientProvider, {client: queryClient}, createElement(LocationPickerHost)));
			void useOutlineStore
				.getState()
				.openLocationPicker(
					{forItemId: "row", headerText: "link to", relatedToId: "row", getFilter: () => ""},
					{x: 0, y: 0},
				);
		});
		await flush();
		await flush();
		return [...document.querySelectorAll("a.menuItem")].map(
			(item) => item.querySelector("[data-menu-item-label]")?.textContent ?? "",
		);
	}

	it("lists semantically related nodes for relatedToId when the filter is empty", async () => {
		const labels = await openRelated();

		expect({requests: relatedRequests, labels}).toStrictEqual({
			requests: [{nodeId: "row", type: "link-targets", limit: 8, threshold: 0.6}],
			labels: ["Related One", 'New "" in: Notes', 'New "" in…'],
		});
	});

	it.each([null, "requested"])(
		"asks for no related nodes until ai.embeddingStatus is finished (%s)",
		async (status) => {
			aiEmbeddingStatus = status;

			const labels = await openRelated();

			expect({requests: relatedRequests, labels}).toStrictEqual({
				requests: [],
				labels: ['New "" in: Notes', 'New "" in…'],
			});
		},
	);
});

describe("Location picker labels, pending state and reveal", () => {
	async function mountWith(client: InstanceType<typeof QueryClient>): Promise<void> {
		const container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		act(() => {
			root?.render(createElement(QueryClientProvider, {client}, createElement(LocationPickerHost)));
		});
		await flush();
	}

	function open(anchor = {x: 0, y: 0}): void {
		act(() => {
			void useOutlineStore.getState().openLocationPicker({forItemId: "item", headerText: "Move To..."}, anchor);
		});
	}

	it("renders recent and footer labels as plain text, not escaped markup", async () => {
		sessionStorage.setItem("recentlySavedLocations", JSON.stringify([["n1", 1]]));
		const queryClient = new QueryClient({defaultOptions: {queries: {retry: false, staleTime: 60_000}}});
		queryClient.setQueryData(nodeKeys.detail("n1"), {id: "n1", name: "<b>Hub</b> &amp; Co"});
		await mountWith(queryClient);
		open();
		await flush();
		const labels = [...document.querySelectorAll("a.menuItem [data-menu-item-label]")].map((label) =>
			label.innerHTML.replace(/ data-menu-item-label=""/u, ""),
		);
		expect(labels).toStrictEqual([
			"<div>Hub &amp; Co</div>",
			'New "" in: <b>Hub &amp; Co</b>',
			'<div>New "" in…</div>',
		]);
	});

	it("drops recents whose node no longer exists and falls back to Notes", async () => {
		sessionStorage.setItem("recentlySavedLocations", JSON.stringify([["gone", 1]]));
		await mountWith(new QueryClient({defaultOptions: {queries: {retry: false, staleTime: 60_000}}}));
		open();
		await flush();
		const labels = [...document.querySelectorAll("a.menuItem [data-menu-item-label]")].map(
			(label) => label.textContent,
		);
		expect(labels).toStrictEqual(['New "" in: Notes', 'New "" in…']);
	});

	it("shows no help text while the search is pending, then the help text for zero results", async () => {
		await mountWith(new QueryClient({defaultOptions: {queries: {retry: false, staleTime: 60_000}}}));
		open();
		await flush();
		type(document.querySelector<HTMLInputElement>('input[placeholder="Find location..."]')!, "qz");
		const pending = {
			help: document.querySelector(".help-text"),
			footers: document.querySelectorAll("a.menuItem").length,
		};
		searches[0]?.answer();
		await flush();
		expect(pending).toStrictEqual({help: null, footers: 2});
		expect(document.querySelector(".help-text")?.textContent).toBe("No matching locations found");
	});

	it("does not expose New rows in step 2", async () => {
		await mountWith(new QueryClient({defaultOptions: {queries: {retry: false, staleTime: 60_000}}}));
		open();
		await flush();
		type(document.querySelector<HTMLInputElement>('input[placeholder="Find location..."]')!, "qz");
		const footerB = [...document.querySelectorAll("a.menuItem")].at(-1) as HTMLElement;
		act(() => {
			footerB.click();
		});
		await flush();
		expect({
			header: document.querySelector(".menu-section-header")?.textContent,
			news: [...document.querySelectorAll("a.menuItem")].filter((item) => item.textContent.includes("New"))
				.length,
		}).toStrictEqual({header: 'New "qz" in…', news: 0});
	});

	it("anchors the wrapper at the caret bottom without an extra offset", async () => {
		await mountWith(new QueryClient({defaultOptions: {queries: {retry: false, staleTime: 60_000}}}));
		open({x: 10, y: 20});
		await flush();
		const wrapper = document.querySelector<HTMLElement>("[data-popper-placement]");
		expect(wrapper?.style.transform).toBe("translate(10px, 20px)");
	});

	it("reveals each highlighted match horizontally once rows mount", async () => {
		await mountWith(new QueryClient({defaultOptions: {queries: {retry: false, staleTime: 60_000}}}));
		const reveal = vi.fn<(options?: ScrollIntoViewOptions) => void>();
		Element.prototype.scrollIntoView = reveal;
		open();
		await flush();
		type(document.querySelector<HTMLInputElement>('input[placeholder="Find location..."]')!, "qz");
		reveal.mockClear();
		searches[0]?.answer("<b><u>Hit</u></b> Hub");
		await flush();
		// One call per `<b>` in the labels: the match, and the default location in footer A.
		const options = {inline: "center", block: "nearest"};
		expect(reveal.mock.calls).toStrictEqual([[options], [options]]);
	});
});
