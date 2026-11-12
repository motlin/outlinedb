import {afterEach, beforeEach, describe, expect, it} from "vite-plus/test";
import {ACCOUNT_COMPOSITE_TABLES, runUnitOfWork, seedAccount} from "@outlinedb/shared/cache";
import {captureOutput} from "@oclif/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ImportAccount from "../../../src/commands/cache/import-account.js";
import {cleanupTestDatabase, createTestDatabase} from "../../db/migration-helper.js";
import type {TestDatabase} from "../../db/migration-helper.js";
import {backupImports, nodeContent, apiImportTimestamp, fileBlobs, tagColors} from "@outlinedb/shared/db";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import {asc} from "drizzle-orm";
import ImportBackup from "../../../src/commands/cache/import-backup.js";
import ImportBackups from "../../../src/commands/cache/import-backups.js";
import ImportLocalState from "../../../src/commands/cache/import-local-state.js";

describe("import account", () => {
	const ENV_KEYS = ["OUTLINEDB_DB_PATH", "WORKFLOWY_USERNAME", "WORKFLOWY_PASSWORD", "OUTLINEDB_SESSION_FILE"];

	describe("cache:import-account command", () => {
		let tempDir: string;
		let testDatabase: TestDatabase;
		const savedEnv: Record<string, string | undefined> = {};

		beforeEach(() => {
			tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "outlinedb-import-account-test-"));
			const testDbPath = path.join(tempDir, "test.sqlite");
			testDatabase = createTestDatabase(testDbPath);
			for (const key of ENV_KEYS) {
				savedEnv[key] = process.env[key];
				Reflect.deleteProperty(process.env, key);
			}
			process.env.OUTLINEDB_DB_PATH = testDbPath;
			process.env.OUTLINEDB_SESSION_FILE = path.join(tempDir, "no-session");
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

		it("fails without touching the account tables when no internal-API credentials or session are configured", async () => {
			const {error} = await captureOutput(async () => ImportAccount.run([]));

			expect({
				message: error?.message,
				rows: ACCOUNT_COMPOSITE_TABLES.flatMap((table) => testDatabase.db.select().from(table).all()),
			}).toStrictEqual({
				message:
					"Importing account state needs the internal API: set WORKFLOWY_USERNAME and WORKFLOWY_PASSWORD (e.g. via op run)",
				rows: [],
			});
		});
	});
});

describe("import backup", () => {
	// Backup timestamps are seconds after the account's epoch: 2024-01-01T00:00:00Z here.
	const EPOCH = "1704067200";

	describe("cache:import-backup --backup-system-time", () => {
		let tempDir: string;
		let backupsDir: string;
		let testDatabase: TestDatabase;
		const savedEnv: Record<string, string | undefined> = {};

		beforeEach(() => {
			tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "outlinedb-import-backup-test-"));
			backupsDir = path.join(tempDir, "backups");
			fs.mkdirSync(path.join(backupsDir, "Data"), {recursive: true});
			const testDbPath = path.join(tempDir, "test.sqlite");
			testDatabase = createTestDatabase(testDbPath);

			for (const key of ["OUTLINEDB_DB_PATH", "WORKFLOWY_EPOCH", "OUTLINEDB_BACKUPS_DIR"]) {
				savedEnv[key] = process.env[key];
			}
			process.env.OUTLINEDB_DB_PATH = testDbPath;
			process.env.WORKFLOWY_EPOCH = EPOCH;
			process.env.OUTLINEDB_BACKUPS_DIR = backupsDir;
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
				seedAccount(unitOfWork, {userId: "107", dateJoinedSec: Number(EPOCH)});
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
				ImportBackups.run([
					"--no-download",
					"--no-archive",
					"--no-embeddings",
					"--backup-system-time",
					"--force",
				]),
			);

			expect(contentStamps()).toStrictEqual([
				{id: "node-1", systemFrom: "2024-01-01 02:00:00.000", systemTo: FAR_FUTURE_DATE},
				{id: "node-2", systemFrom: "2024-01-01 02:00:00.000", systemTo: "2024-01-01 02:00:00.001"},
			]);
		});
	});
});

describe("import local state", () => {
	describe("cache:import-local-state command", () => {
		let tempDir: string;
		let target: TestDatabase;
		let source: TestDatabase;
		let sourcePath: string;
		let originalDbPath: string | undefined;

		beforeEach(() => {
			tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "outlinedb-local-state-test-"));
			const targetPath = path.join(tempDir, "new.sqlite");
			sourcePath = path.join(tempDir, "old.sqlite");
			target = createTestDatabase(targetPath);
			source = createTestDatabase(sourcePath);
			originalDbPath = process.env.OUTLINEDB_DB_PATH;
			process.env.OUTLINEDB_DB_PATH = targetPath;
		});

		afterEach(() => {
			cleanupTestDatabase(target);
			cleanupTestDatabase(source);
			if (originalDbPath === undefined) {
				delete process.env.OUTLINEDB_DB_PATH;
			} else {
				process.env.OUTLINEDB_DB_PATH = originalDbPath;
			}
			fs.rmSync(tempDir, {recursive: true, force: true});
		});

		it("copies every version of the account tables, their import times and every file_blobs version from the old database", async () => {
			const closed = {systemFrom: "2026-01-01 00:00:00.000", systemTo: "2026-02-01 00:00:00.000"};
			const live = {systemFrom: "2026-02-01 00:00:00.000", systemTo: "9999-12-31 23:59:59"};
			source.db
				.insert(tagColors)
				.values([
					{tag: "#a", colorIndex: 1, ...closed},
					{tag: "#a", colorIndex: 2, ...live},
				])
				.run();
			source.db
				.insert(apiImportTimestamp)
				.values([
					{name: "account", timestamp: new Date(1_000_000), ...live},
					{name: "other-pipeline", timestamp: new Date(2_000_000), ...live},
				])
				.run();
			const okBlob = {
				nodeId: "node-1",
				status: "ok",
				sha256: "abc",
				size: 3,
				contentType: "image/png",
				localPath: "ab/abc",
				error: null,
				...live,
			};
			const failedBlob = {
				nodeId: "node-1",
				status: "error",
				sha256: null,
				size: null,
				contentType: null,
				localPath: null,
				error: "404",
				...closed,
			};
			source.db.insert(fileBlobs).values([failedBlob, okBlob]).run();

			const {stdout} = await captureOutput(async () => ImportLocalState.run(["--from", sourcePath, "--json"]));

			const result = JSON.parse(stdout) as {accountTables: Record<string, number>; fileBlobs: number};
			expect({
				copied: Object.entries(result.accountTables).filter(([, count]) => count > 0),
				fileBlobsCopied: result.fileBlobs,
				tagColors: target.db.select().from(tagColors).orderBy(tagColors.systemFrom).all(),
				importTimes: target.db.select().from(apiImportTimestamp).all(),
				fileBlobs: target.db.select().from(fileBlobs).orderBy(fileBlobs.systemFrom).all(),
			}).toStrictEqual({
				copied: [["tag_colors", 2]],
				fileBlobsCopied: 2,
				tagColors: [
					{tag: "#a", colorIndex: 1, ...closed},
					{tag: "#a", colorIndex: 2, ...live},
				],
				importTimes: [{name: "account", timestamp: new Date(1_000_000), ...live}],
				fileBlobs: [failedBlob, okBlob],
			});
		});

		it("refuses, copying nothing, when the account tables already hold rows", async () => {
			const live = {systemFrom: "2026-02-01 00:00:00.000", systemTo: "9999-12-31 23:59:59"};
			source.db
				.insert(tagColors)
				.values({tag: "#a", colorIndex: 1, ...live})
				.run();
			target.db
				.insert(tagColors)
				.values({tag: "#b", colorIndex: 2, ...live})
				.run();

			const {error} = await captureOutput(async () => ImportLocalState.run(["--from", sourcePath]));

			expect({message: error?.message, tagColors: target.db.select().from(tagColors).all()}).toStrictEqual({
				message:
					"The local-state tables already hold rows (tag_colors); run import-local-state on a new database, before import-api and import-account",
				tagColors: [{tag: "#b", colorIndex: 2, ...live}],
			});
		});

		it("fails without creating the source when the old database does not exist", async () => {
			const missing = path.join(tempDir, "missing.sqlite");

			const {error} = await captureOutput(async () => ImportLocalState.run(["--from", missing]));

			expect({message: error?.message, exists: fs.existsSync(missing)}).toStrictEqual({
				message: `Old database not found: ${missing}`,
				exists: false,
			});
		});
	});
});
