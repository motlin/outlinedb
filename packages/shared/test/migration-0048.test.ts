import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {afterEach, describe, expect, it} from "vite-plus/test";
import * as schema from "../src/db/schema.js";

const migrationsFolder = path.join(import.meta.dirname, "../src/db/migrations");
const TAG = "0048_add_survey_rating";
const FAR = "9999-12-31 23:59:59";
const SEEDED = "2026-10-01 00:00:00.000";

/** A copy of the migrations folder whose journal stops before `tag`. */
function migrationsBefore(tag: string, tempDir: string): string {
	fs.cpSync(migrationsFolder, tempDir, {recursive: true});
	const journalPath = path.join(tempDir, "meta/_journal.json");
	const journal: {entries: {tag: string}[]} = JSON.parse(fs.readFileSync(journalPath, "utf8"));
	const index = journal.entries.findIndex((entry) => entry.tag === tag);
	if (index === -1) {
		throw new Error(`no migration ${tag}`);
	}
	fs.writeFileSync(journalPath, JSON.stringify({...journal, entries: journal.entries.slice(0, index)}));
	return tempDir;
}

describe(`migration ${TAG}`, () => {
	let tempDir: string | undefined;
	afterEach(() => {
		if (tempDir !== undefined) {
			fs.rmSync(tempDir, {recursive: true, force: true});
		}
	});

	it("adds a nullable rating to surveys and keeps the existing rows with no rating", () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-0048-"));
		const sqlite = new DatabaseConstructor(":memory:");
		const db = drizzle(sqlite, {schema});
		migrate(db, {migrationsFolder: migrationsBefore(TAG, tempDir)});
		sqlite.exec(
			`INSERT INTO surveys (survey, status, at, system_from, system_to) VALUES ('panes-v1', 'dismissed', 1793201591840, '${SEEDED}', '${FAR}');`,
		);
		migrate(db, {migrationsFolder});

		expect(
			sqlite.prepare("SELECT survey, status, rating, at, system_from, system_to FROM surveys").all(),
		).toStrictEqual([
			{
				survey: "panes-v1",
				status: "dismissed",
				rating: null,
				at: 1_793_201_591_840,
				system_from: SEEDED,
				system_to: FAR,
			},
		]);
	});
});
