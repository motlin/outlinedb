import {afterEach, beforeEach, describe, expect, it} from "vite-plus/test";
import {apiImportTimestamp, fileBlobs, tagColors} from "@outlinedb/shared/db";
import {captureOutput} from "@oclif/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ImportLocalState from "../../../src/commands/cache/import-local-state.js";
import {cleanupTestDatabase, createTestDatabase} from "../../db/migration-helper.js";
import type {TestDatabase} from "../../db/migration-helper.js";

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
