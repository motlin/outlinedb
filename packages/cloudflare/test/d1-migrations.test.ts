import {afterAll, beforeAll, describe, expect, it} from "vite-plus/test";
import {readdirSync} from "node:fs";
import {applyD1Migrations, authDb, startHarness} from "./harness";
import type {Harness} from "./harness";

const migrationFiles = readdirSync(new URL("../migrations", import.meta.url))
	.filter((name) => name.endsWith(".sql"))
	.toSorted();

describe("AUTH_DB migrations", () => {
	let harness: Harness;

	beforeAll(async () => {
		harness = await startHarness("../src/worker.ts");
	}, 60_000);

	afterAll(async () => {
		await harness.dispose();
	});

	it("applies every migration file to a fresh D1 in name order", async () => {
		await expect(applyD1Migrations(harness.mf)).resolves.toStrictEqual(migrationFiles);
		const db = await authDb(harness.mf);
		const tables = await db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'")
			.all<{name: string}>();
		expect(tables.results).toStrictEqual([{name: "schema_meta"}]);
	});

	it("is a no-op on a re-run", async () => {
		await expect(applyD1Migrations(harness.mf)).resolves.toStrictEqual([]);
		const db = await authDb(harness.mf);
		const applied = await db.prepare("SELECT name FROM d1_migrations ORDER BY id").all<{name: string}>();
		expect(applied.results).toStrictEqual(migrationFiles.map((name) => ({name})));
	});
});
