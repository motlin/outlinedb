import {describe, expect, it} from "vite-plus/test";
import {applyDatePick} from "../src/client/date-pick.js";

function run(opened: Parameters<typeof applyDatePick>[0], dates: Date[])
{
	const log: string[] = [];
	applyDatePick(
		opened,
		dates,
		{
			insert: (attrs) =>
			{
				log.push(`insert ${JSON.stringify(attrs)}`);
			},
			cancel: (offset) =>
			{
				log.push(`cancel ${offset}`);
			},
		},
	);
	return log;
}

describe("applyDatePick", () =>
{
	const base =
	{
		offset: 7,
	};

	it("calls onSelect once with the dates and inserts nothing", () =>
	{
		const picked: Date[][] = [];
		const dates = [new Date(2026, 9, 24, 12)];
		const log = run(
			{
				...base,
				onSelect: (d) =>
				{
					picked.push(d);
				},
			},
			dates,
		);
		expect(
			{
				log,
				picked,
			},
		).toStrictEqual(
			{
				log: [],
				picked: [dates],
			},
		);
	});

	it("cancels at the end of the name when an onSelect pick is empty", () =>
	{
		const picked: Date[][] = [];
		const log = run(
			{
				...base,
				onSelect: (d) =>
				{
					picked.push(d);
				},
			},
			[],
		);
		expect(
			{
				log,
				picked,
			},
		).toStrictEqual(
			{
				log: ["cancel 7"],
				picked: [],
			},
		);
	});

	it("inserts a pill without onSelect", () =>
	{
		const log = run(base, [new Date(2026, 9, 24, 12)]);
		expect(log).toHaveLength(1);
		expect(log[0]).toMatch(/^insert /u);
	});
});
