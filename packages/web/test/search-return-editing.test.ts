import {beforeEach, describe, expect, it, vi} from "vite-plus/test";

vi.stubGlobal(
	"localStorage",
	{
		getItem: () => null,
		setItem: () =>
		{
		},
	},
);
vi.stubGlobal("matchMedia", () => (
{
	matches: false,
	addEventListener: () =>
	{
	},
}));
vi.stubGlobal(
	"document",
	{
		documentElement:
		{
			dataset: {},
		},
		body:
		{
			classList:
			{
				toggle: () => true,
				contains: () => false,
			},
		},
	},
);
vi.stubGlobal("addEventListener", () => {});

const {useOutlineStore} = await import("../src/client/stores/outline.js");
const {initialNavState} = await import("../src/client/nav-stack.js");

function editingState()
{
	const {editingId, editingCaretOffset, lastEditedId, searchFocused, searchReturn, searchInput} =
		useOutlineStore.getState();
	return {
		editingId,
		editingCaretOffset,
		lastEditedId,
		searchFocused,
		searchReturn,
		searchInput,
	};
}

describe("Escape focuses search and returns to the edited node", () =>
{
	beforeEach(() =>
	{
		useOutlineStore.setState(
			{
				nav: initialNavState,
				zoomedNodeId: null,
				editingId: null,
				editingCaretOffset: null,
				editingClickPosition: null,
				lastEditedId: null,
				searchFocused: false,
				searchReturn: null,
				searchInput: "",
				searchQuery: "",
			},
		);
	});

	it("remembers the edited node and caret, then resumes editing there when search blurs", () =>
	{
		useOutlineStore.getState().startEditing("node-a");
		useOutlineStore.getState().focusSearch(
			{
				nodeId: "node-a",
				caretOffset: 7,
				field: "name",
			},
		);
		const focused = editingState();
		useOutlineStore.getState().blurSearch();
		const blurred = editingState();
		expect(
			{
				focused,
				blurred,
			},
		).toStrictEqual(
			{
				focused:
				{
					editingId: null,
					editingCaretOffset: null,
					lastEditedId: "node-a",
					searchFocused: true,
					searchReturn:
					{
						nodeId: "node-a",
						caretOffset: 7,
						field: "name",
					},
					searchInput: "",
				},
				blurred:
				{
					editingId: "node-a",
					editingCaretOffset: 7,
					lastEditedId: "node-a",
					searchFocused: false,
					searchReturn: null,
					searchInput: "",
				},
			},
		);
	});

	it("a repeat focusSearch(null) keeps the saved caret", () =>
	{
		useOutlineStore.getState().focusSearch(
			{
				nodeId: "node-a",
				caretOffset: 15,
				field: "name",
			},
		);
		useOutlineStore.getState().focusSearch(null);
		expect(useOutlineStore.getState().searchReturn).toStrictEqual(
			{
				nodeId: "node-a",
				caretOffset: 15,
				field: "name",
			},
		);
	});

	it("blurring search that was not focused from editing resumes nothing", () =>
	{
		useOutlineStore.getState().focusSearch(null);
		useOutlineStore.getState().blurSearch();
		expect(editingState()).toStrictEqual(
			{
				editingId: null,
				editingCaretOffset: null,
				lastEditedId: null,
				searchFocused: false,
				searchReturn: null,
				searchInput: "",
			},
		);
	});

	it("cancelling search clears the input and resumes the saved node and caret", () =>
	{
		useOutlineStore.getState().focusSearch(
			{
				nodeId: "node-a",
				caretOffset: 3,
				field: "name",
			},
		);
		useOutlineStore.getState().setSearchInput("draft");
		useOutlineStore.getState().cancelSearch(() => {});
		expect(editingState()).toStrictEqual(
			{
				editingId: "node-a",
				editingCaretOffset: 3,
				lastEditedId: "node-a",
				searchFocused: false,
				searchReturn: null,
				searchInput: "",
			},
		);
	});

	it("starting a fresh edit clears any restored caret offset", () =>
	{
		useOutlineStore.getState().focusSearch(
			{
				nodeId: "node-a",
				caretOffset: 4,
				field: "name",
			},
		);
		useOutlineStore.getState().blurSearch();
		useOutlineStore.getState().startEditing("node-b");
		expect(editingState()).toStrictEqual(
			{
				editingId: "node-b",
				editingCaretOffset: null,
				lastEditedId: "node-b",
				searchFocused: false,
				searchReturn: null,
				searchInput: "",
			},
		);
	});
});
