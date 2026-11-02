import {describe, expect, it} from "vite-plus/test";
import {caretAfterSelectionCommand} from "../src/client/focus-maintain.js";

const rows = (...ids: string[]) =>
	ids.map((id) => (
	{
		id,
		parentId: "R",
	}));
const before =
{
	parentId: "R",
	index: 1,
};
const base =
{
	firstId: "Bravo",
	before,
	selectionActive: false,
	editorFocused: false,
};

describe("caretAfterSelectionCommand", () =>
{
	it("returns the end of the first selected row while it is still rendered", () =>
	{
		expect(
			caretAfterSelectionCommand(
				{
					...base,
					rows: rows("Alpha", "Bravo", "Charlie"),
				},
			),
		).toStrictEqual(
			{
				id: "Bravo",
				offset: "end",
			},
		);
	});

	it("falls to the row now at the same index when the first row is gone", () =>
	{
		expect(
			caretAfterSelectionCommand(
				{
					...base,
					rows: rows("Alpha", "Charlie", "Delta"),
				},
			),
		).toStrictEqual(
			{
				id: "Charlie",
				offset: "end",
			},
		);
	});

	it("falls to the previous sibling when the last child was removed", () =>
	{
		expect(
			caretAfterSelectionCommand(
				{
					...base,
					rows: rows("Alpha"),
				},
			),
		).toStrictEqual(
			{
				id: "Alpha",
				offset: "end",
			},
		);
	});

	it("falls to the first visible row when the parent has no children left", () =>
	{
		expect(
			caretAfterSelectionCommand(
				{
					...base,
					before:
					{
						parentId: "Gone",
						index: 0,
					},
					rows: [
						{
							id: "Zed",
							parentId: "R",
						},
					],
				},
			),
		).toStrictEqual(
			{
				id: "Zed",
				offset: "end",
			},
		);
	});

	it("does nothing while the selection is active or an editor has focus", () =>
	{
		expect([
			caretAfterSelectionCommand(
				{
					...base,
					selectionActive: true,
					rows: rows("Bravo"),
				},
			),
			caretAfterSelectionCommand(
				{
					...base,
					editorFocused: true,
					rows: rows("Bravo"),
				},
			),
		]).toStrictEqual([null, null]);
	});
});
