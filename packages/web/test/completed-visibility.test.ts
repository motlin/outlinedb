import {describe, expect, it} from "vite-plus/test";
import {selectCompletedVisibility} from "../src/client/completed-visibility.js";

describe("selectCompletedVisibility", () =>
{
	it("derives shown, userShown and forced from the preference and the committed query", () =>
	{
		const cases = [
			{
				showCompleted: false,
				searchQuery: "",
			},
			{
				showCompleted: false,
				searchQuery: "is:complete",
			},
			{
				showCompleted: false,
				searchQuery: "rc",
			},
			{
				showCompleted: false,
				searchQuery: "-is:complete",
			},
			{
				showCompleted: true,
				searchQuery: "rc",
			},
		];
		expect(cases.map((state) => selectCompletedVisibility(state))).toStrictEqual([
			{
				shown: false,
				userShown: false,
				forced: false,
			},
			{
				shown: true,
				userShown: false,
				forced: true,
			},
			{
				shown: false,
				userShown: false,
				forced: false,
			},
			{
				shown: true,
				userShown: false,
				forced: true,
			},
			{
				shown: true,
				userShown: true,
				forced: false,
			},
		]);
	});
});
