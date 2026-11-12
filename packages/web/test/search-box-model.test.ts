import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {createSearchBoxController} from "../src/client/search-box-model.js";

function setup(committed = "")
{
	const state =
	{
		committed,
	};
	const commit = vi.fn<(query: string) => void>();
	const controller = createSearchBoxController(
		{
			commit,
			getCommitted: () => state.committed,
		},
	);
	return {
		state,
		commit,
		controller,
	};
}

describe("createSearchBoxController", () =>
{
	beforeEach(() =>
	{
		vi.useFakeTimers();
	});
	afterEach(() =>
	{
		vi.useRealTimers();
	});

	it("debounces a change by 1000ms", () =>
	{
		const {commit, controller} = setup();
		controller.change("apple");
		vi.advanceTimersByTime(999);
		expect(commit.mock.calls).toStrictEqual([]);
		vi.advanceTimersByTime(1);
		expect(commit.mock.calls).toStrictEqual([["apple"]]);
	});

	it("restarts the debounce on every change and commits only the last value", () =>
	{
		const {commit, controller} = setup();
		controller.change("ap");
		vi.advanceTimersByTime(500);
		controller.change("apple");
		vi.advanceTimersByTime(999);
		expect(commit.mock.calls).toStrictEqual([]);
		vi.advanceTimersByTime(1);
		expect(commit.mock.calls).toStrictEqual([["apple"]]);
	});

	it("commits clearing to empty immediately", () =>
	{
		const {commit, controller} = setup("apple");
		controller.change("");
		expect(commit.mock.calls).toStrictEqual([[""]]);
	});

	it("does nothing when the value equals the committed query, cancelling a pending commit", () =>
	{
		const {commit, controller} = setup("apple");
		controller.change("apples");
		controller.change("apple");
		vi.advanceTimersByTime(2000);
		expect(commit.mock.calls).toStrictEqual([]);
	});

	it("commits on Enter immediately and cancels the pending debounce", () =>
	{
		const {commit, controller} = setup();
		controller.change("ap");
		expect(controller.key("Enter")).toStrictEqual(
			{
				preventDefault: true,
				action: "none",
			},
		);
		expect(commit.mock.calls).toStrictEqual([["ap"]]);
		vi.advanceTimersByTime(1000);
		expect(commit.mock.calls).toStrictEqual([["ap"]]);
	});

	it("re-runs an unchanged query on Enter", () =>
	{
		const {commit, controller} = setup("apple");
		controller.key("Enter", "apple");
		expect(commit.mock.calls).toStrictEqual([["apple"]]);
	});

	it("ignores Enter on an empty input with no committed search", () =>
	{
		const {commit, controller} = setup();
		expect(controller.key("Enter", "")).toStrictEqual(
			{
				preventDefault: true,
				action: "none",
			},
		);
		expect(commit.mock.calls).toStrictEqual([]);
	});

	it("asks to focus the outline on Tab without committing", () =>
	{
		const {commit, controller} = setup();
		expect(controller.key("Tab")).toStrictEqual(
			{
				preventDefault: true,
				action: "focusOutline",
			},
		);
		expect(commit.mock.calls).toStrictEqual([]);
	});

	it("leaves other keys alone", () =>
	{
		const {commit, controller} = setup();
		expect(controller.key("a")).toStrictEqual(
			{
				preventDefault: false,
				action: "none",
			},
		);
		expect(commit.mock.calls).toStrictEqual([]);
	});

	it("dispose cancels a pending commit", () =>
	{
		const {commit, controller} = setup();
		controller.change("apple");
		controller.dispose();
		vi.advanceTimersByTime(2000);
		expect(commit.mock.calls).toStrictEqual([]);
	});
});
