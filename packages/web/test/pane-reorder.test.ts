import {describe, expect, it} from "vite-plus/test";
import {REORDER_THRESHOLD, autoScrollSpeed, reorderDrop} from "../src/client/pane-reorder.js";

const A = "AAAAAAAAAAA";
const B = "BBBBBBBBBBB";
const state =
{
	panes: [
		{
			id: A,
		},
		{
			id: B,
		},
	],
};

function box(paneId: string, left: number)
{
	return {
		paneId,
		rect:
		{
			left,
			right: left + 400,
			top: 0,
			bottom: 40,
			width: 400,
			height: 40,
		},
	};
}
const headers = [box("main", 0), box(A, 400), box(B, 800)];

describe("reorderDrop", () =>
{
	it("drops before a header's left half and after its right half, at that header's edge", () =>
	{
		expect(
			{
				beforeB: reorderDrop(state, "main", headers, 850, 20),
				afterB: reorderDrop(state, "main", headers, 1150, 20),
				beforeMain: reorderDrop(state, B, headers, 100, 20),
				afterMain: reorderDrop(state, B, headers, 300, 20),
			},
		).toStrictEqual(
			{
				beforeB:
				{
					insertionIndex: 1,
					dropLine:
					{
						left: 800,
						top: 0,
						height: 40,
					},
				},
				afterB:
				{
					insertionIndex: 2,
					dropLine:
					{
						left: 1200,
						top: 0,
						height: 40,
					},
				},
				beforeMain:
				{
					insertionIndex: 0,
					dropLine:
					{
						left: 0,
						top: 0,
						height: 40,
					},
				},
				afterMain:
				{
					insertionIndex: 1,
					dropLine:
					{
						left: 400,
						top: 0,
						height: 40,
					},
				},
			},
		);
	});

	it("has no drop over the dragged pane's own header or off every header", () =>
	{
		expect(
			{
				own: reorderDrop(state, A, headers, 500, 20),
				below: reorderDrop(state, A, headers, 100, 60),
			},
		).toStrictEqual(
			{
				own: null,
				below: null,
			},
		);
	});
});

describe("autoScrollSpeed", () =>
{
	const workspace =
	{
		left: 0,
		right: 1000,
		top: 0,
		bottom: 800,
		width: 1000,
		height: 800,
	};
	const header =
	{
		left: 0,
		right: 400,
		top: 0,
		bottom: 40,
		width: 400,
		height: 40,
	};

	it("scrolls faster toward the workspace edge, within 75px of it and the source header's band", () =>
	{
		expect(
			{
				threshold: REORDER_THRESHOLD,
				leftEdge: autoScrollSpeed(0, 20, workspace, header),
				left: autoScrollSpeed(37.5, 20, workspace, header),
				middle: autoScrollSpeed(500, 20, workspace, header),
				right: autoScrollSpeed(1000, 20, workspace, header),
				belowHeader: autoScrollSpeed(1000, 60, workspace, header),
			},
		).toStrictEqual(
			{
				threshold: 4,
				leftEdge: -10,
				left: -6,
				middle: 0,
				right: 10,
				belowHeader: 0,
			},
		);
	});
});
