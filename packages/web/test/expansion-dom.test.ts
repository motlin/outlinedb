// @vitest-environment happy-dom
import {QueryClient, QueryObserver, QueryClientProvider} from "@tanstack/react-query";
import {afterEach, expect, it, vi, beforeEach, describe} from "vite-plus/test";
import type {Root} from "react-dom/client";
import {act, createElement} from "react";
import {createRoot} from "react-dom/client";
import {EXPANSION_POLL_MS, expansionPollQuery, loadExpansion} from "../src/client/hooks/use-expansion-sync.js";
import {useOutlineLiveSync} from "../src/client/hooks/use-outline-live-sync.js";

declare global {
	// React reads this to know act() wraps every update.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

describe("expansion poll query", () => {
	const fetchMock = vi.fn<typeof fetch>();

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("polls the expansion change feed every 15s after the page load through a TanStack Query refetch interval", async () => {
		vi.stubGlobal("fetch", fetchMock);
		fetchMock.mockImplementation(async () =>
			Promise.resolve(Response.json({version: "aaaaaaaaaaaaaaaa", expandedIds: ["a"]})),
		);
		await loadExpansion();
		fetchMock.mockReset();
		fetchMock.mockImplementation(async () =>
			Promise.resolve(Response.json({version: "aaaaaaaaaaaaaaaa", expandedIds: null})),
		);
		vi.useFakeTimers();
		const queryClient = new QueryClient();

		const unsubscribe = new QueryObserver(queryClient, expansionPollQuery).subscribe(() => {});
		await vi.advanceTimersByTimeAsync(EXPANSION_POLL_MS * 2);
		unsubscribe();
		queryClient.clear();

		expect({period: EXPANSION_POLL_MS, urls: fetchMock.mock.calls.map(([url]) => url)}).toStrictEqual({
			period: 15_000,
			urls: [
				"/api/v1/expansion?version=aaaaaaaaaaaaaaaa",
				"/api/v1/expansion?version=aaaaaaaaaaaaaaaa",
				"/api/v1/expansion?version=aaaaaaaaaaaaaaaa",
			],
		});
	});
});

describe("expansion socket frame", () => {
	const VERSION = "aaaaaaaaaaaaaaaa";
	const NEWER = "bbbbbbbbbbbbbbbb";

	/** A WebSocket the test opens and feeds frames to by hand. */
	class FakeSocket {
		static readonly instances: FakeSocket[] = [];
		readyState = 0;
		readonly #listeners = new Map<string, ((event: {data?: string}) => void)[]>();

		constructor() {
			FakeSocket.instances.push(this);
		}

		addEventListener(name: string, callback: (event: {data?: string}) => void): void {
			this.#listeners.set(name, [...(this.#listeners.get(name) ?? []), callback]);
		}

		close(): void {
			this.readyState = 3;
		}

		emit(name: "open" | "message", data?: string): void {
			this.readyState = name === "open" ? 1 : this.readyState;
			for (const callback of this.#listeners.get(name) ?? []) {
				callback({data});
			}
		}
	}

	let root: Root | undefined;
	let client: InstanceType<typeof QueryClient>;
	let unsubscribe: () => void;
	let urls: string[];

	function Harness(): null {
		useOutlineLiveSync();
		return null;
	}

	async function settle(): Promise<void> {
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
	}

	beforeEach(async () => {
		globalThis.IS_REACT_ACT_ENVIRONMENT = true;
		urls = [];
		vi.stubGlobal("WebSocket", FakeSocket);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string) => {
				urls.push(input);
				return Promise.resolve(Response.json({version: VERSION, expandedIds: input.includes("?") ? null : []}));
			}),
		);
		await loadExpansion();
		vi.useFakeTimers();
		client = new QueryClient();
		unsubscribe = new QueryObserver(client, expansionPollQuery).subscribe(() => {});
		const container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		act(() => {
			root?.render(createElement(QueryClientProvider, {client}, createElement(Harness)));
		});
		FakeSocket.instances.at(-1)!.emit("open");
		await settle();
		urls = [];
	});

	afterEach(() => {
		act(() => {
			root?.unmount();
		});
		root = undefined;
		unsubscribe();
		client.clear();
		document.body.innerHTML = "";
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	const expansionFrame = (version: string) => JSON.stringify({type: "expansion.changed", version});

	describe("expansion.changed frames on the events socket", () => {
		it("polls the expansion feed once for a new version", async () => {
			FakeSocket.instances.at(-1)!.emit("message", expansionFrame(NEWER));
			await settle();
			expect(urls).toStrictEqual([`/api/v1/expansion?version=${VERSION}`]);
		});

		it("does not poll for the version the tab already holds", async () => {
			FakeSocket.instances.at(-1)!.emit("message", expansionFrame(VERSION));
			await settle();
			expect(urls).toStrictEqual([]);
		});
	});
});
