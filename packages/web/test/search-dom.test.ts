// @vitest-environment happy-dom
import {describe, expect, it, afterEach, beforeAll, vi} from "vite-plus/test";
import {useOutlineStore} from "../src/client/stores/outline.js";
import {escapeAction} from "../src/client/search-escape.js";
import type {Root} from "react-dom/client";
import {SearchHelpers} from "../src/client/components/search-helpers.js";
import type {SearchHelpersProps} from "../src/client/components/search-helpers.js";
import {act, createElement} from "react";
import {createRoot} from "react-dom/client";

declare global
{
	// React reads this to know act() wraps every update.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

describe("search escape", () =>
{
	describe("escapeAction", () =>
	{
		it("cancels a committed or typed search, blurs an empty focused box, else focuses search", () =>
		{
			expect([
				escapeAction(
					{
						searchQuery: "a",
						searchInput: "",
						inputFocused: false,
					},
				),
				escapeAction(
					{
						searchQuery: "",
						searchInput: "a",
						inputFocused: true,
					},
				),
				escapeAction(
					{
						searchQuery: "",
						searchInput: "a",
						inputFocused: false,
					},
				),
				escapeAction(
					{
						searchQuery: "",
						searchInput: "",
						inputFocused: true,
					},
				),
				escapeAction(
					{
						searchQuery: "",
						searchInput: "",
						inputFocused: false,
					},
				),
			]).toStrictEqual(["cancel", "cancel", "cancel", "blur", "focus"]);
		});
	});

	describe("blurSearch", () =>
	{
		it("returns to the note at its caret when the search was entered from a note", () =>
		{
			useOutlineStore.setState(
				{
					editingId: null,
					editingNoteId: null,
				},
			);
			useOutlineStore.getState().focusSearch(
				{
					nodeId: "a",
					caretOffset: 5,
					field: "note",
				},
			);
			useOutlineStore.getState().blurSearch();
			const {editingNoteId, editingId, editingNoteCaret} = useOutlineStore.getState();
			expect(
				{
					editingNoteId,
					editingId,
					editingNoteCaret,
				},
			).toStrictEqual(
				{
					editingNoteId: "a",
					editingId: null,
					editingNoteCaret: 5,
				},
			);
		});

		it("returns to the name when the search was entered from a name", () =>
		{
			useOutlineStore.setState(
				{
					editingId: null,
					editingNoteId: null,
				},
			);
			useOutlineStore.getState().focusSearch(
				{
					nodeId: "a",
					caretOffset: 5,
					field: "name",
				},
			);
			useOutlineStore.getState().blurSearch();
			const {editingNoteId, editingId} = useOutlineStore.getState();
			expect(
				{
					editingNoteId,
					editingId,
				},
			).toStrictEqual(
				{
					editingNoteId: null,
					editingId: "a",
				},
			);
		});
	});
});

describe("search helpers scroll", () =>
{
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
});
