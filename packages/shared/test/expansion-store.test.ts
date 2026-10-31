import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {join} from "node:path";
import {afterEach, describe, expect, it} from "vite-plus/test";
import {readImportTime} from "../src/cache/account-store.js";
import {applyExpansionDelta, expansionVersion, readExpansion, replaceExpansion} from "../src/cache/expansion-store.js";
import {runUnitOfWork} from "../src/cache/node-composite.js";
import {startUnitOfWork} from "../src/cache/system-time.js";
import * as schema from "../src/db/schema.js";

const migrationsFolder = join(import.meta.dirname, "../src/db/migrations");

describe("expansion store", () => {
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
		return db;
	}
	type Db = ReturnType<typeof database>;

	function at(db: Db, time: string, work: Parameters<typeof runUnitOfWork>[1]) {
		return runUnitOfWork(db, work, startUnitOfWork(new Date(`${time}Z`)));
	}

	function rows(db: Db) {
		return db
			.select({
				shortKey: schema.expandedNodes.shortKey,
				systemFrom: schema.expandedNodes.systemFrom,
				systemTo: schema.expandedNodes.systemTo,
			})
			.from(schema.expandedNodes)
			.orderBy(schema.expandedNodes.shortKey, schema.expandedNodes.systemFrom)
			.all();
	}

	it("reads nothing before any import seeds the keys", () => {
		expect(readExpansion(database())).toBeUndefined();
	});

	it("replaces the keys, one row per key, and records the seed time", () => {
		const db = database();

		at(db, "2026-01-01 00:00:00.000", (unitOfWork) => {
			replaceExpansion(unitOfWork, ["b", "a", "a"], 1_000_000);
		});

		expect({
			stored: readExpansion(db),
			seededAt: readImportTime(db, "expanded_nodes"),
			rows: rows(db),
		}).toStrictEqual({
			stored: new Set(["a", "b"]),
			seededAt: 1_000_000,
			rows: [
				{shortKey: "a", systemFrom: "2026-01-01 00:00:00.000", systemTo: "9999-12-31 23:59:59"},
				{shortKey: "b", systemFrom: "2026-01-01 00:00:00.000", systemTo: "9999-12-31 23:59:59"},
			],
		});
	});

	it("reads a seeded store with no keys as empty, not unseeded", () => {
		const db = database();

		at(db, "2026-01-01 00:00:00.000", (unitOfWork) => {
			replaceExpansion(unitOfWork, [], 1000);
		});

		expect(readExpansion(db)).toStrictEqual(new Set());
	});

	it("applies a delta touching only its keys, closing removed rows and keeping the others' versions", () => {
		const db = database();
		at(db, "2026-01-01 00:00:00.000", (unitOfWork) => {
			replaceExpansion(unitOfWork, ["a", "b"], 1000);
		});

		const applied = at(db, "2026-01-02 00:00:00.000", (unitOfWork) =>
			applyExpansionDelta(unitOfWork, {a: false, c: true, d: false}),
		);

		expect({applied, stored: readExpansion(db), rows: rows(db)}).toStrictEqual({
			applied: new Set(["b", "c"]),
			stored: new Set(["b", "c"]),
			rows: [
				{shortKey: "a", systemFrom: "2026-01-01 00:00:00.000", systemTo: "2026-01-02 00:00:00.000"},
				{shortKey: "b", systemFrom: "2026-01-01 00:00:00.000", systemTo: "9999-12-31 23:59:59"},
				{shortKey: "c", systemFrom: "2026-01-02 00:00:00.000", systemTo: "9999-12-31 23:59:59"},
			],
		});
	});

	it("re-seeds by merging: unchanged keys keep their versions", () => {
		const db = database();
		at(db, "2026-01-01 00:00:00.000", (unitOfWork) => {
			replaceExpansion(unitOfWork, ["a", "b"], 1000);
		});

		at(db, "2026-01-02 00:00:00.000", (unitOfWork) => {
			replaceExpansion(unitOfWork, ["b", "c"], 2000);
		});

		expect({rows: rows(db), seededAt: readImportTime(db, "expanded_nodes")}).toStrictEqual({
			rows: [
				{shortKey: "a", systemFrom: "2026-01-01 00:00:00.000", systemTo: "2026-01-02 00:00:00.000"},
				{shortKey: "b", systemFrom: "2026-01-01 00:00:00.000", systemTo: "9999-12-31 23:59:59"},
				{shortKey: "c", systemFrom: "2026-01-02 00:00:00.000", systemTo: "9999-12-31 23:59:59"},
			],
			seededAt: 2000,
		});
	});

	it("versions the keys by their content, not their order, duplicates or change time", () => {
		const versions = [
			expansionVersion(new Set(["a", "b"])),
			expansionVersion(new Set(["b", "a"])),
			expansionVersion(new Set(["a"])),
			expansionVersion(new Set()),
		];

		expect({
			sameKeys: versions[0] === versions[1],
			distinct: new Set([versions[0], versions[2], versions[3]]).size,
			shape: versions.every((version) => /^[0-9a-f]{16}$/u.test(version)),
		}).toStrictEqual({sameKeys: true, distinct: 3, shape: true});
	});

	it("leaves an unseeded store unseeded on a delta", () => {
		const db = database();

		const applied = runUnitOfWork(db, (unitOfWork) => applyExpansionDelta(unitOfWork, {a: true}));

		expect({applied, stored: readExpansion(db), rows: rows(db)}).toStrictEqual({
			applied: undefined,
			stored: undefined,
			rows: [],
		});
	});
});
