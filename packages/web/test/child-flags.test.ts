import {describe, expect, it} from "vite-plus/test";
import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {join} from "node:path";
import * as schema from "@outlinedb/shared/db";
import {mirrors, nodeContent, nodeMetadata, referencesRoots} from "@outlinedb/shared/db";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import {childFlags, childFlagsFromRows} from "../src/server/backlinks.js";

describe("childFlagsFromRows", () =>
{
	it("flags a parent with only completed children as having children but no uncompleted children", () =>
	{
		expect(
			childFlagsFromRows([
				{
					parentId: "p",
					completedAt: new Date(1000),
				},
				{
					parentId: "p",
					completedAt: new Date(2000),
				},
				{
					parentId: "q",
					completedAt: new Date(1000),
				},
				{
					parentId: "q",
					completedAt: null,
				},
				{
					parentId: "r",
					completedAt: null,
				},
				{
					parentId: null,
					completedAt: null,
				},
			]),
		).toStrictEqual(
			{
				withChildren: new Set(["p", "q", "r"]),
				withUncompletedChildren: new Set(["q", "r"]),
			},
		);
	});
});

describe("childFlags with a references root", () =>
{
	const TARGET = "00000000-0000-4000-8000-0000000000aa";
	const SOURCE = "00000000-0000-4000-8000-0000000000bb";
	const ROOT = "00000000-0000-4000-8000-0000000000cc";
	const ITEM = "00000000-0000-4000-8000-0000000000dd";
	const SEEDED_AT = "2026-01-01 00:00:00.000";

	function fixture({withItem, sourceCompleted}: {withItem: boolean; sourceCompleted: boolean})
	{
		const db = drizzle(
			new DatabaseConstructor(":memory:"),
			{
				schema,
			},
		);
		migrate(
			db,
			{
				migrationsFolder: join(import.meta.dirname, "../../shared/src/db/migrations"),
			},
		);
		const rows: [string, string | null][] = [
			[TARGET, null],
			[SOURCE, null],
			[ROOT, TARGET],
			...(withItem ? [[ITEM, ROOT] as [string, string | null]] : []),
		];
		for (const [id, parentId] of rows)
		{
			db.insert(nodeContent)
				.values(
					{
						id,
						name: "x",
						note: null,
						parentId,
						systemFrom: SEEDED_AT,
						systemTo: FAR_FUTURE_DATE,
					},
				)
				.run();
			db.insert(nodeMetadata)
				.values(
					{
						nodeId: id,
						priority: 0,
						completedAt: id === SOURCE && sourceCompleted ? new Date("2026-02-01T00:00:00Z") : null,
						systemFrom: SEEDED_AT,
						systemTo: FAR_FUTURE_DATE,
					},
				)
				.run();
		}
		db.insert(referencesRoots)
			.values(
				{
					nodeId: ROOT,
					systemFrom: SEEDED_AT,
					systemTo: FAR_FUTURE_DATE,
				},
			)
			.run();
		if (withItem)
		{
			db.insert(mirrors)
				.values(
					{
						mirrorId: ITEM,
						originalId: SOURCE,
						systemFrom: SEEDED_AT,
						systemTo: FAR_FUTURE_DATE,
					},
				)
				.run();
		}
		return db;
	}

	it("counts a root holding a current-source backlink as an uncompleted child", () =>
	{
		expect(
			childFlags(
				fixture(
					{
						withItem: true,
						sourceCompleted: false,
					},
				),
				[TARGET],
			),
		).toStrictEqual(
			{
				withChildren: new Set([TARGET]),
				withUncompletedChildren: new Set([TARGET]),
			},
		);
	});

	it("counts it as a completed child when the source is completed", () =>
	{
		expect(
			childFlags(
				fixture(
					{
						withItem: true,
						sourceCompleted: true,
					},
				),
				[TARGET],
			),
		).toStrictEqual(
			{
				withChildren: new Set([TARGET]),
				withUncompletedChildren: new Set(),
			},
		);
	});

	it("counts nothing for a root without backlink items", () =>
	{
		expect(
			childFlags(
				fixture(
					{
						withItem: false,
						sourceCompleted: false,
					},
				),
				[TARGET],
			),
		).toStrictEqual(
			{
				withChildren: new Set(),
				withUncompletedChildren: new Set(),
			},
		);
	});
});
