import {beforeEach, describe, expect, it, vi} from "vite-plus/test";
import * as latestColor from "../src/client/latest-color.js";
import type {ColorChoice} from "../src/client/rich-text.js";

describe("latest color store", () =>
{
	beforeEach(() =>
	{
		latestColor.resetLatestColorForTests();
	});

	it("starts empty", () =>
	{
		expect([latestColor.get(), latestColor.swatchClass()]).toStrictEqual([undefined, ""]);
	});

	it("names the swatch class after the latest kind and color", () =>
	{
		latestColor.change("highlight", "yellow");
		expect(latestColor.swatchClass()).toBe("bc-yellow");
		latestColor.change("text", "red");
		expect(latestColor.swatchClass()).toBe("c-red");
	});

	it("adopts the account's latest color without writing it back", () =>
	{
		const persist = vi.fn<(choice: ColorChoice) => Promise<void>>(async () => Promise.resolve());
		latestColor.setLatestColorPersister(persist);
		latestColor.adopt(
			{
				kind: "highlight",
				color: "yellow",
			},
		);
		const adopted = [latestColor.get(), latestColor.swatchClass()];
		latestColor.adopt(null);
		expect(
			{
				adopted,
				cleared: latestColor.get(),
				writes: persist.mock.calls,
			},
		).toStrictEqual(
			{
				adopted: [
					{
						kind: "highlight",
						color: "yellow",
					},
					"bc-yellow",
				],
				cleared: undefined,
				writes: [],
			},
		);
	});

	it("writes a picked color to the account, but not a removal", () =>
	{
		const persist = vi.fn<(choice: ColorChoice) => Promise<void>>(async () => Promise.resolve());
		latestColor.setLatestColorPersister(persist);
		latestColor.change("text", "red");
		latestColor.change("text", null);
		expect(persist.mock.calls).toStrictEqual([
			[
				{
					kind: "text",
					color: "red",
				},
			],
		]);
	});

	it("removes the color once after a null change, keeping the latest", () =>
	{
		latestColor.change("highlight", "yellow");
		latestColor.change("text", null);
		const html = 'a <span class="colored bc-yellow">bc</span> d';
		expect([
			latestColor.get(),
			latestColor.planApply(html, 2, 4),
			latestColor.planApply("a bc d", 2, 4),
		]).toStrictEqual([
			{
				kind: "highlight",
				color: "yellow",
			},
			"a bc d",
			'a <span class="colored bc-yellow">bc</span> d',
		]);
	});

	it("toggles the latest color on a selection and back, keeping other formats", () =>
	{
		latestColor.change("highlight", "yellow");
		const once = latestColor.planApply("TFT <b>text</b>", 4, 8);
		expect([once, latestColor.planApply(once, 4, 8)]).toStrictEqual([
			'TFT <span class="colored bc-yellow"><b>text</b></span>',
			"TFT <b>text</b>",
		]);
	});

	it("leaves the html alone when nothing was picked", () =>
	{
		expect(latestColor.planApply("a bc d", 2, 4)).toBe("a bc d");
	});

	it("keeps the picked color when the account write fails", async () =>
	{
		const persist = vi.fn<(choice: ColorChoice) => Promise<void>>(async () => Promise.reject(new Error("503")));
		latestColor.setLatestColorPersister(persist);
		latestColor.change("text", "blue");
		await Promise.resolve();
		expect([latestColor.swatchClass(), persist.mock.calls.length]).toStrictEqual(["c-blue", 1]);
	});
});
