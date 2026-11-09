import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {captureOutput} from "@oclif/test";
import {storeInternalMetadata} from "@outlinedb/shared/cache";
import {WorkflowyInternalAdapter} from "@outlinedb/shared/internal";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import CalendarAudit from "../../../src/commands/calendar/audit.js";
import {cleanupTestDatabase, createTestDatabase, nodeFixtures, seedTestData} from "../../db/migration-helper.js";
import type {TestDatabase} from "../../db/migration-helper.js";
import {createTestNode} from "../../helpers/node-fixtures.js";

const JAN15 = '<time startYear="2026" startMonth="1" startDay="15">Thu, Jan 15, 2026</time>';
const jan15Tag = {level: "day", value: "15", timestamp: new Date(2026, 0, 15).getTime(), dateId: 20_260_115};

describe("calendar audit command", () => {
	let originalEnv: typeof process.env;
	let tempDir: string;
	let testDatabase: TestDatabase;

	beforeEach(() => {
		originalEnv = {...process.env};
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflowy-calendar-audit-test-"));
		const testDbPath = path.join(tempDir, "test.sqlite");
		testDatabase = createTestDatabase(testDbPath);
		process.env.OUTLINEDB_DB_PATH = testDbPath;
		process.env.WORKFLOWY_API_KEY = "test-api-key";
		process.env.WORKFLOWY_USERNAME = "alice@example.com";
		process.env.WORKFLOWY_PASSWORD = "secret";
		process.env.OUTLINEDB_SESSION_FILE = path.join(tempDir, "session");
	});

	afterEach(() => {
		vi.restoreAllMocks();
		process.env = originalEnv;
		cleanupTestDatabase(testDatabase);
		fs.rmSync(tempDir, {recursive: true, force: true});
	});

	/** Mirrors the live 2026-01-15 case: an untagged day under month 01 whose only child is the tagged day. */
	function seedJan15Case(): void {
		seedTestData(testDatabase, {
			...nodeFixtures([
				createTestNode({id: "cal", name: "📆 Calendar", parentId: null}),
				createTestNode({id: "y2026", name: "2026", parentId: "cal"}),
				createTestNode({id: "m01", name: "01", parentId: "y2026"}),
				createTestNode({id: "outer", name: JAN15, parentId: "m01"}),
				createTestNode({id: "inner", name: JAN15, parentId: "outer"}),
			]),
		});
		const metadata: [string, Record<string, unknown>][] = [
			["cal", {calendar: {root: true, levels: {year: true, month: true, day: true}}}],
			["y2026", {calendar: {level: "year", value: "2026", timestamp: 0, dateId: 20_260_000}}],
			["m01", {calendar: {level: "month", value: "1", timestamp: 0, dateId: 20_260_100}}],
			["inner", {calendar: jan15Tag}],
		];
		storeInternalMetadata(testDatabase.db, new Map(metadata));
	}

	it("reports the untagged day and its nested tagged child", async () => {
		seedJan15Case();

		const {stdout} = await captureOutput(async () => {
			await CalendarAudit.run(["--json"]);
		});

		expect(JSON.parse(stdout)).toStrictEqual([
			{kind: "untagged-day", id: "outer", dateId: 20_260_115},
			{kind: "nested-day", id: "inner", dateId: 20_260_115},
		]);
	});

	it("--fix adopts the untagged day only", async () => {
		seedJan15Case();
		const setMeta = vi.spyOn(WorkflowyInternalAdapter.prototype, "setNodeMetaValues").mockResolvedValue();

		await captureOutput(async () => {
			await CalendarAudit.run(["--json", "--fix"]);
		});

		expect(setMeta.mock.calls).toStrictEqual([["outer", [{path: ["calendar"], value: jan15Tag}]]]);
	});

	it("audits the root given by --root-id", async () => {
		seedJan15Case();

		const {stdout} = await captureOutput(async () => {
			await CalendarAudit.run(["--json", "--root-id", "cal"]);
		});

		expect(JSON.parse(stdout)).toHaveLength(2);
	});

	it("prints [] for a clean calendar", async () => {
		seedTestData(testDatabase, nodeFixtures([createTestNode({id: "cal", name: "📆 Calendar", parentId: null})]));
		storeInternalMetadata(testDatabase.db, new Map([["cal", {calendar: {root: true}}]]));

		const {stdout} = await captureOutput(async () => {
			await CalendarAudit.run(["--json"]);
		});

		expect(stdout).toBe("[]\n");
	});
});
