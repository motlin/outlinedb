import {afterAll, beforeAll, describe, expect, it} from "vite-plus/test";
import {rmSync} from "node:fs";
import Database from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {probeStore, readJson, startHarness} from "./harness";
import type {Harness, SchemaRow} from "./harness";

const migrationsFolder = new URL("../../shared/src/db/migrations", import.meta.url).pathname;

describe("user store Durable Object behind the Worker", () => {
	let harness: Harness;

	beforeAll(async () => {
		harness = await startHarness("./probe-entry.ts", "ProbeStore");
	}, 60_000);

	afterAll(async () => {
		await harness.dispose();
	});

	it("applies every migration in a fresh Durable Object", async () => {
		const response = await harness.mf.dispatchFetch("http://localhost/health");
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toStrictEqual({status: "ok"});

		// The probe path is not routed by the Worker, so reach the DO directly.
		const {names, migrations} = await probeStore(harness.mf);
		expect(migrations).toBe(45);
		const wanted = [
			"account",
			"calendar_layout_applies",
			"expanded_nodes",
			"node_content",
			"node_display_metadata",
			"node_fts",
			"tree_transactions",
		];
		expect(names.filter((name) => wanted.includes(name))).toStrictEqual(wanted);
	});

	it("matches the sqlite_master of the Node migration chain", async () => {
		const {schema} = await probeStore(harness.mf);
		const normalize = (rows: SchemaRow[]) =>
			rows
				.filter((row) => !row.name.startsWith("_cf_") && !row.name.startsWith("sqlite_"))
				.filter((row) => row.name !== "__drizzle_migrations")
				// DO-only bookkeeping for the sync job, created outside the shared schema.
				.filter((row) => !row.name.startsWith("sync_"))
				.map((row) => ({type: row.type, name: row.name, sql: row.sql.replaceAll(/\s+/gu, " ")}));

		const node = new Database(":memory:");
		migrate(drizzle(node), {migrationsFolder});
		const nodeSchema = node
			.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name")
			.all() as SchemaRow[];
		node.close();

		expect(normalize(schema)).toStrictEqual(normalize(nodeSchema));
	});

	it("serves an empty outline root on a fresh database", async () => {
		const response = await harness.mf.dispatchFetch("http://localhost/api/v1/nodes");
		expect(response.status).toBe(200);
		await expect(readJson(response)).resolves.toStrictEqual({nodes: []});
	});

	it("keeps node_tags in step with a write, so tag autocomplete drops a removed tag", async () => {
		const tags = async () => {
			const response = await harness.mf.dispatchFetch(
				"http://localhost/api/v1/tags/autocomplete?prefix=%23doTag",
			);
			return readJson(response);
		};
		await probeStore(harness.mf, `/__seed?name=${encodeURIComponent("seeded #doTag")}`);
		const tagged = await tags();
		await probeStore(harness.mf, "/__seed?name=seeded");

		expect({tagged, untagged: await tags()}).toStrictEqual({
			tagged: {tags: [{tag: "#doTag", count: 1}]},
			untagged: {tags: []},
		});
	});

	it("serves the SPA index.html for a client route", async () => {
		const response = await harness.mf.dispatchFetch("http://localhost/some/client/route", {
			headers: {"sec-fetch-mode": "navigate", accept: "text/html"},
		});
		expect(response.status).toBe(200);
		await expect(response.text()).resolves.toContain('<div id="root"');
	});
});

describe("user store restart", () => {
	it("does not re-run migrations when the Durable Object restarts", async () => {
		const probe = async (h: Harness) => probeStore(h.mf);
		const first = await startHarness("./probe-entry.ts", "ProbeStore");
		const persistDir = first.persistDir;
		try {
			await expect(probe(first)).resolves.toMatchObject({migrations: 45, appliedOnBoot: 45});
			await first.dispose(true);
			const second = await startHarness("./probe-entry.ts", "ProbeStore", persistDir);
			try {
				await expect(probe(second)).resolves.toMatchObject({migrations: 45, appliedOnBoot: 0});
			} finally {
				await second.dispose();
			}
		} finally {
			rmSync(persistDir, {recursive: true, force: true});
		}
	}, 60_000);
});
