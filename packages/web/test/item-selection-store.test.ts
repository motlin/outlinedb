import {describe, expect, it, vi} from "vite-plus/test";
import {emptySelection} from "../src/client/item-selection.js";
import type {SelectionState} from "../src/client/item-selection.js";

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

const {useOutlineStore} = await import("../src/client/stores/outline.js");

const selection: SelectionState =
{
	entries: [
		{
			id: "Charlie",
			leadOrder: 1,
			subsumedIds: [],
		},
	],
	pivotId: null,
	retractableIds: [],
	counter: 1,
};

describe("item selection store", () =>
{
	it("starts empty and stores a selection", () =>
	{
		const initial = useOutlineStore.getState().itemSelection;
		useOutlineStore.getState().setItemSelection(selection);
		expect([initial, useOutlineStore.getState().itemSelection]).toStrictEqual([emptySelection(), selection]);
	});

	it("clears the selection whenever editing resumes, starts or moves to a name or note", () =>
	{
		const {setItemSelection, resumeEditing, startEditing, focusName, focusNote, clearItemSelection} =
			useOutlineStore.getState();
		const after = (act: () => void) =>
		{
			setItemSelection(selection);
			act();
			return useOutlineStore.getState().itemSelection;
		};
		expect([
			after(() =>
			{
				resumeEditing("Charlie", 0);
			}),
			after(() =>
			{
				startEditing("Charlie");
			}),
			after(() =>
			{
				focusName("Charlie", "end");
			}),
			after(() =>
			{
				focusNote("Charlie");
			}),
			after(clearItemSelection),
		]).toStrictEqual([emptySelection(), emptySelection(), emptySelection(), emptySelection(), emptySelection()]);
	});
});
