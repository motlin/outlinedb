import {expect, describe, it} from "vite-plus/test";
import {formatDuration} from "../../src/utils/format-duration.js";

describe("formatDuration", () =>
{
	it("formats seconds", () =>
	{
		expect(formatDuration(1)).toBe("1 second ago");
		expect(formatDuration(30)).toBe("30 seconds ago");
		expect(formatDuration(59)).toBe("59 seconds ago");
	});

	it("formats minutes", () =>
	{
		expect(formatDuration(60)).toBe("1 minute ago");
		expect(formatDuration(90)).toBe("1 minute ago");
		expect(formatDuration(120)).toBe("2 minutes ago");
		expect(formatDuration(3599)).toBe("59 minutes ago");
	});

	it("formats hours", () =>
	{
		expect(formatDuration(3600)).toBe("1 hour ago");
		expect(formatDuration(5400)).toBe("1 hour ago");
		expect(formatDuration(7200)).toBe("2 hours ago");
		expect(formatDuration(86_399)).toBe("23 hours ago");
	});

	it("formats days", () =>
	{
		expect(formatDuration(86_400)).toBe("1 day ago");
		expect(formatDuration(129_600)).toBe("1 day ago");
		expect(formatDuration(172_800)).toBe("2 days ago");
		expect(formatDuration(604_800)).toBe("7 days ago");
	});
});
