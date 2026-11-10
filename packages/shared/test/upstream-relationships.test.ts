import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {join} from "node:path";
import {afterEach, describe, expect, it} from "vite-plus/test";
import {CacheService} from "../src/cache/cache-service.js";
import {collectItemRelationships, emptyItemRelationships} from "../src/cache/item-relationships.js";
import * as schema from "../src/db/schema.js";
import {FAR_FUTURE_DATE} from "../src/temporal/index.js";

const migrationsFolder = join(import.meta.dirname, "../src/db/migrations");

const ORIGINAL = "original";
const MIRROR = "mirror1";
const TARGET = "target";
const REFS = "refs";
const ITEM = "item";
const PLAIN = "plain";

/** Each sample item's parent: the backlink item sits under the target's references root. */
const PARENTS: [id: string, parentId: string | null][] = [
	[ORIGINAL, null],
	[MIRROR, null],
	[TARGET, null],
	[REFS, TARGET],
	[ITEM, REFS],
	[PLAIN, null],
];

/** The upstream `/get_tree_data/` relationship shapes from the no-whole-tree-downloads plan. */
const SAMPLE_ITEMS: {id: string; metadata: Record<string, unknown>}[] = [
	{id: ORIGINAL, metadata: {mirror: {mirrorRootIds: {[MIRROR]: true}, backlinkMirrorRootIds: {[ITEM]: true}}}},
	{id: MIRROR, metadata: {mirror: {originalId: ORIGINAL, isMirrorRoot: true}}},
	{id: TARGET, metadata: {}},
	{id: REFS, metadata: {isReferencesRoot: true}},
	{
		id: ITEM,
		metadata: {
			mirror: {originalId: ORIGINAL, isMirrorRoot: true},
			backlink: {sourceID: ORIGINAL, targetID: TARGET},
		},
	},
	{id: PLAIN, metadata: {}},
];

describe("CacheService upstream relationship view", () => {
	let open: DatabaseConstructor.Database[] = [];
	afterEach(() => {
		for (const sqlite of open) {
			sqlite.close();
		}
		open = [];
	});

	function seeded() {
		const sqlite = new DatabaseConstructor(":memory:");
		open.push(sqlite);
		const db = drizzle(sqlite, {schema});
		migrate(db, {migrationsFolder});
		for (const [id, parentId] of PARENTS) {
			db.insert(schema.nodeContent)
				.values({id, name: "", parentId, systemFrom: "2026-01-01 00:00:00.000", systemTo: FAR_FUTURE_DATE})
				.run();
		}
		const cacheService = new CacheService(db);
		const relationships = emptyItemRelationships();
		for (const item of SAMPLE_ITEMS) {
			collectItemRelationships(relationships, item.id, item.metadata);
		}
		cacheService.recordRelationships(relationships);
		const count = (table: string) =>
			sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE system_to = '9999-12-31 23:59:59'`).get();
		return {cacheService, relationships, count};
	}

	it("rebuilds each node's upstream mirror, backlink and isReferencesRoot objects from mirrors and references roots", () => {
		const {cacheService} = seeded();

		expect(cacheService.relationshipMetadata(SAMPLE_ITEMS.map((item) => item.id))).toStrictEqual(
			new Map(SAMPLE_ITEMS.map((item) => [item.id, item.metadata])),
		);
	});

	it("records each relationship once, however often it is recorded or named from both sides", () => {
		const {cacheService, relationships, count} = seeded();

		cacheService.recordRelationships(relationships);

		expect({mirrors: count("mirrors"), referencesRoots: count("references_roots")}).toStrictEqual({
			mirrors: {n: 2},
			referencesRoots: {n: 1},
		});
	});

	it("leaves out relationships whose rows have ended", () => {
		const {cacheService} = seeded();

		cacheService.recordBacklinkSync({deleted: [ITEM], children: [], referencesRoots: [], backlinks: []});

		expect(cacheService.relationshipMetadata([ORIGINAL, ITEM])).toStrictEqual(
			new Map([
				[ORIGINAL, {mirror: {mirrorRootIds: {[MIRROR]: true}}}],
				[ITEM, {}],
			]),
		);
	});

	it("records a backlink item that carries only its backlink as a mirror of its source", () => {
		const relationships = emptyItemRelationships();

		collectItemRelationships(relationships, ITEM, {backlink: {sourceID: ORIGINAL, targetID: TARGET}});

		expect(relationships).toStrictEqual({
			mirrors: [{mirrorId: ITEM, originalId: ORIGINAL}],
			referencesRoots: [],
			aiMetadata: [],
		});
	});

	it("reads a mirror whose references root ended as a plain mirror", () => {
		const {cacheService} = seeded();
		cacheService.recordBacklinkSync({deleted: [REFS], children: [], referencesRoots: [], backlinks: []});

		expect(cacheService.relationshipMetadata([ORIGINAL, ITEM])).toStrictEqual(
			new Map([
				[ORIGINAL, {mirror: {mirrorRootIds: {[MIRROR]: true, [ITEM]: true}}}],
				[ITEM, {mirror: {originalId: ORIGINAL, isMirrorRoot: true}}],
			]),
		);
	});
});
