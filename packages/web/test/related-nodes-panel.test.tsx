// @vitest-environment happy-dom
import {afterEach, beforeAll, describe, expect, it, vi} from "vite-plus/test";
import type {Root} from "react-dom/client";
import {EMPTY_PREFERENCES} from "../src/client/hooks/use-preferences.js";

declare global {
	// React reads this to know act() wraps every update.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const {act, createElement} = await import("react");
const {createRoot} = await import("react-dom/client");
const {QueryClient, QueryClientProvider} = await import("@tanstack/react-query");
const {RelatedNodesPanel} = await import("../src/client/components/related-nodes-panel.js");
const {useOutlineStore} = await import("../src/client/stores/outline.js");

let root: Root | undefined;
let host: HTMLElement | undefined;

beforeAll(() => {
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
	vi.unstubAllGlobals();
	await act(async () => {
		root?.unmount();
		await Promise.resolve();
	});
	host?.remove();
	useOutlineStore.setState({relatedNodesPanelOpen: false, lastEditedId: null});
});

/** Flush pending work a few macrotasks deep; under fake timers that is a zero-length advance, so the clock stays put. */
async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) {
		await act(async () => {
			await (vi.isFakeTimers()
				? vi.advanceTimersByTimeAsync(0)
				: new Promise((resolve) => {
						setTimeout(resolve, 0);
					}));
		});
	}
}

interface Account {
	/** `ai.embeddingStatus`. */
	status: string | null;
	/** Whether the preferences endpoint answers 503 (internal API not configured). */
	unavailable?: boolean;
	dismissed: boolean;
	/** Whether the account's `ai` feature is on (default true). */
	aiFeature?: boolean;
	/** Whether the panel starts open (default true). */
	open?: boolean;
}

/** Mount the open panel over stubbed preferences, features and related endpoints; returns the non-GET requests and related asks. */
async function mount(account: Account): Promise<{writes: string[]; related: number}> {
	const seen = {writes: [] as string[], related: 0};
	let {status, dismissed} = account;
	const answer = (url: string, init?: RequestInit): Response => {
		const method = init?.method ?? "GET";
		if (url === "/api/related") {
			seen.related++;
			return Response.json({
				results: [{id: "rel1", name: "Related <b>One</b>", note: null, distance: 0.25, path: ["Top"]}],
			});
		}
		if (method !== "GET") {
			seen.writes.push(`${method} ${url} ${init?.body as string}`);
		}
		if (url === "/api/v1/preferences") {
			if (account.unavailable === true) {
				return Response.json({error: "not configured"}, {status: 503});
			}
			if (method === "PATCH") {
				const patch = JSON.parse(init?.body as string) as {
					aiEmbeddingStatus?: string;
					aiEmbeddingTooltipDismissed?: boolean;
				};
				status = patch.aiEmbeddingStatus ?? status;
				dismissed = patch.aiEmbeddingTooltipDismissed ?? dismissed;
			}
			return Response.json({
				...EMPTY_PREFERENCES,
				aiEmbeddingStatus: status,
				aiEmbeddingTooltipDismissed: dismissed,
			});
		}
		if (url === "/api/v1/features/ai") {
			return Response.json({enabled: {}});
		}
		return Response.json({
			visible: [],
			enabled: account.aiFeature === false ? {} : {ai: true},
			available: true,
		});
	};
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => Promise.resolve(answer(url, init))),
	);
	useOutlineStore.setState({relatedNodesPanelOpen: account.open ?? true, lastEditedId: "row"});
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	const queryClient = new QueryClient({defaultOptions: {queries: {retry: false}}});
	await act(async () => {
		root?.render(createElement(QueryClientProvider, {client: queryClient}, <RelatedNodesPanel />));
		await Promise.resolve();
	});
	await settle();
	return seen;
}

function panelText(): string | null {
	return host!.querySelector(".related-nodes-panel")?.textContent ?? null;
}

async function clickButton(label: string): Promise<void> {
	const button = [...host!.querySelectorAll("button")].find((b) => b.textContent === label);
	await act(async () => {
		button?.click();
		await Promise.resolve();
	});
	await settle();
}

const RESULTS = "Related Nodes×Related One75%TopBased on semantic similarity using embeddings";
const ONBOARDING =
	"Related Nodes×Chat with Your NotesBetaAsk questions about your notes, discover new insights, and turn your ideas into action.Not nowEnable AIThis will send all your notes to third-party AI services for processing.  See our AI terms for details.";
const GETTING_READY =
	"Related Nodes×Chat with Your NotesBetaGetting everything ready...This might take a few minutes. You can close this window or keep it open - we’ll let you know when it’s ready.";

describe("RelatedNodesPanel AI embedding onboarding", () => {
	it("lists related nodes once ai.embeddingStatus is finished, writing nothing when the tooltip was dismissed", async () => {
		const seen = await mount({status: "finished", dismissed: true});

		expect({text: panelText(), seen}).toStrictEqual({text: RESULTS, seen: {writes: [], related: 1}});
	});

	it("sets ai.embedding_tooltip_dismissed the first time the ready panel opens", async () => {
		const seen = await mount({status: "finished", dismissed: false});

		expect({text: panelText(), seen}).toStrictEqual({
			text: RESULTS,
			seen: {writes: ['PATCH /api/v1/preferences {"aiEmbeddingTooltipDismissed":true}'], related: 1},
		});
	});

	it("lists related nodes when the internal API is unavailable", async () => {
		const seen = await mount({status: null, dismissed: false, unavailable: true});

		expect({text: panelText(), seen}).toStrictEqual({text: RESULTS, seen: {writes: [], related: 1}});
	});

	it("shows upstream's Enable AI prompt instead of results while ai.embeddingStatus is unset", async () => {
		const seen = await mount({status: null, dismissed: false});

		expect({text: panelText(), seen}).toStrictEqual({text: ONBOARDING, seen: {writes: [], related: 0}});
	});

	it("links the AI terms like upstream", async () => {
		await mount({status: null, dismissed: false});

		const link = host!.querySelector("a");
		expect({
			href: link?.getAttribute("href"),
			target: link?.getAttribute("target"),
			title: link?.title,
		}).toStrictEqual({
			href: "https://workflowy.com/ai-terms",
			target: "_blank",
			title: "Workflowy AI terms and conditions",
		});
	});

	it("requests embeddings on Enable AI and then shows Getting everything ready", async () => {
		const seen = await mount({status: null, dismissed: false});

		await clickButton("Enable AI");

		expect({text: panelText(), seen}).toStrictEqual({
			text: GETTING_READY,
			seen: {writes: ['PATCH /api/v1/preferences {"aiEmbeddingStatus":"requested"}'], related: 0},
		});
	});

	it("turns the ai feature off and closes the panel on Not now", async () => {
		const seen = await mount({status: null, dismissed: false});

		await clickButton("Not now");

		expect({text: panelText(), open: useOutlineStore.getState().relatedNodesPanelOpen, seen}).toStrictEqual({
			text: null,
			open: false,
			seen: {writes: ['POST /api/v1/features/ai {"on":false}'], related: 0},
		});
	});

	it("shows Getting everything ready while ai.embeddingStatus is requested", async () => {
		const seen = await mount({status: "requested", dismissed: false});

		expect({text: panelText(), seen}).toStrictEqual({text: GETTING_READY, seen: {writes: [], related: 0}});
	});
});

describe("RelatedNodesPanel AI enable flow", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	/**
	 * Mount closed, then report whether the panel is open just before and after upstream's 3s boot delay. The fake
	 * clock never follows the real one, so a slow mount cannot carry the delay past the `before` check.
	 */
	async function openedAfterDelay(account: Account): Promise<{before: boolean; after: boolean}> {
		vi.useFakeTimers();
		await mount({...account, open: false});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(2900);
		});
		const before = useOutlineStore.getState().relatedNodesPanelOpen;
		await act(async () => {
			await vi.advanceTimersByTimeAsync(200);
		});
		return {before, after: useOutlineStore.getState().relatedNodesPanelOpen};
	}

	it("opens the panel on the Enable AI prompt 3s after load when the ai feature is on and the status unset", async () => {
		await expect(openedAfterDelay({status: null, dismissed: false})).resolves.toStrictEqual({
			before: false,
			after: true,
		});
	});

	it("stays closed when the ai feature is off", async () => {
		await expect(openedAfterDelay({status: null, dismissed: false, aiFeature: false})).resolves.toStrictEqual({
			before: false,
			after: false,
		});
	});

	it("stays closed once embeddings were requested", async () => {
		await expect(openedAfterDelay({status: "requested", dismissed: false})).resolves.toStrictEqual({
			before: false,
			after: false,
		});
	});
});
