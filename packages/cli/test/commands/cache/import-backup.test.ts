import {afterEach, beforeEach, describe, expect, it} from "vite-plus/test";
import {runUnitOfWork, seedAccount} from "@outlinedb/shared/cache";
import {backupImports, nodeContent} from "@outlinedb/shared/db";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import {captureOutput} from "@oclif/test";
import {asc} from "drizzle-orm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ImportBackup from "../../../src/commands/cache/import-backup.js";
import ImportBackups from "../../../src/commands/cache/import-backups.js";
import {cleanupTestDatabase, createTestDatabase} from "../../db/migration-helper.js";
import type {TestDatabase} from "../../db/migration-helper.js";

// Backup timestamps are seconds after the account's epoch: 2024-01-01T00:00:00Z here.
const EPOCH = "1704067200";

describe("cache:import-backup --backup-system-time", () => {
	let tempDir: string;
	let backupsDir: string;
	let testDatabase: TestDatabase;
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflowy-import-backup-test-"));
		backupsDir = path.join(tempDir, "backups");
		fs.mkdirSync(path.join(backupsDir, "Data"), {recursive: true});
		const testDbPath = path.join(tempDir, "test.sqlite");
		testDatabase = createTestDatabase(testDbPath);

		for (const key of ["WORKFLOWY_DB_PATH", "WORKFLOWY_EPOCH", "WORKFLOWY_BACKUPS_DIR"]) {
			savedEnv[key] = process.env[key];
		}
		process.env.WORKFLOWY_DB_PATH = testDbPath;
		process.env.WORKFLOWY_EPOCH = EPOCH;
		process.env.WORKFLOWY_BACKUPS_DIR = backupsDir;
	});

	afterEach(() => {
		cleanupTestDatabase(testDatabase);
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) {
				Reflect.deleteProperty(process.env, key);
			} else {
				process.env[key] = value;
			}
		}
		fs.rmSync(tempDir, {recursive: true, force: true});
	});

	function writeBackup(date: string, content: unknown): string {
		const filePath = path.join(backupsDir, "Data", `(alice@example.com).${date}.workflowy.backup`);
		fs.writeFileSync(filePath, JSON.stringify(content));
		return filePath;
	}

	async function importWithBackupTime(filePath: string): Promise<void> {
		await captureOutput(async () =>
			ImportBackup.run(["--file", filePath, "--yes", "--no-embeddings", "--backup-system-time"]),
		);
	}

	function contentStamps(): {id: string; systemFrom: string; systemTo: string}[] {
		return testDatabase.db
			.select({id: nodeContent.id, systemFrom: nodeContent.systemFrom, systemTo: nodeContent.systemTo})
			.from(nodeContent)
			.orderBy(asc(nodeContent.id), asc(nodeContent.systemFrom))
			.all();
	}

	function importStamps(): {filename: string; backupDate: string; systemFrom: string; systemTo: string}[] {
		return testDatabase.db.select().from(backupImports).orderBy(asc(backupImports.systemFrom)).all();
	}

	it("stamps node rows and the backup_imports row with the backup's latest change time", async () => {
		const filePath = writeBackup("2024-01-02", [
			{id: "node-1", nm: "One", ct: 3600, lm: 7200},
			{id: "node-2", nm: "Two", ct: 3600, lm: 90_000, cp: 86_400},
		]);

		await importWithBackupTime(filePath);

		expect(contentStamps()).toStrictEqual([
			{id: "node-1", systemFrom: "2024-01-02 01:00:00.000", systemTo: FAR_FUTURE_DATE},
			{id: "node-2", systemFrom: "2024-01-02 01:00:00.000", systemTo: FAR_FUTURE_DATE},
		]);
		expect(importStamps()).toStrictEqual([
			{
				filename: "(alice@example.com).2024-01-02.workflowy.backup",
				backupDate: "2024-01-02",
				systemFrom: "2024-01-02 01:00:00.000",
				systemTo: FAR_FUTURE_DATE,
			},
		]);
	});

	it("reads the epoch from the account row's join date when WORKFLOWY_EPOCH is unset", async () => {
		Reflect.deleteProperty(process.env, "WORKFLOWY_EPOCH");
		runUnitOfWork(testDatabase.db, (unitOfWork) => {
			seedAccount(unitOfWork, {userId: 107, dateJoinedSec: Number(EPOCH)});
		});
		const filePath = writeBackup("2024-01-02", [{id: "node-1", nm: "One", ct: 3600, lm: 7200}]);

		await importWithBackupTime(filePath);

		expect(contentStamps()).toStrictEqual([
			{id: "node-1", systemFrom: "2024-01-01 02:00:00.000", systemTo: FAR_FUTURE_DATE},
		]);
	});

	it("falls back to noon UTC on the filename date when the backup carries no timestamps", async () => {
		const filePath = writeBackup("2024-01-05", [{id: "node-1", nm: "One"}]);

		await importWithBackupTime(filePath);

		expect(contentStamps()).toStrictEqual([
			{id: "node-1", systemFrom: "2024-01-05 12:00:00.000", systemTo: FAR_FUTURE_DATE},
		]);
		expect(importStamps()).toStrictEqual([
			{
				filename: "(alice@example.com).2024-01-05.workflowy.backup",
				backupDate: "2024-01-05",
				systemFrom: "2024-01-05 12:00:00.000",
				systemTo: FAR_FUTURE_DATE,
			},
		]);
	});

	it("stamps a backup whose newest change does not postdate the previous import one millisecond after it", async () => {
		// The second backup only deletes an older node, so its newest timestamp equals the first import's stamp.
		writeBackup("2024-01-02", [
			{id: "node-1", nm: "One", ct: 3600, lm: 7200},
			{id: "node-2", nm: "Two", ct: 3600, lm: 3600},
		]);
		writeBackup("2024-01-03", [{id: "node-1", nm: "One", ct: 3600, lm: 7200}]);

		await captureOutput(async () =>
			ImportBackups.run(["--no-download", "--no-archive", "--no-embeddings", "--backup-system-time"]),
		);

		expect(contentStamps()).toStrictEqual([
			{id: "node-1", systemFrom: "2024-01-01 02:00:00.000", systemTo: FAR_FUTURE_DATE},
			{id: "node-2", systemFrom: "2024-01-01 02:00:00.000", systemTo: "2024-01-01 02:00:00.001"},
		]);
		expect(importStamps()).toStrictEqual([
			{
				filename: "(alice@example.com).2024-01-02.workflowy.backup",
				backupDate: "2024-01-02",
				systemFrom: "2024-01-01 02:00:00.000",
				systemTo: FAR_FUTURE_DATE,
			},
			{
				filename: "(alice@example.com).2024-01-03.workflowy.backup",
				backupDate: "2024-01-03",
				systemFrom: "2024-01-01 02:00:00.001",
				systemTo: FAR_FUTURE_DATE,
			},
		]);
	});
	it("passes --force through to each import, so a snapshot older than a cached node still tombstones what it omits", async () => {
		// node-2 changed after the second backup's newest change, so only --force lets that backup end it.
		writeBackup("2024-01-02", [
			{id: "node-1", nm: "One", ct: 3600, lm: 3600},
			{id: "node-2", nm: "Two", ct: 3600, lm: 7200},
		]);
		writeBackup("2024-01-03", [{id: "node-1", nm: "One", ct: 3600, lm: 3600}]);

		await captureOutput(async () =>
			ImportBackups.run(["--no-download", "--no-archive", "--no-embeddings", "--backup-system-time", "--force"]),
		);

		expect(contentStamps()).toStrictEqual([
			{id: "node-1", systemFrom: "2024-01-01 02:00:00.000", systemTo: FAR_FUTURE_DATE},
			{id: "node-2", systemFrom: "2024-01-01 02:00:00.000", systemTo: "2024-01-01 02:00:00.001"},
		]);
	});
});
