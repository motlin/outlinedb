import {describe, expect, it} from "vite-plus/test";
import {escapeCaret} from "../src/client/hooks/use-color-popup.js";

describe("escapeCaret", () =>
{
	it("collapses the selection to its start", () =>
	{
		expect(
			escapeCaret(
				{
					start: 6,
					end: 11,
				},
			),
		).toStrictEqual(
			{
				start: 6,
				end: 6,
			},
		);
	});
});
