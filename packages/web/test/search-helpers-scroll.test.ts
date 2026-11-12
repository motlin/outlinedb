// @vitest-environment happy-dom
import {afterEach, beforeAll, describe, expect, it, vi} from "vite-plus/test";
import type {Root} from "react-dom/client";
import {SearchHelpers} from "../src/client/components/search-helpers.js";
import type {SearchHelpersProps} from "../src/client/components/search-helpers.js";

declare global
{
	// React reads this to know act() wraps every update.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const {act, createElement} = await import("react");
const {createRoot} = await import("react-dom/client");

let root: Root | undefined;

beforeAll(() =>
{
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() =>
{
	act(() =>
	{
		root?.unmount();
	});
	root = undefined;
	document.body.innerHTML = "";
	vi.restoreAllMocks();
});

function mount(overrides: Partial<SearchHelpersProps>): void
{
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	act(() =>
	{
		root?.render(
			createElement(
				SearchHelpers,
				{
					query: "",
					focused: true,
					autocompletePopulated: false,
					tags:
					{
						hashTags: [],
						atTags: [],
					},
					selection:
					{
						tab: 2,
						chip: 5,
					},
					onHoverTab: () =>
					{
					},
					onInsert: () =>
					{
					},
					...overrides,
				},
			),
		);
	});
}

describe("SearchHelpers keyboard scrolling", () =>
{
	it("scrolls the keyboard-selected chip into view smoothly", () =>
	{
		const calls: [string | null, unknown][] = [];
		vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(function (
			this: HTMLElement,
			options?: boolean | ScrollIntoViewOptions,
		)
		{
			calls.push([this.textContent, options]);
		});
		mount(
			{
				keyboardMode: true,
			},
		);

		expect(calls).toStrictEqual([
			[
				"tomorrow",
				{
					behavior: "smooth",
					block: "nearest",
				},
			],
		]);
	});

	it("does not scroll a hover-selected chip", () =>
	{
		const spy = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
		mount(
			{
				keyboardMode: false,
			},
		);

		expect(spy).not.toHaveBeenCalled();
	});
});
