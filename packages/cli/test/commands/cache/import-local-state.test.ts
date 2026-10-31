import {afterEach, beforeEach, describe, expect, it} from "vite-plus/test";
import {fileBlobs, localSettings} from "@workflowy/shared/db";
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
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflowy-local-state-test-"));
		const targetPath = path.join(tempDir, "new.sqlite");
		sourcePath = path.join(tempDir, "old.sqlite");
		target = createTestDatabase(targetPath);
		source = createTestDatabase(sourcePath);
		originalDbPath = process.env.WORKFLOWY_DB_PATH;
		process.env.WORKFLOWY_DB_PATH = targetPath;
	});

	afterEach(() => {
		cleanupTestDatabase(target);
		cleanupTestDatabase(source);
		if (originalDbPath === undefined) {
			delete process.env.WORKFLOWY_DB_PATH;
		} else {
			process.env.WORKFLOWY_DB_PATH = originalDbPath;
		}
		fs.rmSync(tempDir, {recursive: true, force: true});
	});

	it("copies every local_settings and file_blobs row from the old database, replacing rows with the same key", async () => {
		source.db
			.insert(localSettings)
			.values([
				{key: "root:layout", json: "{}", updatedAt: 222},
				{key: "setting:theme", json: '"dark"', updatedAt: 111},
			])
			.run();
		source.db
			.insert(fileBlobs)
			.values([
				{
					nodeId: "node-1",
					status: "ok",
					sha256: "abc",
					size: 3,
					contentType: "image/png",
					localPath: "ab/abc",
					error: null,
					fetchedAt: 333,
				},
				{
					nodeId: "node-2",
					status: "error",
					sha256: null,
					size: null,
					contentType: null,
					localPath: null,
					error: "404",
					fetchedAt: 444,
				},
			])
			.run();
		target.db.insert(localSettings).values({key: "setting:theme", json: '"light"', updatedAt: 1}).run();

		const {stdout} = await captureOutput(async () => ImportLocalState.run(["--from", sourcePath, "--json"]));

		expect({
			result: JSON.parse(stdout) as unknown,
			localSettings: target.db.select().from(localSettings).orderBy(localSettings.key).all(),
			fileBlobs: target.db.select().from(fileBlobs).orderBy(fileBlobs.nodeId).all(),
		}).toStrictEqual({
			result: {localSettings: 2, fileBlobs: 2},
			localSettings: [
				{key: "root:layout", json: "{}", updatedAt: 222},
				{key: "setting:theme", json: '"dark"', updatedAt: 111},
			],
			fileBlobs: [
				{
					nodeId: "node-1",
					status: "ok",
					sha256: "abc",
					size: 3,
					contentType: "image/png",
					localPath: "ab/abc",
					error: null,
					fetchedAt: 333,
				},
				{
					nodeId: "node-2",
					status: "error",
					sha256: null,
					size: null,
					contentType: null,
					localPath: null,
					error: "404",
					fetchedAt: 444,
				},
			],
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
