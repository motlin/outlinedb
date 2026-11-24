import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from "vite-plus/test";
import {readInternalMetadata, readPendingOutbox, storeInternalMetadata} from "@outlinedb/shared/cache";
import {calendarNodeId, WorkflowyInternalAdapter} from "@outlinedb/shared/internal";
import {callTool, openHarness, seed} from "./harness.js";
import type {Harness} from "./harness.js";

let harness: Harness;

beforeAll(() =>
{
	harness = openHarness("outlinedb-mcp-calendar-test-");
	const {cache} = harness;
	const insert = (id: string, name: string, parentId: string | null, calendar?: unknown) =>
	{
		seed(cache, id, name, parentId);
		if (calendar !== undefined)
		{
			storeInternalMetadata(
				harness.db,
				new Map([
					[
						id,
						{
							calendar,
						},
					],
				]),
			);
		}
	};
	insert(
		"cal",
		"📆 Calendar",
		null,
		{
			root: true,
			levels:
			{
				year: true,
				month: true,
				day: true,
			},
		},
	);
	insert(
		"y2026",
		"2026",
		"cal",
		{
			level: "year",
			value: "2026",
			timestamp: 0,
			dateId: 20_260_000,
		},
	);
	insert(
		"m01",
		"01",
		"y2026",
		{
			level: "month",
			value: "1",
			timestamp: 0,
			dateId: 20_260_100,
		},
	);
	insert("outer", '<time startYear="2026" startMonth="1" startDay="15">Thu, Jan 15, 2026</time>', "m01");
	insert(
		"d14",
		'<time startYear="2026" startMonth="1" startDay="14">Wed, Jan 14, 2026</time>',
		"m01",
		{
			level: "day",
			value: "14",
			timestamp: 0,
			dateId: 20_260_114,
		},
	);
	insert("kid", "Gym", "d14");
});

afterAll(() =>
{
	harness.restoreEnv();
});

describe("outlinedb_calendar_day", () =>
{
	afterEach(() =>
	{
		vi.restoreAllMocks();
	});

	it("finds a tagged day without calling ensure", async () =>
	{
		const ensure = vi.spyOn(WorkflowyInternalAdapter.prototype, "ensureCalendarDay");

		const result = await callTool(
			harness.store,
			"outlinedb_calendar_day",
			{
				date: "2026-01-14",
				ensure: true,
			},
		);

		expect(
			{
				result,
				calls: ensure.mock.calls,
			},
		).toStrictEqual(
			{
				result:
				{
					isError: undefined,
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									id: "d14",
									created: false,
									firstChildId: "kid",
								},
								null,
								2,
							),
						},
					],
				},
				calls: [],
			},
		);
	});

	it("ensures a missing day locally with the account's deterministic ids, without calling workflowy.com", async () =>
	{
		vi.spyOn(WorkflowyInternalAdapter.prototype, "getEntropyKey").mockResolvedValue("k");
		vi.spyOn(WorkflowyInternalAdapter.prototype, "getRootMeta").mockResolvedValue(undefined);
		vi.spyOn(WorkflowyInternalAdapter.prototype, "getSetting").mockResolvedValue(undefined);
		vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-0000000000c1");
		const ensure = vi.spyOn(WorkflowyInternalAdapter.prototype, "ensureCalendarDay");
		const month = calendarNodeId("k", "month", 20_261_000);
		const day = calendarNodeId("k", "day", 20_261_023);

		const result = await callTool(
			harness.authStore,
			"outlinedb_calendar_day",
			{
				date: "2026-10-23",
				ensure: true,
			},
		);

		expect(
			{
				result,
				pending: readPendingOutbox(harness.db, 100).map(({nodeId, aspect}) => `${nodeId} ${aspect}`),
				calls: ensure.mock.calls,
			},
		).toStrictEqual(
			{
				result:
				{
					isError: undefined,
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									id: day,
									created: true,
									firstChildId: "00000000-0000-4000-8000-0000000000c1",
								},
								null,
								2,
							),
						},
					],
				},
				// The month is placed under the year; the day and its empty child ride in the month's create.
				pending: [
					"00000000-0000-4000-8000-0000000000c1 create",
					`${day} create`,
					`${month} create`,
					`${month} placement`,
				],
				calls: [],
			},
		);
	});

	it("errors without internal auth and makes no call", async () =>
	{
		const ensure = vi.spyOn(WorkflowyInternalAdapter.prototype, "ensureCalendarDay");

		const result = await callTool(
			harness.store,
			"outlinedb_calendar_day",
			{
				date: "2026-10-22",
				ensure: true,
			},
		);

		expect(
			{
				result,
				calls: ensure.mock.calls,
			},
		).toStrictEqual(
			{
				result:
				{
					isError: true,
					content: [
						{
							type: "text",
							text: "Workflowy internal API is not configured (run './bin/run.js internal login')",
						},
					],
				},
				calls: [],
			},
		);
	});

	it("treats a name-only day as missing without ensure", async () =>
	{
		const result = await callTool(
			harness.store,
			"outlinedb_calendar_day",
			{
				date: "2026-01-15",
			},
		);

		expect(result).toStrictEqual(
			{
				isError: true,
				content: [
					{
						type: "text",
						text: "No 📆 Calendar day for 2026-01-15 (pass ensure: true)",
					},
				],
			},
		);
	});

	it("rejects a malformed date", async () =>
	{
		const result = await callTool(
			harness.store,
			"outlinedb_calendar_day",
			{
				date: "Jan 15",
			},
		);

		expect(result).toStrictEqual(
			{
				isError: true,
				content: [
					{
						type: "text",
						text: 'Invalid date "Jan 15". Use YYYY-MM-DD.',
					},
				],
			},
		);
	});
});

describe("outlinedb_node_create under a calendar month", () =>
{
	const name = '<time startYear="2026" startMonth="1" startDay="21">Wed, Jan 21, 2026</time>';

	afterEach(() =>
	{
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("tags the new row as that day locally, with no upstream call", async () =>
	{
		const fetch = vi
			.spyOn(globalThis, "fetch")
			.mockRejectedValue(new Error("unexpected fetch: a mirror-mode create called upstream"));

		const result = await callTool(
			harness.authStore,
			"outlinedb_node_create",
			{
				parentId: "m01",
				name,
			},
		);
		const {id} = JSON.parse(
			(
				result.content as
				{
					text: string;
				}[]
			)[0]?.text ?? "{}",
		) as
		{
			id: string;
		};

		expect(
			{
				isError: result.isError,
				calendar: readInternalMetadata(harness.db, [id]).get(id)?.calendar,
				fetches: fetch.mock.calls.length,
			},
		).toStrictEqual(
			{
				isError: undefined,
				calendar:
				{
					level: "day",
					value: "21",
					timestamp: new Date(2026, 0, 21).getTime(),
					dateId: 20_260_121,
				},
				fetches: 0,
			},
		);
	});
});
