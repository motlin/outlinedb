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
const {MemoryRouter} = await import("react-router-dom");
const {ChangesView} = await import("../src/client/components/changes-view.js");

const START = "2026-10-01T09:30:00.000Z";
const EMPTY_CHANGES = {
	changes: [],
	tree: [],
	summary: {added: 0, deleted: 0, changed: 0, moved: 0, completed: 0, uncompleted: 0},
	cutoffDate: START,
};

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
});

async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) {
		await act(async () => {
			await new Promise((resolve) => {
				setTimeout(resolve, 0);
			});
		});
	}
}

async function mount(searchForChangesAfter: string | null): Promise<string[]> {
	const urls: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) => {
			urls.push(url);
			const body = url.startsWith("/api/v1/preferences")
				? {...EMPTY_PREFERENCES, searchForChangesAfter}
				: EMPTY_CHANGES;
			return Promise.resolve(Response.json(body));
		}),
	);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	const queryClient = new QueryClient({defaultOptions: {queries: {retry: false}}});
	await act(async () => {
		root?.render(
			createElement(
				QueryClientProvider,
				{client: queryClient},
				createElement(MemoryRouter, {initialEntries: ["/changes"]}, createElement(ChangesView)),
			),
		);
		await Promise.resolve();
	});
	await settle();
	return urls;
}

describe("ChangesView updates start", () => {
	it("offers the account's searchForChangesAfter as a cutoff", async () => {
		const urls = await mount(START);
		const button = [...host!.querySelectorAll("button")].find((b) => b.textContent === "Since updates start");

		await act(async () => {
			button?.click();
			await Promise.resolve();
		});
		await settle();

		expect({
			found: button !== undefined,
			input: host!.querySelector<HTMLInputElement>("#since-input")?.value,
			changeFetches: urls.filter((url) => url.startsWith("/api/changes")),
		}).toStrictEqual({
			found: true,
			input: START,
			changeFetches: ["/api/changes?since=1d", `/api/changes?since=${encodeURIComponent(START)}`],
		});
	});

	it("hides the button when the account has no start", async () => {
		await mount(null);

		expect([...host!.querySelectorAll("button")].map((b) => b.textContent)).toStrictEqual(["Update"]);
	});
});
