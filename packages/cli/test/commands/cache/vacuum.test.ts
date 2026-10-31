import {beforeEach, afterEach, describe, expect, it} from "vite-plus/test";
import {nodeContent} from "@workflowy/shared/db";
import type {NewNodeContent} from "@workflowy/shared/db";
import {captureOutput} from "@oclif/test";
import {sql} from "drizzle-orm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Vacuum from "../../../src/commands/cache/vacuum.js";
import type {VacuumResult} from "../../../src/services/cache-vacuum.js";
import {cleanupTestDatabase, createTestDatabase} from "../../db/migration-helper.js";
import type {TestDatabase} from "../../db/migration-helper.js";

describe("cache:vacuum command", () => {
	let tempDir: string;
	let testDbPath: string;
	let testDatabase: TestDatabase;
	let originalDbPath: string | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflowy-vacuum-test-"));
		testDbPath = path.join(tempDir, "test.sqlite");
		testDatabase = createTestDatabase(testDbPath);

		originalDbPath = process.env.WORKFLOWY_DB_PATH;
		process.env.WORKFLOWY_DB_PATH = testDbPath;
	});

	afterEach(() => {
		cleanupTestDatabase(testDatabase);

		if (originalDbPath === undefined) {
			delete process.env.WORKFLOWY_DB_PATH;
		} else {
			process.env.WORKFLOWY_DB_PATH = originalDbPath;
		}

		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, {recursive: true, force: true});
		}
	});

	it("reports a low freelist count after vacuuming a database with dead pages", async () => {
		const rows: NewNodeContent[] = [];
		for (let index = 0; index < 2000; index++) {
			rows.push({
				id: `node-${index}`,
				name: `Node ${index} `.repeat(50),
				note: "x".repeat(2000),
				parentId: null,
				systemFrom: "2024-01-01 00:00:00",
				systemTo: "9999-12-31 23:59:59",
			});
		}
		testDatabase.db.insert(nodeContent).values(rows).run();

		testDatabase.sqlite.exec("PRAGMA foreign_keys = OFF");
		testDatabase.db.delete(nodeContent).run();
		testDatabase.sqlite.exec("PRAGMA foreign_keys = ON");

		const freelistBeforeRow = testDatabase.db.get<{freelist_count: number}>(sql.raw("PRAGMA freelist_count"));
		expect(freelistBeforeRow).toStrictEqual({freelist_count: 2091});

		const result = await Vacuum.run(["--json"]);

		expect(result).toStrictEqual({
			path: testDbPath,
			sizeBeforeBytes: 9_150_464,
			sizeAfterBytes: 577_536,
			freelistBefore: 2091,
			freelistAfter: 0,
		});

		const freelistAfterRow = testDatabase.db.get<{freelist_count: number}>(sql.raw("PRAGMA freelist_count"));
		expect(freelistAfterRow).toStrictEqual({freelist_count: 0});
	});

	it("prints a human-readable summary without --json", async () => {
		const {stdout, result} = await captureOutput<VacuumResult>(async () => Vacuum.run([]));

		expect(stdout).toBe(
			`🧹 Vacuuming cache database...\n  File: ${
				testDbPath
			}\n  Size before: 612.00 KB\n  Size after:  564.00 KB\n  Reclaimed:   48.00 KB\n  Freelist pages: 10 → 0\n`,
		);
		expect(result).toStrictEqual({
			path: testDbPath,
			sizeBeforeBytes: 626_688,
			sizeAfterBytes: 577_536,
			freelistBefore: 10,
			freelistAfter: 0,
		});
	});
});
