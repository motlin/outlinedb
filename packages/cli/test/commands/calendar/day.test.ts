import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {captureOutput} from "@oclif/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {WorkflowyInternalAdapter} from "@outlinedb/shared/internal";
import CalendarDay from "../../../src/commands/calendar/day.js";
import {cleanupTestDatabase, createTestDatabase} from "../../db/migration-helper.js";
import type {TestDatabase} from "../../db/migration-helper.js";
import {seedTaggedCalendar} from "../../helpers/calendar-fixture.js";

describe("calendar day command", () => {
	let originalEnv: typeof process.env;
	let tempDir: string;
	let testDatabase: TestDatabase;

	beforeEach(() => {
		originalEnv = {...process.env};
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflowy-calendar-day-test-"));
		const testDbPath = path.join(tempDir, "test.sqlite");
		testDatabase = createTestDatabase(testDbPath);
		process.env.OUTLINEDB_DB_PATH = testDbPath;
		delete process.env.WORKFLOWY_USERNAME;
		delete process.env.WORKFLOWY_PASSWORD;
		delete process.env.OUTLINEDB_SESSION_FILE;
		process.env.WORKFLOWY_API_KEY = "test-api-key";
		seedTaggedCalendar(testDatabase);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		process.env = originalEnv;
		cleanupTestDatabase(testDatabase);
		fs.rmSync(tempDir, {recursive: true, force: true});
	});

	it("prints the tagged day's id and first child as JSON", async () => {
		const {stdout} = await captureOutput(async () => {
			await CalendarDay.run(["--date", "2026-10-05", "--json"]);
		});

		expect(JSON.parse(stdout)).toStrictEqual({id: "d1005", created: false, firstChildId: "c1"});
	});

	it("exits 1 for a name-only day, which workflowy.com does not see either", async () => {
		const {error} = await captureOutput(async () => {
			await CalendarDay.run(["--date", "2026-10-06"]);
		});

		expect({
			message: error?.message,
			code: (error as {oclif?: {exit?: number}} | undefined)?.oclif?.exit,
		}).toStrictEqual({
			message: "No 📆 Calendar day for 2026-10-06 (use --ensure)",
			code: 1,
		});
	});

	it("prints the short id in text mode", async () => {
		const {stdout} = await captureOutput(async () => {
			await CalendarDay.run(["--date", "2026-10-05"]);
		});

		expect(stdout).toBe("d1005\n");
	});

	it("never calls ensure for a day that already exists", async () => {
		const ensure = vi.spyOn(WorkflowyInternalAdapter.prototype, "ensureCalendarDay");
		process.env.WORKFLOWY_USERNAME = "alice@example.com";
		process.env.WORKFLOWY_PASSWORD = "secret";

		await captureOutput(async () => {
			await CalendarDay.run(["--date", "2026-10-05", "--ensure"]);
		});

		expect(ensure.mock.calls).toStrictEqual([]);
	});

	it("ensures a missing day once with the day level and a child, and prints the result", async () => {
		const ensure = vi
			.spyOn(WorkflowyInternalAdapter.prototype, "ensureCalendarDay")
			.mockResolvedValue({dayId: "v5day", firstChildId: "kid", created: ["v5day", "kid"]});
		process.env.WORKFLOWY_USERNAME = "alice@example.com";
		process.env.WORKFLOWY_PASSWORD = "secret";

		const {stdout} = await captureOutput(async () => {
			await CalendarDay.run(["--date", "2026-10-22", "--ensure", "--json"]);
		});

		expect({calls: ensure.mock.calls, out: JSON.parse(stdout)}).toStrictEqual({
			calls: [[20_261_022, {stopAt: "day", createChild: true}]],
			out: {id: "v5day", created: true, firstChildId: "kid"},
		});
	});

	it("passes --no-child and --level through to ensure", async () => {
		const ensure = vi
			.spyOn(WorkflowyInternalAdapter.prototype, "ensureCalendarDay")
			.mockResolvedValue({dayId: "m11", firstChildId: null, created: ["m11"]});
		process.env.WORKFLOWY_USERNAME = "alice@example.com";
		process.env.WORKFLOWY_PASSWORD = "secret";

		await captureOutput(async () => {
			await CalendarDay.run(["--date", "2026-11-01", "--ensure", "--no-child", "--level", "month"]);
		});

		expect(ensure.mock.calls).toStrictEqual([[20_261_101, {stopAt: "month", createChild: false}]]);
	});

	it("errors before any write when --ensure has no internal auth", async () => {
		const ensure = vi.spyOn(WorkflowyInternalAdapter.prototype, "ensureCalendarDay");
		process.env.OUTLINEDB_SESSION_FILE = path.join(tempDir, "no-session.json");

		const {error} = await captureOutput(async () => {
			await CalendarDay.run(["--date", "2026-10-22", "--ensure"]);
		});

		expect({message: error?.message, calls: ensure.mock.calls}).toStrictEqual({
			message:
				"--ensure needs the internal API: set WORKFLOWY_USERNAME and WORKFLOWY_PASSWORD in the environment (e.g. from .envrc)",
			calls: [],
		});
	});
});
