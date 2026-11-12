import {describe, expect, it} from "vite-plus/test";
import {planCheckboxClick} from "../src/client/checkbox-complete.js";

describe("planCheckboxClick", () =>
{
	it("runs the complete command for an ordinary row, completing or not", () =>
	{
		expect([
			planCheckboxClick(
				{
					isCompleted: false,
					paneId: "main",
					isPaneZoomItem: false,
					parentId: "p",
				},
			),
			planCheckboxClick(
				{
					isCompleted: true,
					paneId: "main",
					isPaneZoomItem: false,
					parentId: "p",
				},
			),
		]).toStrictEqual([
			{
				kind: "command",
				focusRowAfter: false,
			},
			{
				kind: "command",
				focusRowAfter: true,
			},
		]);
	});

	it("runs the command for the main pane's zoom root, which the command zooms out", () =>
	{
		expect(
			planCheckboxClick(
				{
					isCompleted: false,
					paneId: "main",
					isPaneZoomItem: true,
					parentId: "p",
				},
			),
		).toStrictEqual(
			{
				kind: "command",
				focusRowAfter: false,
			},
		);
	});

	it("completes a side pane's zoom item without moving focus and zooms that pane to the parent", () =>
	{
		expect(
			planCheckboxClick(
				{
					isCompleted: false,
					paneId: "pane-2",
					isPaneZoomItem: true,
					parentId: "p",
				},
			),
		).toStrictEqual(
			{
				kind: "pane",
				zoomPaneTo: "p",
			},
		);
	});

	it("only focuses the pane when its zoom item is uncompleted or has no parent", () =>
	{
		expect([
			planCheckboxClick(
				{
					isCompleted: true,
					paneId: "pane-2",
					isPaneZoomItem: true,
					parentId: "p",
				},
			),
			planCheckboxClick(
				{
					isCompleted: false,
					paneId: "pane-2",
					isPaneZoomItem: true,
					parentId: null,
				},
			),
		]).toStrictEqual([
			{
				kind: "pane",
				zoomPaneTo: null,
			},
			{
				kind: "pane",
				zoomPaneTo: null,
			},
		]);
	});

	it("uses the command for a row that is not the side pane's zoom item", () =>
	{
		expect(
			planCheckboxClick(
				{
					isCompleted: false,
					paneId: "pane-2",
					isPaneZoomItem: false,
					parentId: "p",
				},
			),
		).toStrictEqual(
			{
				kind: "command",
				focusRowAfter: false,
			},
		);
	});
});
