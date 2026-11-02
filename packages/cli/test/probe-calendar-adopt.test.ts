import {describe, expect, it} from "vite-plus/test";
import Probe, {planCalendarAdoptProbe} from "../src/commands/internal/probe.js";

const ROOT = "calendar-root";
const ENSURED =
{
	dateId: 20_991_231,
	dayId: "day",
	firstChildId: "child",
	created: ["year", "month", "day", "child"],
};
const ANCESTORS: Record<string, string[]> =
{
	year: [ROOT, "home"],
	month: ["year", ROOT, "home"],
	day: ["month", "year", ROOT, "home"],
	child: ["day", "month", "year", ROOT, "home"],
	stray: ["elsewhere", "home"],
};
const ancestorsOf = (id: string): string[] => ANCESTORS[id] ?? [];

describe("planCalendarAdoptProbe", () =>
{
	it("deletes the topmost created node when every created node is under the calendar root", () =>
	{
		expect(planCalendarAdoptProbe(ENSURED, ROOT, ancestorsOf)).toStrictEqual(
			{
				deleteId: "year",
			},
		);
	});

	it("deletes the topmost created node when the year already existed", () =>
	{
		const ensured =
		{
			...ENSURED,
			created: ["month", "day", "child"],
		};

		expect(planCalendarAdoptProbe(ensured, ROOT, ancestorsOf)).toStrictEqual(
			{
				deleteId: "month",
			},
		);
	});

	it("refuses a day before 2099", () =>
	{
		expect(() =>
			planCalendarAdoptProbe(
				{
					...ENSURED,
					dateId: 20_261_018,
				},
				ROOT,
				ancestorsOf,
			),
		).toThrow("Refusing to probe 20261018: the calendar-adopt probe only touches days from 20990101 on");
	});

	it("refuses a created node outside the calendar root", () =>
	{
		const ensured =
		{
			...ENSURED,
			created: ["year", "stray"],
		};

		expect(() => planCalendarAdoptProbe(ensured, ROOT, ancestorsOf)).toThrow(
			"Refusing to continue: created node stray is not under the calendar root calendar-root",
		);
	});

	it("refuses when ensure created nothing", () =>
	{
		const ensured =
		{
			...ENSURED,
			created: [],
		};

		expect(() => planCalendarAdoptProbe(ensured, ROOT, ancestorsOf)).toThrow(
			"Refusing to continue: ensure created nothing, so 20991231 already existed",
		);
	});
});

describe("internal probe calendar-adopt", () =>
{
	it("refuses to run without --yes-live", async () =>
	{
		await expect(Probe.run(["calendar-adopt"])).rejects.toThrow(
			"Live probe against workflowy.com: pass --yes-live to run it",
		);
	});
});
