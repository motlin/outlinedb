import DatabaseConstructor from "better-sqlite3";
import {and, eq} from "drizzle-orm";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {join} from "node:path";
import {describe, expect, it} from "vite-plus/test";
import {runUnitOfWork} from "../src/cache/node-composite.js";
import {countStrandedRows, endStrandedBacklinkItems} from "../src/cache/stranded-relationships.js";
import * as schema from "../src/db/schema.js";
import {mirrors, nodeContent, nodeMetadata, referencesRoots} from "../src/db/schema.js";
import {FAR_FUTURE_DATE} from "../src/temporal/constants.js";

const migrationsFolder = join(import.meta.dirname, "../src/db/migrations");
const SEEDED = "2026-01-01 00:00:00.000";
const DELETED = "2026-03-01 00:00:00.000";

/*
 * target
 *   refs             (references root)
 *     item-live      (backlink item of source, which is current)
 *     item-stranded  (backlink item whose original, gone, was deleted with its mirror row)
 *     item-dangling  (backlink item whose mirror row is current but names gone, a deleted node)
 * source
 * gone              (deleted)
 * refs-gone         (deleted, its references_roots row still current)
 */
function setup() {
	const sqlite = new DatabaseConstructor(":memory:");
	const db = drizzle(sqlite, {schema});
	migrate(db, {migrationsFolder});
	const nodes: [id: string, parentId: string | null, systemTo: string][] = [
		["target", null, FAR_FUTURE_DATE],
		["refs", "target", FAR_FUTURE_DATE],
		["item-live", "refs", FAR_FUTURE_DATE],
		["item-stranded", "refs", FAR_FUTURE_DATE],
		["item-dangling", "refs", FAR_FUTURE_DATE],
		["source", null, FAR_FUTURE_DATE],
		["gone", null, DELETED],
		["refs-gone", "target", DELETED],
	];
	for (const [id, parentId, systemTo] of nodes) {
		db.insert(nodeContent).values({id, name: id, note: null, parentId, systemFrom: SEEDED, systemTo}).run();
		db.insert(nodeMetadata).values({nodeId: id, priority: 0, systemFrom: SEEDED, systemTo}).run();
	}
	db.insert(referencesRoots)
		.values([
			{nodeId: "refs", systemFrom: SEEDED, systemTo: FAR_FUTURE_DATE},
			{nodeId: "refs-gone", systemFrom: SEEDED, systemTo: FAR_FUTURE_DATE},
		])
		.run();
	db.insert(mirrors)
		.values([
			{mirrorId: "item-live", originalId: "source", systemFrom: SEEDED, systemTo: FAR_FUTURE_DATE},
			{mirrorId: "item-stranded", originalId: "gone", systemFrom: SEEDED, systemTo: DELETED},
			{mirrorId: "item-dangling", originalId: "gone", systemFrom: SEEDED, systemTo: FAR_FUTURE_DATE},
		])
		.run();
	return db;
}

describe("stranded relationship rows", () => {
	it("counts backlink items without a current original, and mirror and references root rows without a current node", () => {
		const db = setup();

		expect(countStrandedRows(db)).toStrictEqual({backlinkItems: 2, mirrors: 1, referencesRoots: 1});
	});

	it("ends each stranded backlink item's composite, leaving none", () => {
		const db = setup();
		const UOW_TIME = "2026-06-01 12:00:00.000";

		const ended = runUnitOfWork(db, endStrandedBacklinkItems, {systemTime: UOW_TIME, startedAt: Date.now()});

		expect({
			ended,
			counts: countStrandedRows(db),
			currentUnderRefs: db
				.select({id: nodeContent.id})
				.from(nodeContent)
				.where(and(eq(nodeContent.parentId, "refs"), eq(nodeContent.systemTo, FAR_FUTURE_DATE)))
				.all(),
			endedItems: db
				.select({id: nodeContent.id, systemTo: nodeContent.systemTo})
				.from(nodeContent)
				.where(eq(nodeContent.systemTo, UOW_TIME))
				.orderBy(nodeContent.id)
				.all(),
		}).toStrictEqual({
			ended: ["item-dangling", "item-stranded"],
			counts: {backlinkItems: 0, mirrors: 0, referencesRoots: 1},
			currentUnderRefs: [{id: "item-live"}],
			endedItems: [
				{id: "item-dangling", systemTo: UOW_TIME},
				{id: "item-stranded", systemTo: UOW_TIME},
			],
		});
	});

	it("withdraws a stranded backlink item the same unit of work inserted, since it never existed", () => {
		const db = setup();
		const UOW_TIME = "2026-06-01 12:00:00.000";

		const ended = runUnitOfWork(
			db,
			(unitOfWork) => {
				const temporal = {systemFrom: UOW_TIME, systemTo: FAR_FUTURE_DATE};
				unitOfWork.tx
					.insert(nodeContent)
					.values({id: "item-new", name: "", note: null, parentId: "refs", ...temporal})
					.run();
				unitOfWork.tx
					.insert(nodeMetadata)
					.values({nodeId: "item-new", priority: 3, ...temporal})
					.run();
				return endStrandedBacklinkItems(unitOfWork);
			},
			{systemTime: UOW_TIME, startedAt: Date.now()},
		);

		expect({
			ended,
			itemNew: [
				...db.select({id: nodeContent.id}).from(nodeContent).where(eq(nodeContent.id, "item-new")).all(),
				...db
					.select({id: nodeMetadata.nodeId})
					.from(nodeMetadata)
					.where(eq(nodeMetadata.nodeId, "item-new"))
					.all(),
			],
		}).toStrictEqual({ended: ["item-dangling", "item-new", "item-stranded"], itemNew: []});
	});
});
