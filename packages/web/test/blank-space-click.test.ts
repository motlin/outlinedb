import {describe, expect, it} from "vite-plus/test";
import {planBlankSpaceClick} from "../src/client/blank-space-click.js";

describe("planBlankSpaceClick", () =>
{
	it("follows upstream's xy4", () =>
	{
		expect(
			{
				selected: planBlankSpaceClick(
					{
						selectionActive: true,
						lastVisibleRowId: "r9",
						searching: false,
						visibleChildCount: 3,
					},
				),
				lastRow: planBlankSpaceClick(
					{
						selectionActive: false,
						lastVisibleRowId: "r9",
						searching: false,
						visibleChildCount: 3,
					},
				),
				empty: planBlankSpaceClick(
					{
						selectionActive: false,
						lastVisibleRowId: null,
						searching: false,
						visibleChildCount: 0,
					},
				),
				emptySearching: planBlankSpaceClick(
					{
						selectionActive: false,
						lastVisibleRowId: null,
						searching: true,
						visibleChildCount: 0,
					},
				),
			},
		).toStrictEqual(
			{
				selected:
				{
					kind: "none",
				},
				lastRow:
				{
					kind: "edit-end",
					id: "r9",
				},
				empty:
				{
					kind: "add-child",
					index: 0,
				},
				emptySearching:
				{
					kind: "none",
				},
			},
		);
	});
});
