import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {captureOutput} from "@oclif/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {WorkflowyInternalAdapter} from "@outlinedb/shared/internal";
import CalendarBackfillMetadata from "../../../src/commands/calendar/backfill-metadata.js";
import {cleanupTestDatabase, createTestDatabase} from "../../db/migration-helper.js";
import type {TestDatabase} from "../../db/migration-helper.js";

describe("calendar backfill-metadata command", () => {
	let originalEnv: typeof process.env;
	let tempDir: string;
	let testDatabase: TestDatabase;

	beforeEach(() => {
		originalEnv = {...process.env};
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflowy-calendar-backfill-test-"));
		const testDbPath = path.join(tempDir, "test.sqlite");
		testDatabase = createTestDatabase(testDbPath);
		process.env.WORKFLOWY_DB_PATH = testDbPath;
		delete process.env.WORKFLOWY_USERNAME;
		delete process.env.WORKFLOWY_PASSWORD;
		delete process.env.WORKFLOWY_SESSION_FILE;
		process.env.WORKFLOWY_API_KEY = "test-api-key";
	});

	afterEach(() => {
		vi.restoreAllMocks();
		process.env = originalEnv;
		cleanupTestDatabase(testDatabase);
		fs.rmSync(tempDir, {recursive: true, force: true});
	});

	it("runs the flag-gated backfills and prints what gained a timestamp or dateId as JSON", async () => {
		const backfill = vi
			.spyOn(WorkflowyInternalAdapter.prototype, "backfillCalendarMetadata")
			.mockResolvedValue({timestamps: ["d"], dateIds: ["m", "d"]});
		process.env.WORKFLOWY_USERNAME = "alice@example.com";
		process.env.WORKFLOWY_PASSWORD = "secret";

		const {stdout} = await captureOutput(async () => {
			await CalendarBackfillMetadata.run(["--json"]);
		});

		expect({calls: backfill.mock.calls, out: JSON.parse(stdout)}).toStrictEqual({
			calls: [[{force: false}]],
			out: {timestamps: ["d"], dateIds: ["m", "d"]},
		});
	});

	it("passes --force through and prints counts in text mode", async () => {
		const backfill = vi
			.spyOn(WorkflowyInternalAdapter.prototype, "backfillCalendarMetadata")
			.mockResolvedValue({timestamps: [], dateIds: ["m"]});
		process.env.WORKFLOWY_USERNAME = "alice@example.com";
		process.env.WORKFLOWY_PASSWORD = "secret";

		const {stdout} = await captureOutput(async () => {
			await CalendarBackfillMetadata.run(["--force"]);
		});

		expect({calls: backfill.mock.calls, stdout}).toStrictEqual({
			calls: [[{force: true}]],
			stdout: "Added calendar.timestamp to 0 nodes and calendar.dateId to 1 node\n",
		});
	});

	it("errors before any write without internal auth", async () => {
		const backfill = vi.spyOn(WorkflowyInternalAdapter.prototype, "backfillCalendarMetadata");
		process.env.WORKFLOWY_SESSION_FILE = path.join(tempDir, "no-session.json");

		const {error} = await captureOutput(async () => {
			await CalendarBackfillMetadata.run([]);
		});

		expect({message: error?.message, calls: backfill.mock.calls}).toStrictEqual({
			message:
				"calendar backfill-metadata needs the internal API: set WORKFLOWY_USERNAME and WORKFLOWY_PASSWORD in the environment (e.g. from .envrc)",
			calls: [],
		});
	});
});
