import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {join} from "node:path";
import {afterEach, describe, expect, it} from "vite-plus/test";
import {buildEmbedTexts, filterEmbeddable, loadEmbeddableNodes} from "../src/cache/embed-text.js";
import * as schema from "../src/db/schema.js";
import {FAR_FUTURE_DATE} from "../src/temporal/index.js";

const migrationsFolder = join(import.meta.dirname, "../src/db/migrations");
const SYSTEM_FROM = "2026-01-01 00:00:00.000";

describe("embed text", () => {
	let open: DatabaseConstructor.Database[] = [];
	afterEach(() => {
		for (const sqlite of open) {
			sqlite.close();
		}
		open = [];
	});

	function database() {
		const sqlite = new DatabaseConstructor(":memory:");
		open.push(sqlite);
		const db = drizzle(sqlite, {schema});
		migrate(db, {migrationsFolder});
		const node = (id: string, name: string, parentId: string | null, note: string | null = null) => ({
			id,
			name,
			note,
			parentId,
			systemFrom: SYSTEM_FROM,
			systemTo: FAR_FUTURE_DATE,
		});
		db.insert(schema.nodeContent)
			.values([
				node("root", "<b>Projects</b>", null),
				node("garden", "Garden", "root", "Spring <i>plan</i>"),
				node("tomatoes", "Tomatoes", "garden", "Stake them"),
				node("basil", "Basil", "garden"),
				node("mir", "Stale mirror name", null),
				node("mir-child", "Mirror child", "mir"),
			])
			.run();
		db.insert(schema.mirrors)
			.values({originalId: "garden", mirrorId: "mir", systemFrom: SYSTEM_FROM, systemTo: FAR_FUTURE_DATE})
			.run();
		return db;
	}

	it("loads only current non-leaf nodes that are not mirrors", () => {
		expect(
			loadEmbeddableNodes(database())
				.map((node) => node.id)
				.toSorted(),
		).toStrictEqual(["garden", "root"]);
	});

	it("keeps the ids that are current containers and not mirrors, in the order given", () => {
		expect(filterEmbeddable(database(), ["root", "basil", "mir", "gone", "garden"])).toStrictEqual([
			"root",
			"garden",
		]);
	});

	it("builds PATH, CONTENT and CHILDREN text, leaving CHILDREN out when a node has none", () => {
		expect(buildEmbedTexts(database(), ["garden", "root", "basil"])).toStrictEqual(
			new Map([
				[
					"garden",
					"PATH: Projects > Garden\nCONTENT: Garden\n\nSpring plan\nCHILDREN:\nBasil\nTomatoes: Stake them",
				],
				["root", "PATH: Projects\nCONTENT: Projects\nCHILDREN:\nGarden: Spring plan"],
				["basil", "PATH: Projects > Garden > Basil\nCONTENT: Basil"],
			]),
		);
	});
});
