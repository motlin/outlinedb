import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {captureOutput} from "@oclif/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {calendarNodeId, WorkflowyInternalAdapter} from "@outlinedb/shared/internal";
import CalendarDay from "../../../src/commands/calendar/day.js";
import {cleanupTestDatabase, createTestDatabase} from "../../db/migration-helper.js";
import type {TestDatabase} from "../../db/migration-helper.js";
import {seedTaggedCalendar} from "../../helpers/calendar-fixture.js";
import {fakeUpstream, pendingOutbox} from "../../helpers/upstream-outbox.js";

const CHILD_ID = "00000000-0000-4000-8000-0000000000c9";

describe("calendar day command", () =>
{
	let originalEnv: typeof process.env;
	let tempDir: string;
	let testDatabase: TestDatabase;

	beforeEach(() =>
	{
		originalEnv =
		{
			...process.env,
		};
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "outlinedb-calendar-day-test-"));
		const testDbPath = path.join(tempDir, "test.sqlite");
		testDatabase = createTestDatabase(testDbPath);
		process.env.OUTLINEDB_DB_PATH = testDbPath;
		delete process.env.WORKFLOWY_USERNAME;
		delete process.env.WORKFLOWY_PASSWORD;
		delete process.env.OUTLINEDB_SESSION_FILE;
		process.env.WORKFLOWY_API_KEY = "test-api-key";
		seedTaggedCalendar(testDatabase);
	});

	afterEach(() =>
	{
		vi.restoreAllMocks();
		process.env = originalEnv;
		cleanupTestDatabase(testDatabase);
		fs.rmSync(
			tempDir,
			{
				recursive: true,
				force: true,
			},
		);
	});

	it("prints the tagged day's id and first child as JSON", async () =>
	{
		const {stdout} = await captureOutput(async () =>
		{
			await CalendarDay.run(["--date", "2026-10-05", "--json"]);
		});

		expect(JSON.parse(stdout)).toStrictEqual(
			{
				id: "d1005",
				created: false,
				firstChildId: "c1",
			},
		);
	});

	it("exits 1 for a name-only day, which workflowy.com does not see either", async () =>
	{
		const {error} = await captureOutput(async () =>
		{
			await CalendarDay.run(["--date", "2026-10-06"]);
		});

		expect(
			{
				message: error?.message,
				code: (
					error as
						|
						  {
								oclif?:
								{
									exit?: number;
								};
						  }
						| undefined
				)?.oclif?.exit,
			},
		).toStrictEqual(
			{
				message: "No 📆 Calendar day for 2026-10-06 (use --ensure)",
				code: 1,
			},
		);
	});

	it("prints the short id in text mode", async () =>
	{
		const {stdout} = await captureOutput(async () =>
		{
			await CalendarDay.run(["--date", "2026-10-05"]);
		});

		expect(stdout).toBe("d1005\n");
	});

	it("never calls ensure for a day that already exists", async () =>
	{
		const ensure = vi.spyOn(WorkflowyInternalAdapter.prototype, "ensureCalendarDay");
		process.env.WORKFLOWY_USERNAME = "alice@example.com";
		process.env.WORKFLOWY_PASSWORD = "secret";

		await captureOutput(async () =>
		{
			await CalendarDay.run(["--date", "2026-10-05", "--ensure"]);
		});

		expect(ensure.mock.calls).toStrictEqual([]);
	});

	it("ensures a missing day locally with the account's deterministic ids and a child, delivers it, and prints the result", async () =>
	{
		const upstream = fakeUpstream(vi.spyOn(globalThis, "fetch"), testDatabase, tempDir);
		vi.spyOn(WorkflowyInternalAdapter.prototype, "getEntropyKey").mockResolvedValue("k");
		vi.spyOn(WorkflowyInternalAdapter.prototype, "getRootMeta").mockResolvedValue(undefined);
		vi.spyOn(crypto, "randomUUID").mockReturnValue(CHILD_ID);
		const ensure = vi.spyOn(WorkflowyInternalAdapter.prototype, "ensureCalendarDay");
		const day = calendarNodeId("k", "day", 20_261_022);

		const {stdout} = await captureOutput(async () =>
		{
			await CalendarDay.run(["--date", "2026-10-22", "--ensure", "--json"]);
		});

		expect(
			{
				out: JSON.parse(stdout),
				pushed: upstream.pushes.map((ops) => ops.map(({type, data}) => `${type} ${String(data.parentid)}`)),
				pending: pendingOutbox(testDatabase),
				calls: ensure.mock.calls,
			},
		).toStrictEqual(
			{
				out:
				{
					id: day,
					created: true,
					firstChildId: CHILD_ID,
				},
				// The day under its month, then its empty first child under it.
				pushed: [["bulk_create m10", `bulk_create ${day}`]],
				pending: [],
				calls: [],
			},
		);
	});

	it("honours --no-child and --level", async () =>
	{
		fakeUpstream(vi.spyOn(globalThis, "fetch"), testDatabase, tempDir);
		vi.spyOn(WorkflowyInternalAdapter.prototype, "getEntropyKey").mockResolvedValue("k");
		vi.spyOn(WorkflowyInternalAdapter.prototype, "getRootMeta").mockResolvedValue(undefined);

		const {stdout} = await captureOutput(async () =>
		{
			await CalendarDay.run(["--date", "2026-11-01", "--ensure", "--no-child", "--level", "month", "--json"]);
		});

		expect(JSON.parse(stdout)).toStrictEqual(
			{
				id: calendarNodeId("k", "month", 20_261_100),
				created: true,
				firstChildId: null,
			},
		);
	});

	it("errors before any write when --ensure has no internal auth", async () =>
	{
		const ensure = vi.spyOn(WorkflowyInternalAdapter.prototype, "ensureCalendarDay");
		process.env.OUTLINEDB_SESSION_FILE = path.join(tempDir, "no-session.json");

		const {error} = await captureOutput(async () =>
		{
			await CalendarDay.run(["--date", "2026-10-22", "--ensure"]);
		});

		expect(
			{
				message: error?.message,
				calls: ensure.mock.calls,
			},
		).toStrictEqual(
			{
				message:
					"--ensure needs the internal API: set WORKFLOWY_USERNAME and WORKFLOWY_PASSWORD in the environment (e.g. from .envrc)",
				calls: [],
			},
		);
	});
});
