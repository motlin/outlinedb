import DatabaseConstructor from "better-sqlite3";
import {and, eq, is, sql} from "drizzle-orm";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {getTableConfig, SQLiteTable} from "drizzle-orm/sqlite-core";
import path, {join} from "node:path";
import {beforeEach, afterEach, describe, expect, it} from "vite-plus/test";
import
{
	endNodeComposites,
	endOrphanedParts,
	NODE_COMPOSITE_PARTS,
	NODE_COMPOSITE_ROOT,
	NON_NODE_ID_COLUMNS,
	NON_NODE_TABLES,
	runUnitOfWork,
} from "../src/cache/node-composite.js";
import type {UnitOfWork} from "../src/cache/node-composite.js";
import * as schema from "../src/db/schema.js";
import {FAR_FUTURE_DATE} from "../src/temporal/constants.js";
import {NodeReader, CacheService, ensureNodeTags} from "@outlinedb/shared/cache";
import {buildTestDb, bulkImportWithWatermarkGuard, loadFixtureBackup} from "./helpers/round-trip-helpers.js";
import {nodeContent} from "@outlinedb/shared/db";

describe("node composite", () =>
{
	const migrationsFolder = join(import.meta.dirname, "../src/db/migrations");

	const SEEDED = "2026-01-01 00:00:00.000";
	const UOW_TIME = "2026-06-01 12:00:00.000";

	function sqlTables(): SQLiteTable[]
	{
		const values: unknown[] = Object.values(schema);
		return values.filter((value): value is SQLiteTable => is(value, SQLiteTable));
	}

	function isNodeIdColumnName(name: string): boolean
	{
		return name === "id" || name.endsWith("_id");
	}

	describe("node composite ownership map", () =>
	{
		it("classifies every schema table exactly once", () =>
		{
			const classified = [
				getTableConfig(NODE_COMPOSITE_ROOT.table).name,
				...NODE_COMPOSITE_PARTS.map((part) => getTableConfig(part.table).name),
				...Object.keys(NON_NODE_TABLES),
			];
			const all = sqlTables()
				.map((table) => getTableConfig(table).name)
				.toSorted();
			expect(classified.toSorted()).toStrictEqual(all);
		});

		it("classifies every node-id column of the root and its parts as owner, reference, or non-node id", () =>
		{
			const unclassified: string[] = [];
			const roots = [NODE_COMPOSITE_ROOT, ...NODE_COMPOSITE_PARTS];
			for (const entry of roots)
			{
				const config = getTableConfig(entry.table);
				const known = new Set([entry.owner.name, ...entry.references.map((column) => column.name)]);
				for (const column of config.columns)
				{
					const qualified = `${config.name}.${column.name}`;
					if (
						isNodeIdColumnName(column.name) &&
						!known.has(column.name) &&
						!(qualified in NON_NODE_ID_COLUMNS)
					)
					{
						unclassified.push(qualified);
					}
				}
			}
			expect(unclassified).toStrictEqual([]);
		});

		it("names the owner with the leading primary-key column", () =>
		{
			const mismatches: string[] = [];
			for (const entry of [NODE_COMPOSITE_ROOT, ...NODE_COMPOSITE_PARTS])
			{
				const config = getTableConfig(entry.table);
				const leading = config.primaryKeys[0]?.columns[0] ?? config.columns.find((column) => column.primary);
				if (leading?.name !== entry.owner.name)
				{
					mismatches.push(`${config.name}: leading ${leading?.name}, owner ${entry.owner.name}`);
				}
			}
			expect(mismatches).toStrictEqual([]);
		});

		it("migrates every owned table to the primary key the schema declares", () =>
		{
			const sqlite = new DatabaseConstructor(":memory:");
			migrate(
				drizzle(
					sqlite,
					{
						schema,
					},
				),
				{
					migrationsFolder,
				},
			);
			const declared: Record<string, string[]> = {};
			const migrated: Record<string, string[]> = {};
			for (const entry of [NODE_COMPOSITE_ROOT, ...NODE_COMPOSITE_PARTS])
			{
				const config = getTableConfig(entry.table);
				declared[config.name] =
					config.primaryKeys[0]?.columns.map((column) => column.name) ??
					config.columns.filter((column) => column.primary).map((column) => column.name);
				const columns = sqlite.prepare(`PRAGMA table_info(${config.name})`).all() as
				{
					name: string;
					pk: number;
				}[];
				migrated[config.name] = columns
					.filter((column) => column.pk > 0)
					.toSorted((a, b) => a.pk - b.pk)
					.map((column) => column.name);
			}
			sqlite.close();
			expect(migrated).toStrictEqual(declared);
		});
	});

	describe("ending node composites", () =>
	{
		let sqlite: DatabaseConstructor.Database;
		let database: ReturnType<typeof drizzle<typeof schema>>;

		beforeEach(() =>
		{
			sqlite = new DatabaseConstructor(":memory:");
			database = drizzle(
				sqlite,
				{
					schema,
				},
			);
			migrate(
				database,
				{
					migrationsFolder,
				},
			);
		});

		afterEach(() =>
		{
			sqlite.close();
		});

		const temporal =
		{
			systemFrom: SEEDED,
			systemTo: FAR_FUTURE_DATE,
		};

		function seedNode(id: string, parentId: string | null = null): void
		{
			database
				.insert(schema.nodeContent)
				.values(
					{
						id,
						name: id,
						note: null,
						parentId,
						...temporal,
					},
				)
				.run();
			database
				.insert(schema.nodeMetadata)
				.values(
					{
						nodeId: id,
						shortId: null,
						priority: 0,
						createdAt: null,
						modifiedAt: null,
						completedAt: null,
						layoutMode: null,
						...temporal,
					},
				)
				.run();
		}

		/** Every owned part of `id`, so a test can assert the whole composite ends together. */
		function seedParts(id: string): void
		{
			database
				.insert(schema.calendarMetadata)
				.values(
					{
						nodeId: id,
						root: null,
						level: null,
						value: null,
						dateId: null,
						timestamp: null,
						foundDates: null,
						...temporal,
					},
				)
				.run();
			database
				.insert(schema.calendarLevels)
				.values(
					{
						nodeId: id,
						day: 1,
						week: null,
						month: null,
						year: null,
						...temporal,
					},
				)
				.run();
			database
				.insert(schema.nodeEmbeddings)
				.values(
					{
						nodeId: id,
						model: "minilm",
						embedding: Buffer.from([1]),
						...temporal,
					},
				)
				.run();
			database
				.insert(schema.aiMetadata)
				.values(
					{
						nodeId: id,
						inChat: 1,
						...temporal,
					},
				)
				.run();
			database
				.insert(schema.s3Files)
				.values(
					{
						nodeId: id,
						fileName: "f",
						fileType: "image/png",
						...temporal,
					},
				)
				.run();
			database
				.insert(schema.changesMetadata)
				.values(
					{
						nodeId: id,
						ctBy: 1,
						...temporal,
					},
				)
				.run();
			database
				.insert(schema.referencesRoots)
				.values(
					{
						nodeId: id,
						...temporal,
					},
				)
				.run();
			database
				.insert(schema.nodeDisplayMetadata)
				.values(
					{
						nodeId: id,
						numberedStart: 1,
						...temporal,
					},
				)
				.run();
			database
				.insert(schema.nodeTableCellSizes)
				.values(
					{
						nodeId: id,
						cellId: "cell",
						size: 100,
						...temporal,
					},
				)
				.run();
			database
				.insert(schema.nodeTags)
				.values(
					{
						nodeId: id,
						tagKey: "#tag",
						tag: "#tag",
					},
				)
				.run();
		}

		/** Each owned table's rows as sorted `owner@systemTo`; the hard-delete table reports `owner@present`. */
		function snapshot(): Record<string, string[]>
		{
			const tables: Record<string, string[]> = {};
			for (const {table, owner} of [NODE_COMPOSITE_ROOT, ...NODE_COMPOSITE_PARTS])
			{
				const config = getTableConfig(table);
				const systemTo = config.columns.some((column) => column.name === "system_to")
					? "system_to"
					: "'present'";
				const rows = sqlite
					.prepare(`SELECT ${owner.name} || '@' || ${systemTo} AS row FROM ${config.name}`)
					.all() as
				{
					row: string;
				}[];
				tables[config.name] = rows.map(({row}) => row).toSorted();
			}
			return tables;
		}

		/** Every table that holds exactly one row per seeded node, so a test can name a composite's rows by owner. */
		const oneRowTables = [
			"node_content",
			"node_metadata",
			"calendar_metadata",
			"calendar_levels",
			"node_display_metadata",
			"node_table_cell_sizes",
			"node_embeddings",
			"ai_metadata",
			"s3_files",
			"changes_metadata",
			"references_roots",
		];

		/** The expected snapshot for owners -> systemTo, given which owners have node rows and which have parts. */
		function expected(
			entries:
			{
				owner: string;
				systemTo: string;
				node: boolean;
				parts: boolean;
			}[],
		): Record<string, string[]>
		{
			const tables: Record<string, string[]> = {};
			for (const table of oneRowTables)
			{
				const isNodeTable = table === "node_content" || table === "node_metadata";
				tables[table] = entries
					.filter((entry) => (isNodeTable ? entry.node : entry.parts))
					.map((entry) => `${entry.owner}@${entry.systemTo}`)
					.toSorted();
			}
			return tables;
		}

		function pick(snap: Record<string, string[]>): Record<string, string[]>
		{
			return Object.fromEntries(oneRowTables.map((table) => [table, snap[table] ?? []]));
		}

		it("ends every owned part of the given nodes, keeps other composites and references, and closes mirrors from either side", () =>
		{
			seedNode("doomed");
			seedParts("doomed");
			seedNode("survivor");
			seedParts("survivor");
			seedNode("mirror-of-doomed");
			seedNode("original-of-doomed");
			// The doomed node is an original (its mirror's row ends: Q2) and also a mirror (its own row ends).
			database
				.insert(schema.mirrors)
				.values(
					{
						originalId: "doomed",
						mirrorId: "mirror-of-doomed",
						...temporal,
					},
				)
				.run();
			database
				.insert(schema.mirrors)
				.values(
					{
						originalId: "original-of-doomed",
						mirrorId: "doomed",
						...temporal,
					},
				)
				.run();

			runUnitOfWork(
				database,
				(unitOfWork) =>
				{
					endNodeComposites(unitOfWork, ["doomed"]);
				},
				{
					systemTime: UOW_TIME,
					startedAt: Date.now(),
				},
			);

			const snap = snapshot();
			expect(
				{
					owned: pick(snap),
					mirrors: sqlite
						.prepare(
							"SELECT original_id || '>' || mirror_id || '@' || system_to AS row FROM mirrors ORDER BY row",
						)
						.all(),
					tags: snap.node_tags,
				},
			).toStrictEqual(
				{
					owned: expected([
						{
							owner: "doomed",
							systemTo: UOW_TIME,
							node: true,
							parts: true,
						},
						{
							owner: "survivor",
							systemTo: FAR_FUTURE_DATE,
							node: true,
							parts: true,
						},
						{
							owner: "mirror-of-doomed",
							systemTo: FAR_FUTURE_DATE,
							node: true,
							parts: false,
						},
						{
							owner: "original-of-doomed",
							systemTo: FAR_FUTURE_DATE,
							node: true,
							parts: false,
						},
					]),
					mirrors: [
						{
							row: `doomed>mirror-of-doomed@${UOW_TIME}`,
						},
						{
							row: `original-of-doomed>doomed@${UOW_TIME}`,
						},
					],
					tags: ["survivor@present"],
				},
			);
		});

		it("sweeps parts whose owner has no current node, and mirror rows whose original is gone", () =>
		{
			seedNode("live");
			seedParts("live");
			seedParts("ghost");
			seedNode("live-mirror");
			database
				.insert(schema.mirrors)
				.values(
					{
						originalId: "ghost",
						mirrorId: "live-mirror",
						...temporal,
					},
				)
				.run();
			database
				.insert(schema.mirrors)
				.values(
					{
						originalId: "live",
						mirrorId: "live-mirror",
						...temporal,
					},
				)
				.run();

			runUnitOfWork(
				database,
				(unitOfWork) =>
				{
					endOrphanedParts(unitOfWork);
				},
				{
					systemTime: UOW_TIME,
					startedAt: Date.now(),
				},
			);

			const snap = snapshot();
			expect(
				{
					owned: pick(snap),
					mirrors: sqlite
						.prepare(
							"SELECT original_id || '>' || mirror_id || '@' || system_to AS row FROM mirrors ORDER BY row",
						)
						.all(),
					tags: snap.node_tags,
				},
			).toStrictEqual(
				{
					owned: expected([
						{
							owner: "live",
							systemTo: FAR_FUTURE_DATE,
							node: true,
							parts: true,
						},
						{
							owner: "ghost",
							systemTo: UOW_TIME,
							node: false,
							parts: true,
						},
						{
							owner: "live-mirror",
							systemTo: FAR_FUTURE_DATE,
							node: true,
							parts: false,
						},
					]),
					mirrors: [
						{
							row: `ghost>live-mirror@${UOW_TIME}`,
						},
						{
							row: `live>live-mirror@${FAR_FUTURE_DATE}`,
						},
					],
					tags: ["live@present"],
				},
			);
		});

		/** Delete an original by promoting it into its mirror's place: the mirror's composite (with its mirror row) ends and the original is versioned, in one unit of work. */
		function deleteOriginalAndPromote(unitOfWork: UnitOfWork): void
		{
			endNodeComposites(unitOfWork, ["mirror"]);
			// The original survives as a new version in the mirror's place.
			unitOfWork.tx
				.update(schema.nodeContent)
				.set(
					{
						systemTo: unitOfWork.systemTime,
					},
				)
				.where(and(eq(schema.nodeContent.id, "original"), eq(schema.nodeContent.systemTo, FAR_FUTURE_DATE)))
				.run();
			unitOfWork.tx
				.insert(schema.nodeContent)
				.values(
					{
						id: "original",
						name: "original",
						note: null,
						parentId: "mirror-parent",
						systemFrom: unitOfWork.systemTime,
						systemTo: FAR_FUTURE_DATE,
					},
				)
				.run();
		}

		it("writes one system time for every ended and new row of a multi-composite operation", () =>
		{
			seedNode("original");
			seedParts("original");
			seedNode("mirror", "mirror-parent");
			database
				.insert(schema.mirrors)
				.values(
					{
						originalId: "original",
						mirrorId: "mirror",
						...temporal,
					},
				)
				.run();

			const returned = runUnitOfWork(database, (unitOfWork) =>
			{
				deleteOriginalAndPromote(unitOfWork);
				return unitOfWork.systemTime;
			});

			const times = sqlite
				.prepare(
					`SELECT system_to AS t FROM node_content WHERE system_to <> '${FAR_FUTURE_DATE}'
				 UNION SELECT system_from FROM node_content WHERE system_from <> '${SEEDED}'
				 UNION SELECT system_to FROM node_metadata WHERE system_to <> '${FAR_FUTURE_DATE}'
				 UNION SELECT system_to FROM mirrors WHERE system_to <> '${FAR_FUTURE_DATE}'
				 UNION SELECT system_to FROM node_embeddings WHERE system_to <> '${FAR_FUTURE_DATE}'
				 UNION SELECT system_to FROM references_roots WHERE system_to <> '${FAR_FUTURE_DATE}'`,
				)
				.all();
			expect(times).toStrictEqual([
				{
					t: returned,
				},
			]);
		});

		it("rolls back every composite when the unit of work throws", () =>
		{
			seedNode("original");
			seedParts("original");
			seedNode("mirror", "mirror-parent");
			database
				.insert(schema.mirrors)
				.values(
					{
						originalId: "original",
						mirrorId: "mirror",
						...temporal,
					},
				)
				.run();
			const before = snapshot();

			expect(() =>
				runUnitOfWork(database, (unitOfWork) =>
				{
					deleteOriginalAndPromote(unitOfWork);
					throw new Error("mid-operation failure");
				}),
			).toThrow("mid-operation failure");

			expect(snapshot()).toStrictEqual(before);
		});
	});
});

describe("node dto", () =>
{
	/**
	 * Phase 4d: snapshot test for the canonical `Node` DTO.
	 *
	 * `NodeReader` is the single construction site for the canonical `Node` type
	 * (`packages/shared/src/types/node.ts`). This test imports a known fixture
	 * node and snapshots `NodeReader.getById`'s output. Any unintentional change
	 * to the canonical shape — a renamed field, a dropped field, a changed
	 * defaulting rule — makes the snapshot diverge and forces the developer to
	 * explicitly run `vitest -u` to accept it. It does not prevent the shape from
	 * evolving; it makes the evolution a deliberate, reviewed act rather than a
	 * silent drift.
	 *
	 * Everything runs in a single Vitest process against an in-memory SQLite
	 * database, building on the Phase 4a infrastructure (`buildTestDb`).
	 */
	describe("canonical Node DTO snapshot", () =>
	{
		it("matches the snapshotted shape for a known fixture node", () =>
		{
			const {database, sqlite} = buildTestDb();
			const importedAt = new Date("2026-05-22T10:00:00Z");

			const imported = bulkImportWithWatermarkGuard(database, loadFixtureBackup("small-backup"), importedAt);
			expect(imported.skipped).toBe(false);

			const reader = new NodeReader(database);
			// The "Ship Phase 4" node carries every populated field: name, note,
			// created/modified/completed timestamps, a non-zero priority, and a
			// parent id — making it the most informative shape to snapshot.
			const node = reader.getById("33333333-3333-3333-3333-333333333333");
			if (node === null)
			{
				throw new Error("NodeReader returned null for the fixture node");
			}

			expect(node).toMatchSnapshot();

			sqlite.close();
		});
	});
});

describe("node label suggestions migration", () =>
{
	const migrationsFolder = path.join(import.meta.dirname, "../src/db/migrations");

	describe("node_label_suggestions migration", () =>
	{
		it("creates the temporal label-suggestion table with its key, live-row unique index, and closed-row partial index", () =>
		{
			const sqlite = new DatabaseConstructor(":memory:");
			try
			{
				migrate(
					drizzle(sqlite),
					{
						migrationsFolder,
					},
				);

				expect(
					{
						columns: sqlite
							.prepare(
								"SELECT name, type, \"notnull\", pk FROM pragma_table_info('node_label_suggestions') ORDER BY cid",
							)
							.all(),
						indexes: sqlite
							.prepare(
								"SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'node_label_suggestions' AND sql IS NOT NULL ORDER BY name",
							)
							.all(),
					},
				).toStrictEqual(
					{
						columns: [
							{
								name: "node_id",
								type: "TEXT",
								notnull: 1,
								pk: 1,
							},
							{
								name: "label",
								type: "TEXT",
								notnull: 1,
								pk: 2,
							},
							{
								name: "label_kind",
								type: "TEXT",
								notnull: 1,
								pk: 0,
							},
							{
								name: "source",
								type: "TEXT",
								notnull: 1,
								pk: 3,
							},
							{
								name: "score",
								type: "REAL",
								notnull: 1,
								pk: 0,
							},
							{
								name: "content_from",
								type: "TEXT",
								notnull: 1,
								pk: 0,
							},
							{
								name: "system_from",
								type: "TEXT",
								notnull: 1,
								pk: 4,
							},
							{
								name: "system_to",
								type: "TEXT",
								notnull: 1,
								pk: 0,
							},
						],
						indexes: [
							{
								name: "node_label_suggestions_closed_at_idx",
								sql: "CREATE INDEX `node_label_suggestions_closed_at_idx` ON `node_label_suggestions` (`system_to`) WHERE system_to < '9999-12-31 23:59:59'",
							},
							{
								name: "node_label_suggestions_system_to_idx",
								sql: "CREATE UNIQUE INDEX `node_label_suggestions_system_to_idx` ON `node_label_suggestions` (`node_id`,`label`,`source`,`system_to`)",
							},
						],
					},
				);
			}
			finally
			{
				sqlite.close();
			}
		});
	});
});

describe("node tags", () =>
{
	function node(id: string, name: string, note: string | null = null)
	{
		return {
			id,
			name,
			note,
			parent_id: null,
			priority: 100,
			createdAt: 1,
			modifiedAt: 1,
		};
	}

	function nodeTagRows(database: ReturnType<typeof buildTestDb>["database"])
	{
		return database.all<
		{
			node_id: string;
			tag_key: string;
			tag: string;
		}>(sql`SELECT node_id, tag_key, tag FROM node_tags ORDER BY node_id, tag_key`);
	}

	describe("node_tags", () =>
	{
		it("keeps each live item's distinct tags in step with every write, skipping #use-template tags", () =>
		{
			const {database, sqlite} = buildTestDb();
			const cache = new CacheService(database);

			cache.insertNode(node("a", "Alpha #Red #red <b>#Blue</b>", "#use-template:x @Pat"), null);
			cache.insertNode(node("b", "Beta #green"), null);
			const created = nodeTagRows(database);

			cache.insertNode(node("a", "Alpha #Blue"), null);
			const edited = nodeTagRows(database);

			cache.deleteNode("b");
			const deleted = nodeTagRows(database);

			sqlite.close();
			expect(
				{
					created,
					edited,
					deleted,
				},
			).toStrictEqual(
				{
					created: [
						{
							node_id: "a",
							tag_key: "#blue",
							tag: "#Blue",
						},
						{
							node_id: "a",
							tag_key: "#red",
							tag: "#Red",
						},
						{
							node_id: "a",
							tag_key: "@pat",
							tag: "@Pat",
						},
						{
							node_id: "b",
							tag_key: "#green",
							tag: "#green",
						},
					],
					edited: [
						{
							node_id: "a",
							tag_key: "#blue",
							tag: "#Blue",
						},
						{
							node_id: "b",
							tag_key: "#green",
							tag: "#green",
						},
					],
					deleted: [
						{
							node_id: "a",
							tag_key: "#blue",
							tag: "#Blue",
						},
					],
				},
			);
		});

		it("backfills an empty node_tags from the live tree, leaving closed versions out", () =>
		{
			const {database, sqlite} = buildTestDb();
			const at = "2026-01-01 00:00:00.000";
			database
				.insert(nodeContent)
				.values([
					{
						id: "live",
						name: "Live #kept",
						note: null,
						parentId: null,
						systemFrom: at,
						systemTo: FAR_FUTURE_DATE,
					},
					{
						id: "gone",
						name: "Gone #lost",
						note: null,
						parentId: null,
						systemFrom: at,
						systemTo: at,
					},
				])
				.run();

			ensureNodeTags(database);

			const rows = nodeTagRows(database);
			sqlite.close();
			expect(rows).toStrictEqual([
				{
					node_id: "live",
					tag_key: "#kept",
					tag: "#kept",
				},
			]);
		});
	});
});
