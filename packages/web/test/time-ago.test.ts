import {describe, expect, it} from "vite-plus/test";
import {autosaveText, timeAgo} from "../src/client/time-ago.js";

describe("timeAgo ports upstream GV2", () =>
{
	it("formats elapsed milliseconds", () =>
	{
		expect(
			[-5, 0, 59_999, 60_000, 120_000, 3_600_000, 7_200_000, 86_400_000, 86_400_000 * 2].map(timeAgo),
		).toStrictEqual([
			"just now",
			"just now",
			"just now",
			"1 minute ago",
			"2 minutes ago",
			"1 hour ago",
			"2 hours ago",
			"1 day ago",
			"2 days ago",
		]);
	});
});

describe("autosaveText matches upstream's KY status", () =>
{
	it("reads Saving... while writes are in flight, else Autosaved with a capitalized age", () =>
	{
		expect([
			autosaveText(
				{
					saving: true,
					lastSavedAt: 0,
					now: 0,
				},
			),
			autosaveText(
				{
					saving: false,
					lastSavedAt: 0,
					now: 0,
				},
			),
			autosaveText(
				{
					saving: false,
					lastSavedAt: 0,
					now: 180_000,
				},
			),
		]).toStrictEqual(["Saving...", "Autosaved: Just now", "Autosaved: 3 minutes ago"]);
	});
});
