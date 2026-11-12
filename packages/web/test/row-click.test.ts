import {describe, expect, it} from "vite-plus/test";
import {rowClickResumesEditing} from "../src/client/components/row-click.js";

function element(matches: string[])
{
	return {
		closest: (selector: string) => (matches.includes(selector) ? {} : null),
	};
}

const inside = element([]);
const row =
{
	contains: (other: unknown) => other !== outside && other !== portaled,
};
const outside = element([]);
const portaled = element([]);

describe("rowClickResumesEditing", () =>
{
	it("resumes editing for a plain click on the row", () =>
	{
		expect(rowClickResumesEditing(inside, row)).toBe(true);
	});

	it("ignores clicks inside the editor, the item-menu trigger, or a portaled flyout", () =>
	{
		expect([
			rowClickResumesEditing(element(["[contenteditable]"]), row),
			rowClickResumesEditing(element([".itemMenu"]), row),
			rowClickResumesEditing(portaled, row),
			rowClickResumesEditing(null, row),
		]).toStrictEqual([false, false, false, false]);
	});
});
