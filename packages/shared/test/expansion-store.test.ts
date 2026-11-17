import type DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {afterEach, describe, expect, it} from "vite-plus/test";
import {readImportTime} from "../src/cache/account-store.js";
import {applyExpansionDelta, expansionVersion, readExpansion, replaceExpansion} from "../src/cache/expansion-store.js";
import {runUnitOfWork} from "../src/cache/node-composite.js";
import {startUnitOfWork} from "../src/cache/system-time.js";
import * as schema from "../src/db/schema.js";
import {FAR_FUTURE_DATE, systemTimeAt} from "../src/temporal/constants.js";
import {migratedMemoryDatabase} from "./helpers/migrated-memory-database.js";

describe("expansion store", () =>
{
	let open: DatabaseConstructor.Database[] = [];
	afterEach(() =>
	{
		for (const sqlite of open)
		{
			sqlite.close();
		}
		open = [];
	});
	function database()
	{
		const sqlite = migratedMemoryDatabase();
		open.push(sqlite);
		const db = drizzle(
			sqlite,
			{
				schema,
			},
		);
		return db;
	}
	type Db = ReturnType<typeof database>;

	function at(db: Db, time: number, work: Parameters<typeof runUnitOfWork>[1])
	{
		return runUnitOfWork(db, work, startUnitOfWork(time));
	}

	function rows(db: Db)
	{
		return db
			.select(
				{
					shortKey: schema.expandedNodes.shortKey,
					systemFrom: schema.expandedNodes.systemFrom,
					systemTo: schema.expandedNodes.systemTo,
				},
			)
			.from(schema.expandedNodes)
			.orderBy(schema.expandedNodes.shortKey, schema.expandedNodes.systemFrom)
			.all();
	}

	it("reads nothing before any import seeds the keys", () =>
	{
		expect(readExpansion(database())).toBeUndefined();
	});

	it("replaces the keys, one row per key, and records the seed time", () =>
	{
		const db = database();

		at(db, systemTimeAt("2026-01-01 00:00:00.000"), (unitOfWork) =>
		{
			replaceExpansion(unitOfWork, ["b", "a", "a"], 1_000_000);
		});

		expect(
			{
				stored: readExpansion(db),
				seededAt: readImportTime(db, "expanded_nodes"),
				rows: rows(db),
			},
		).toStrictEqual(
			{
				stored: new Set(["a", "b"]),
				seededAt: 1_000_000,
				rows: [
					{
						shortKey: "a",
						systemFrom: systemTimeAt("2026-01-01 00:00:00.000"),
						systemTo: FAR_FUTURE_DATE,
					},
					{
						shortKey: "b",
						systemFrom: systemTimeAt("2026-01-01 00:00:00.000"),
						systemTo: FAR_FUTURE_DATE,
					},
				],
			},
		);
	});

	it("reads a seeded store with no keys as empty, not unseeded", () =>
	{
		const db = database();

		at(db, systemTimeAt("2026-01-01 00:00:00.000"), (unitOfWork) =>
		{
			replaceExpansion(unitOfWork, [], 1000);
		});

		expect(readExpansion(db)).toStrictEqual(new Set());
	});

	it("applies a delta touching only its keys, closing removed rows and keeping the others' versions", () =>
	{
		const db = database();
		at(db, systemTimeAt("2026-01-01 00:00:00.000"), (unitOfWork) =>
		{
			replaceExpansion(unitOfWork, ["a", "b"], 1000);
		});

		const applied = at(db, systemTimeAt("2026-01-02 00:00:00.000"), (unitOfWork) =>
			applyExpansionDelta(
				unitOfWork,
				{
					a: false,
					c: true,
					d: false,
				},
			),
		);

		expect(
			{
				applied,
				stored: readExpansion(db),
				rows: rows(db),
			},
		).toStrictEqual(
			{
				applied: new Set(["b", "c"]),
				stored: new Set(["b", "c"]),
				rows: [
					{
						shortKey: "a",
						systemFrom: systemTimeAt("2026-01-01 00:00:00.000"),
						systemTo: systemTimeAt("2026-01-02 00:00:00.000"),
					},
					{
						shortKey: "b",
						systemFrom: systemTimeAt("2026-01-01 00:00:00.000"),
						systemTo: FAR_FUTURE_DATE,
					},
					{
						shortKey: "c",
						systemFrom: systemTimeAt("2026-01-02 00:00:00.000"),
						systemTo: FAR_FUTURE_DATE,
					},
				],
			},
		);
	});

	it("re-seeds by merging: unchanged keys keep their versions", () =>
	{
		const db = database();
		at(db, systemTimeAt("2026-01-01 00:00:00.000"), (unitOfWork) =>
		{
			replaceExpansion(unitOfWork, ["a", "b"], 1000);
		});

		at(db, systemTimeAt("2026-01-02 00:00:00.000"), (unitOfWork) =>
		{
			replaceExpansion(unitOfWork, ["b", "c"], 2000);
		});

		expect(
			{
				rows: rows(db),
				seededAt: readImportTime(db, "expanded_nodes"),
			},
		).toStrictEqual(
			{
				rows: [
					{
						shortKey: "a",
						systemFrom: systemTimeAt("2026-01-01 00:00:00.000"),
						systemTo: systemTimeAt("2026-01-02 00:00:00.000"),
					},
					{
						shortKey: "b",
						systemFrom: systemTimeAt("2026-01-01 00:00:00.000"),
						systemTo: FAR_FUTURE_DATE,
					},
					{
						shortKey: "c",
						systemFrom: systemTimeAt("2026-01-02 00:00:00.000"),
						systemTo: FAR_FUTURE_DATE,
					},
				],
				seededAt: 2000,
			},
		);
	});

	it("versions the keys by their content, not their order, duplicates or change time", () =>
	{
		const versions = [
			expansionVersion(new Set(["a", "b"])),
			expansionVersion(new Set(["b", "a"])),
			expansionVersion(new Set(["a"])),
			expansionVersion(new Set()),
		];

		expect(
			{
				sameKeys: versions[0] === versions[1],
				distinct: new Set([versions[0], versions[2], versions[3]]).size,
				shape: versions.every((version) => /^[0-9a-f]{16}$/u.test(version)),
			},
		).toStrictEqual(
			{
				sameKeys: true,
				distinct: 3,
				shape: true,
			},
		);
	});

	it("leaves an unseeded store unseeded on a delta", () =>
	{
		const db = database();

		const applied = runUnitOfWork(db, (unitOfWork) =>
			applyExpansionDelta(
				unitOfWork,
				{
					a: true,
				},
			),
		);

		expect(
			{
				applied,
				stored: readExpansion(db),
				rows: rows(db),
			},
		).toStrictEqual(
			{
				applied: undefined,
				stored: undefined,
				rows: [],
			},
		);
	});
});
