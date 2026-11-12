import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {processCombo} from "../src/client/keys/dispatch.js";
import {runShowCompletedToggle, showCompletedCommand} from "../src/client/show-completed-toggle.js";
import type {ShowCompletedToggleInput} from "../src/client/show-completed-toggle.js";
import {outlineRootToShow, showZoom} from "../src/client/show-zoom.js";

describe("show completed store", () => {
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
});

describe("show completed toggle", () => {
	type Call = [string, ...unknown[]];

	function harness(
		input: Pick<ShowCompletedToggleInput, "showCompleted" | "editingId"> & {
			shown: string[];
			hidden: string[];
			completed: string[];
		},
	): {input: ShowCompletedToggleInput; calls: Call[]} {
		const calls: Call[] = [];
		const record =
			(name: string) =>
			(...args: unknown[]): void => {
				calls.push([name, ...args]);
			};
		return {
			calls,
			input: {
				showCompleted: input.showCompleted,
				editingId: input.editingId,
				rowsFor: (showCompleted) => (showCompleted ? input.shown : input.hidden),
				isCompleted: (id) => input.completed.includes(id),
				actions: {
					setShowCompleted: record("setShowCompleted"),
					beginCompletionAnimation: record("beginCompletionAnimation"),
					startCompletionSlideUp: record("startCompletionSlideUp"),
					endCompletionAnimation: record("endCompletionAnimation"),
					startCompletedSlideDown: record("startCompletedSlideDown"),
					endCompletedSlideDown: record("endCompletedSlideDown"),
					resumeEditing: record("resumeEditing"),
				},
			},
		};
	}

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe("runShowCompletedToggle", () => {
		it("hides: slides up the hidden done rows, moves the caret off a hidden row, then ends the slide", () => {
			const {input, calls} = harness({
				showCompleted: true,
				editingId: "b-child",
				shown: ["zoom", "a", "b", "b-child", "c"],
				hidden: ["zoom", "a", "c"],
				completed: ["b"],
			});
			runShowCompletedToggle(input);
			const beforeTimer = [...calls];
			vi.advanceTimersByTime(220);
			expect({beforeTimer, after: calls.slice(beforeTimer.length)}).toStrictEqual({
				beforeTimer: [
					["beginCompletionAnimation", ["b"]],
					["setShowCompleted", false],
					["resumeEditing", "a", 0],
					["startCompletionSlideUp", ["b"]],
				],
				after: [["endCompletionAnimation", ["b"]]],
			});
		});

		it("hides with the caret on a visible row and slides at most 10 rows", () => {
			const done = Array.from({length: 12}, (_, index) => `d${index}`);
			const {input, calls} = harness({
				showCompleted: true,
				editingId: "a",
				shown: ["a", ...done],
				hidden: ["a"],
				completed: done,
			});
			runShowCompletedToggle(input);
			expect(calls).toStrictEqual([
				["beginCompletionAnimation", done.slice(0, 10)],
				["setShowCompleted", false],
				["startCompletionSlideUp", done.slice(0, 10)],
			]);
		});

		it("shows: reveals the rows, then slides down the newly visible done rows", () => {
			const {input, calls} = harness({
				showCompleted: false,
				editingId: null,
				shown: ["a", "b", "b-child", "c"],
				hidden: ["a", "c"],
				completed: ["b"],
			});
			runShowCompletedToggle(input);
			const beforeTimer = [...calls];
			vi.advanceTimersByTime(220);
			expect({beforeTimer, after: calls.slice(beforeTimer.length)}).toStrictEqual({
				beforeTimer: [
					["setShowCompleted", true],
					["startCompletedSlideDown", ["b"]],
				],
				after: [["endCompletedSlideDown", ["b"]]],
			});
		});
	});

	describe("showCompletedCommand", () => {
		const ctx = {items: ["alice-uuid"], zoomedId: null};

		function press(combo: string, isMac: boolean, searching: boolean): {result: string; toggles: number} {
			let toggles = 0;
			const command = showCompletedCommand(
				() => {
					toggles++;
				},
				() => searching,
			);
			const result = processCombo(combo, {show_or_hide_completed: command}, ctx, isMac);
			return {result, toggles};
		}

		it("toggles on Cmd+O while editing and on Ctrl+O off mac", () => {
			expect({mac: press("meta+o", true, false), other: press("ctrl+o", false, false)}).toStrictEqual({
				mac: {result: "claimed", toggles: 1},
				other: {result: "claimed", toggles: 1},
			});
		});

		it("claims Cmd+O and Ctrl+O without toggling while a search is in progress", () => {
			expect({mac: press("meta+o", true, true), other: press("ctrl+o", false, true)}).toStrictEqual({
				mac: {result: "claimed", toggles: 0},
				other: {result: "claimed", toggles: 0},
			});
		});
	});
});

describe("show zoom", () => {
	function run(paneId: string | null, scrollTop: boolean): string[] {
		const calls: string[] = [];
		showZoom("alice", scrollTop, {
			paneId,
			zoomPane: (pane, id) => {
				calls.push(`pane:${pane}:${id}`);
			},
			goToNode: (id) => {
				calls.push(`url:${id}`);
			},
			scrollToTop: (pane) => {
				calls.push(`scroll:${pane ?? "main"}`);
			},
		});
		return calls;
	}

	describe("showZoom", () => {
		it("navigates the main outline and scrolls the page while the main pane is active", () => {
			expect(run(null, true)).toStrictEqual(["url:alice", "scroll:main"]);
		});

		it("zooms the active pane and scrolls its scroller, leaving the URL alone", () => {
			expect(run("BBBBBBBBBBB", true)).toStrictEqual(["pane:BBBBBBBBBBB:alice", "scroll:BBBBBBBBBBB"]);
		});

		it("keeps the scroll position when the zoom does not scroll to the top", () => {
			expect(run("BBBBBBBBBBB", false)).toStrictEqual(["pane:BBBBBBBBBBB:alice"]);
		});
	});

	describe("outlineRootToShow", () => {
		it("shows the requested root once its children are loaded", () => {
			expect(outlineRootToShow("bob", false, "alice")).toBe("bob");
		});

		it("keeps the previous root on screen while the requested root's children load", () => {
			expect(outlineRootToShow("bob", true, "alice")).toBe("alice");
		});

		it("keeps Home on screen while a zoom away from it loads", () => {
			expect(outlineRootToShow("bob", true, null)).toBeNull();
		});

		it("shows the requested root (and its loading state) when nothing was shown yet", () => {
			expect(outlineRootToShow("bob", true, undefined)).toBe("bob");
		});
	});
});
