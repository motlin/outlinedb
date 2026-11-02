import {expect, describe, it} from "vite-plus/test";
import {localLookbackCutoff} from "../../src/utils/local-date.js";

describe("localLookbackCutoff", () =>
{
	it("counts back from the local date late in the evening", () =>
	{
		expect(localLookbackCutoff(new Date(2026, 10, 3, 23, 30), 7)).toBe("2026-10-27");
	});

	it("counts back from the local date just after midnight", () =>
	{
		expect(localLookbackCutoff(new Date(2026, 10, 3, 0, 30), 7)).toBe("2026-10-27");
	});

	it("counts calendar days across a DST change", () =>
	{
		expect(localLookbackCutoff(new Date(2026, 2, 9, 0, 30), 1)).toBe("2026-03-08");
	});
});
