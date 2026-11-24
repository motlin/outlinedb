import {describe, expect, it, afterEach} from "vite-plus/test";
import
{
	accountRows,
	snapshotFromRows,
	readAccountRows,
	readAccountSnapshot,
	readWorkflowyEpoch,
	seedAccount,
	writeAccountSnapshot,
} from "../src/cache/account-store.js";
import type {AccountSnapshot, AccountRows} from "../src/cache/account-store.js";
import type DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {accountVersion} from "../src/cache/account-seed.js";
import {runUnitOfWork} from "../src/cache/node-composite.js";
import * as schema from "../src/db/schema.js";
import {FAR_FUTURE_DATE} from "../src/temporal/constants.js";
import {migratedMemoryDatabase} from "./helpers/migrated-memory-database.js";

describe("account store surveys", () =>
{
	function snapshotWithSurveys(surveys: Record<string, unknown>): AccountSnapshot
	{
		return {
			account:
			{
				userId: "7",
				dateJoinedSec: 1_324_752_241,
			},
			rootMetadata:
			{
				surveys,
			},
			settings: {},
			visibleFeatures: [],
		};
	}

	describe("account store surveys", () =>
	{
		it("stores each survey's status, rating and time, and rebuilds the same root metadata from the rows", () =>
		{
			const surveys =
			{
				"workflowy-experience-v1":
				{
					status: "submitted",
					rating: 4,
					at: 1_793_201_591_840,
				},
				"panes-v1":
				{
					status: "dismissed",
					at: 1_793_201_500_000,
				},
			};
			const rows = accountRows(snapshotWithSurveys(surveys));

			expect(
				{
					rows: rows.surveys,
					rebuilt: snapshotFromRows(rows)?.rootMetadata.surveys,
				},
			).toStrictEqual(
				{
					rows: [
						{
							survey: "workflowy-experience-v1",
							status: "submitted",
							rating: 4,
							at: 1_793_201_591_840,
						},
						{
							survey: "panes-v1",
							status: "dismissed",
							rating: null,
							at: 1_793_201_500_000,
						},
					],
					rebuilt: surveys,
				},
			);
		});
	});
});

describe("account store", () =>
{
	function snapshot(rootMetadata: Record<string, unknown>, settings: Record<string, unknown> = {}): AccountSnapshot
	{
		return {
			account:
			{
				userId: "1",
				dateJoinedSec: 1_324_752_241,
			},
			rootMetadata,
			settings,
			visibleFeatures: [],
		};
	}

	describe("account store", () =>
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
		function write(db: ReturnType<typeof database>, value: AccountSnapshot)
		{
			runUnitOfWork(db, (unitOfWork) =>
			{
				writeAccountSnapshot(unitOfWork, value);
			});
		}

		it("reads nothing before any account import", () =>
		{
			expect(readAccountSnapshot(database())).toBeUndefined();
		});

		it("reads the Workflowy epoch from the live account row's join date", () =>
		{
			const db = database();
			const before = readWorkflowyEpoch(db);
			write(db, snapshot({}));
			expect(
				{
					before,
					after: readWorkflowyEpoch(db),
				},
			).toStrictEqual(
				{
					before: undefined,
					after: 1_324_752_241,
				},
			);
		});

		it("seeds only the account row, which a later full account write replaces", () =>
		{
			const db = database();
			runUnitOfWork(db, (unitOfWork) =>
			{
				seedAccount(
					unitOfWork,
					{
						userId: "0",
						dateJoinedSec: 1_324_752_241,
					},
				);
			});
			const seeded = readAccountRows(db);
			write(
				db,
				{
					...snapshot({}),
					account:
					{
						userId: "107",
						dateJoinedSec: 1_324_752_241,
						fullName: "Alice Smith",
					},
				},
			);
			expect(
				{
					seeded: seeded.account,
					written: readAccountRows(db).account,
				},
			).toStrictEqual(
				{
					seeded: [
						{
							userId: "0",
							fullName: null,
							dateJoinedSec: 1_324_752_241,
							entropyKey: null,
							username: null,
							email: null,
						},
					],
					written: [
						{
							userId: "107",
							fullName: "Alice Smith",
							dateJoinedSec: 1_324_752_241,
							entropyKey: null,
							username: null,
							email: null,
						},
					],
				},
			);
		});

		it("round-trips the stars with an order, one star_order row per entry, unordered stars kept", () =>
		{
			const db = database();
			const starring =
			{
				locations:
				{
					n1: "None",
					"n2_q ": "None",
					n3: "None",
				},
				order: "None/n2/q ,None/n1/",
			};

			write(
				db,
				snapshot(
					{
						starring,
					},
				),
			);

			expect(
				{
					starring: readAccountSnapshot(db)?.rootMetadata.starring,
					order: readAccountRows(db).starOrder,
				},
			).toStrictEqual(
				{
					starring,
					order: [
						{
							position: 0,
							entry: "None/n2/q ",
						},
						{
							position: 1,
							entry: "None/n1/",
						},
					],
				},
			);
		});

		it("round-trips the stars without an order, leaving the order absent", () =>
		{
			const db = database();

			write(
				db,
				snapshot(
					{
						starring:
						{
							locations:
							{
								n1: "None",
							},
						},
					},
				),
			);

			expect(
				{
					starring: readAccountSnapshot(db)?.rootMetadata.starring,
					order: readAccountRows(db).starOrder,
				},
			).toStrictEqual(
				{
					starring:
					{
						locations:
						{
							n1: "None",
						},
					},
					order: [],
				},
			);
		});

		it("re-versions only the rows a write changes", () =>
		{
			const db = database();
			write(
				db,
				snapshot(
					{
						color:
						{
							tags:
							{
								"#a": 1,
								"#b": 2,
							},
						},
						dateFormat: "YYYY",
					},
				),
			);

			write(
				db,
				snapshot(
					{
						color:
						{
							tags:
							{
								"#a": 1,
								"#b": 3,
							},
						},
						dateFormat: "YYYY",
					},
				),
			);

			const tags = db
				.select(
					{
						tag: schema.tagColors.tag,
						colorIndex: schema.tagColors.colorIndex,
						systemTo: schema.tagColors.systemTo,
					},
				)
				.from(schema.tagColors)
				.orderBy(schema.tagColors.tag, schema.tagColors.systemFrom)
				.all()
				.map((row) => [row.tag, row.colorIndex, row.systemTo === FAR_FUTURE_DATE]);
			expect(
				{
					tags,
					preferenceVersions: db.select().from(schema.rootPreferences).all().length,
				},
			).toStrictEqual(
				{
					tags: [
						["#a", 1, true],
						["#b", 2, false],
						["#b", 3, true],
					],
					preferenceVersions: 1,
				},
			);
		});

		it("stores flags as 0/1 whether upstream sends booleans or yes/no, and reads them back as booleans", () =>
		{
			const db = database();

			write(
				db,
				snapshot(
					{},
					{
						show_completed: "yes",
						ignore_loom: "no",
						backup_to_dropbox: true,
					},
				),
			);

			expect(
				{
					row: readAccountRows(db).accountSettings.map(({showCompleted, ignoreLoom, backupToDropbox}) => (
					{
						showCompleted,
						ignoreLoom,
						backupToDropbox,
					})),
					settings: readAccountSnapshot(db)?.settings,
				},
			).toStrictEqual(
				{
					row: [
						{
							showCompleted: 1,
							ignoreLoom: 0,
							backupToDropbox: 1,
						},
					],
					settings:
					{
						show_completed: true,
						ignore_loom: false,
						backup_to_dropbox: true,
					},
				},
			);
		});
	});
});

describe("account version", () =>
{
	const EMPTY: AccountRows =
	{
		account: [],
		rootPreferences: [],
		accountSettings: [],
		tagColors: [],
		stars: [],
		starOrder: [],
		locationRenames: [],
		enabledFeatures: [],
		visibleFeatures: [],
		changelogReads: [],
		surveys: [],
		savedViews: [],
		aiAssistants: [],
		aiPromptButtons: [],
	};

	describe("accountVersion", () =>
	{
		it("moves when a row changes and ignores row order", () =>
		{
			const a =
			{
				codename: "a",
				enabled: 1,
			};
			const b =
			{
				codename: "full_width_page",
				enabled: 1,
			};
			expect(
				{
					empty:
						accountVersion(EMPTY) ===
						accountVersion(
							{
								...EMPTY,
							},
						),
					reordered:
						accountVersion(
							{
								...EMPTY,
								enabledFeatures: [a, b],
							},
						) ===
						accountVersion(
							{
								...EMPTY,
								enabledFeatures: [b, a],
							},
						),
					added:
						accountVersion(EMPTY) ===
						accountVersion(
							{
								...EMPTY,
								enabledFeatures: [b],
							},
						),
					format: /^[0-9a-f]{16}$/u.test(accountVersion(EMPTY)),
				},
			).toStrictEqual(
				{
					empty: true,
					reordered: true,
					added: false,
					format: true,
				},
			);
		});
	});
});
