import {describe, expect, it, vi} from "vite-plus/test";

vi.stubGlobal(
	"localStorage",
	{
		getItem: () => null,
		setItem: () =>
		{
		},
		removeItem: () =>
		{
		},
	},
);
vi.stubGlobal("innerWidth", 1272);
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

vi.mock("../src/client/caret-dom.js", async (importOriginal) => (
{
	...(await importOriginal<Record<string, unknown>>()),
	editorElement: () => (
	{
		blur: () =>
		{
		},
	}),
	selectionTextRange: () => (
	{
		start: 2,
		end: 2,
		reversed: false,
	}),
}));

const {useOutlineStore} = await import("../src/client/stores/outline.js");
const {selectionOf} = await import("../src/client/item-selection.js");

const ctx =
{
	items: ["a"],
	zoomedId: null,
};

function snapshot()
{
	const {editingId, editingCaretOffset, commandPalette, itemSelection} = useOutlineStore.getState();
	return {
		editingId,
		editingCaretOffset,
		open: commandPalette !== null,
		selected: itemSelection.entries.length,
	};
}

describe("command palette store", () =>
{
	it("cancel leaves the caret out and execute restores it", () =>
	{
		useOutlineStore.setState(
			{
				editingId: "a",
				itemSelection: selectionOf([]),
			},
		);
		useOutlineStore.getState().openCommandPalette(ctx);
		expect(useOutlineStore.getState().commandPalette?.ctx).toStrictEqual(ctx);
		useOutlineStore.getState().closeCommandPalette("cancel");
		expect(snapshot()).toMatchObject(
			{
				editingId: null,
				open: false,
			},
		);

		useOutlineStore.setState(
			{
				editingId: "a",
			},
		);
		useOutlineStore.getState().openCommandPalette(ctx);
		useOutlineStore.getState().closeCommandPalette("execute");
		expect(snapshot()).toStrictEqual(
			{
				editingId: "a",
				editingCaretOffset: 2,
				open: false,
				selected: 0,
			},
		);
	});

	it("keeps the item selection open, after cancel, and restores it on execute", () =>
	{
		useOutlineStore.setState(
			{
				editingId: null,
				itemSelection: selectionOf(["x", "y"]),
			},
		);
		useOutlineStore.getState().openCommandPalette(
			{
				items: ["x", "y"],
				zoomedId: null,
			},
		);
		expect(snapshot().selected).toBe(2);
		useOutlineStore.getState().closeCommandPalette("cancel");
		expect(snapshot().selected).toBe(2);
		useOutlineStore.getState().openCommandPalette(
			{
				items: ["x", "y"],
				zoomedId: null,
			},
		);
		useOutlineStore.getState().closeCommandPalette("execute");
		expect(snapshot()).toMatchObject(
			{
				selected: 2,
				open: false,
			},
		);
	});
});
