import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";

const stored = new Map<string, string>();
const fetchMock = vi.fn<typeof fetch>();

function stubGlobals(): void {
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => stored.get(key) ?? null,
		setItem: (key: string, value: string) => {
			stored.set(key, value);
		},
		removeItem: (key: string) => {
			stored.delete(key);
		},
	});
	vi.stubGlobal("innerWidth", 1272);
	vi.stubGlobal("matchMedia", () => ({matches: false, addEventListener: () => {}}));
	vi.stubGlobal("document", {
		documentElement: {dataset: {}},
		body: {classList: {toggle: () => true, contains: () => false}},
	});
	vi.stubGlobal("addEventListener", () => {});
	vi.stubGlobal("fetch", fetchMock);
}

async function loadStore() {
	vi.resetModules();
	const {useOutlineStore} = await import("../src/client/stores/outline.js");
	return useOutlineStore;
}

function patchCalls(): {url: unknown; method: unknown; body: unknown}[] {
	return fetchMock.mock.calls.map(([url, init]) => ({url, method: init?.method, body: init?.body}));
}

beforeEach(() => {
	stored.clear();
	fetchMock.mockReset();
	fetchMock.mockResolvedValue(Response.json({}, {status: 200}));
	stubGlobals();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("showCompleted initial value", () => {
	it("defaults to shown with nothing stored", async () => {
		const store = await loadStore();
		expect(store.getState().showCompleted).toBe(true);
	});

	it("reads completedMode", async () => {
		stored.set("completedMode", "hide");
		const store = await loadStore();
		expect(store.getState().showCompleted).toBe(false);
	});

	it("ignores the old workflowy-show-completed key", async () => {
		stored.set("workflowy-show-completed", "false");
		const store = await loadStore();
		expect({showCompleted: store.getState().showCompleted, stored: Object.fromEntries(stored)}).toStrictEqual({
			showCompleted: true,
			stored: {"workflowy-show-completed": "false"},
		});
	});
});

describe("setShowCompleted", () => {
	it("writes completedMode and PATCHes the account preference once", async () => {
		const store = await loadStore();
		store.getState().setShowCompleted(false);
		expect({
			showCompleted: store.getState().showCompleted,
			completedMode: stored.get("completedMode"),
			calls: patchCalls(),
		}).toStrictEqual({
			showCompleted: false,
			completedMode: "hide",
			calls: [{url: "/api/v1/preferences", method: "PATCH", body: '{"showCompleted":false}'}],
		});
	});

	it("toggleShowCompleted flips the value through the same path", async () => {
		stored.set("completedMode", "hide");
		const store = await loadStore();
		store.getState().toggleShowCompleted();
		expect({
			showCompleted: store.getState().showCompleted,
			completedMode: stored.get("completedMode"),
			calls: patchCalls(),
		}).toStrictEqual({
			showCompleted: true,
			completedMode: "show",
			calls: [{url: "/api/v1/preferences", method: "PATCH", body: '{"showCompleted":true}'}],
		});
	});

	it("leaves completedMode untouched while a search is active, but still updates state", async () => {
		const store = await loadStore();
		store.setState({searchQuery: "x"});
		store.getState().setShowCompleted(false);
		const duringSearch = {
			showCompleted: store.getState().showCompleted,
			completedMode: stored.get("completedMode"),
		};
		store.setState({searchQuery: ""});
		store.getState().setShowCompleted(false);
		expect([duringSearch, stored.get("completedMode")]).toStrictEqual([
			{showCompleted: false, completedMode: undefined},
			"hide",
		]);
	});

	it("ignores the toggle while the search forces completed rows", async () => {
		const store = await loadStore();
		store.setState({searchQuery: "is:complete"});
		store.getState().toggleShowCompleted();
		expect({showCompleted: store.getState().showCompleted, calls: patchCalls()}).toStrictEqual({
			showCompleted: true,
			calls: [],
		});
	});

	it("keeps the local value when the PATCH fails", async () => {
		fetchMock.mockResolvedValue(new Response("nope", {status: 500}));
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const store = await loadStore();
		store.getState().setShowCompleted(false);
		await vi.waitFor(() => {
			expect(error).toHaveBeenCalledOnce();
		});
		error.mockRestore();
		expect([store.getState().showCompleted, stored.get("completedMode")]).toStrictEqual([false, "hide"]);
	});

	it("stays local-only without logging on 503", async () => {
		fetchMock.mockResolvedValue(new Response("{}", {status: 503}));
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const store = await loadStore();
		store.getState().setShowCompleted(false);
		await Promise.resolve();
		await Promise.resolve();
		const logged = error.mock.calls.length;
		error.mockRestore();
		expect([store.getState().showCompleted, logged]).toStrictEqual([false, 0]);
	});
});

describe("adoptShowCompleted", () => {
	it("adopts the server value and rewrites completedMode without a PATCH", async () => {
		stored.set("completedMode", "hide");
		const store = await loadStore();
		store.getState().adoptShowCompleted(true);
		expect({
			showCompleted: store.getState().showCompleted,
			completedMode: stored.get("completedMode"),
			calls: patchCalls(),
		}).toStrictEqual({showCompleted: true, completedMode: "show", calls: []});
	});
});

describe("serverShowCompleted", () => {
	it("is the account value once loaded and null while loading or unavailable", async () => {
		const {EMPTY_PREFERENCES, serverShowCompleted} = await import("../src/client/hooks/use-preferences.js");
		const preferences = {...EMPTY_PREFERENCES, showCompleted: true};
		expect([
			serverShowCompleted(undefined),
			serverShowCompleted({preferences, available: true, error: null}),
			serverShowCompleted({preferences, available: false, error: "no login"}),
		]).toStrictEqual([null, true, null]);
	});
});
