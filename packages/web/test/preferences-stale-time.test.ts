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
const {useRowEmbed, usePreferences} = await import("../src/client/hooks/use-preferences.js");
const {queryClientDefaults} = await import("../src/client/query-retry.js");

let root: Root | undefined;
let reads: number;

beforeEach(() => {
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
	vi.useFakeTimers();
	reads = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			reads += 1;
			return Promise.resolve(Response.json({}));
		}),
	);
});

afterEach(() => {
	act(() => {
		root?.unmount();
	});
	root = undefined;
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

function Row(): null {
	useRowEmbed('<a href="https://example.com">x</a>');
	return null;
}

function Page({rows}: {rows: number}): ReturnType<typeof createElement> {
	usePreferences();
	return createElement("div", null, ...Array.from({length: rows}, (_, index) => createElement(Row, {key: index})));
}

describe("preferences staleness", () => {
	it("does not refetch preferences when rows mount long after the first read", async () => {
		const client = new QueryClient({defaultOptions: queryClientDefaults});
		root = createRoot(document.createElement("div"));
		act(() => {
			root?.render(createElement(QueryClientProvider, {client}, createElement(Page, {rows: 1})));
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5 * 60_000);
		});
		act(() => {
			root?.render(createElement(QueryClientProvider, {client}, createElement(Page, {rows: 3})));
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(reads).toBe(1);
	});
});
