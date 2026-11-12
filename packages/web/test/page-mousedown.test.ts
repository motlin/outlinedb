import {describe, expect, it} from "vite-plus/test";
import {shouldClearSelectionOnPageMouseDown} from "../src/client/page-mousedown.js";

const base =
{
	selectionActive: true,
	button: 0,
	meta: false,
	alt: false,
	ctrl: false,
	shift: false,
	onSelectedBullet: false,
};

describe("shouldClearSelectionOnPageMouseDown", () =>
{
	it("is true only for a plain left press with a selection, off a selected bullet", () =>
	{
		expect(
			{
				plain: shouldClearSelectionOnPageMouseDown(base),
				noSelection: shouldClearSelectionOnPageMouseDown(
					{
						...base,
						selectionActive: false,
					},
				),
				right: shouldClearSelectionOnPageMouseDown(
					{
						...base,
						button: 2,
					},
				),
				meta: shouldClearSelectionOnPageMouseDown(
					{
						...base,
						meta: true,
					},
				),
				alt: shouldClearSelectionOnPageMouseDown(
					{
						...base,
						alt: true,
					},
				),
				ctrl: shouldClearSelectionOnPageMouseDown(
					{
						...base,
						ctrl: true,
					},
				),
				shift: shouldClearSelectionOnPageMouseDown(
					{
						...base,
						shift: true,
					},
				),
				bullet: shouldClearSelectionOnPageMouseDown(
					{
						...base,
						onSelectedBullet: true,
					},
				),
			},
		).toStrictEqual(
			{
				plain: true,
				noSelection: false,
				right: false,
				meta: false,
				alt: false,
				ctrl: false,
				shift: false,
				bullet: false,
			},
		);
	});
});
