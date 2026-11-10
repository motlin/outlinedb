import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import DatabaseConstructor from "better-sqlite3";
import {and, asc, eq, inArray, isNull} from "drizzle-orm";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {join} from "node:path";
import {LocalTreeWriter} from "../src/cache/local-tree-writer.js";
import * as schema from "../src/db/schema.js";
import {mirrors, nodeContent, nodeMetadata} from "../src/db/schema.js";
import {FAR_FUTURE_DATE} from "../src/temporal/constants.js";

const migrationsFolder = join(import.meta.dirname, "../src/db/migrations");
const SEEDED_AT = "2026-01-01 00:00:00.000";
const SEEDED = new Date("2026-01-01T00:00:00.000Z");
const NOW = "2026-03-01 00:00:00.000";
const NOW_DATE = new Date("2026-03-01T00:00:00.000Z");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

type Seed = [id: string, parentId: string | null, priority: number][];

/**
 * Home holds p and q; p holds a, b and c; c holds c1; q holds x. m, under q, mirrors c1. Every row is current since
 * SEEDED_AT, with priorities already 0..n-1.
 */
const SEED: Seed = [
	["p", null, 0],
	["q", null, 1],
	["a", "p", 0],
	["b", "p", 1],
	["c", "p", 2],
	["c1", "c", 0],
	["x", "q", 0],
	["m", "q", 1],
];

function setup() {
	const sqlite = new DatabaseConstructor(":memory:");
	const database = drizzle(sqlite, {schema});
	migrate(database, {migrationsFolder});
	database
		.insert(nodeContent)
		.values(
			SEED.map(([id, parentId]) => ({
				id,
				name: id === "m" ? null : id,
				note: null,
				parentId,
				systemFrom: SEEDED_AT,
				systemTo: FAR_FUTURE_DATE,
			})),
		)
		.run();
	database
		.insert(nodeMetadata)
		.values(
			SEED.map(([id, , priority]) => ({
				nodeId: id,
				priority,
				createdAt: SEEDED,
				modifiedAt: SEEDED,
				systemFrom: SEEDED_AT,
				systemTo: FAR_FUTURE_DATE,
			})),
		)
		.run();
	database
		.insert(mirrors)
		.values({mirrorId: "m", originalId: "c1", systemFrom: SEEDED_AT, systemTo: FAR_FUTURE_DATE})
		.run();

	const writer = new LocalTreeWriter(database);

	/** A parent's current children (Home's for null) in sort order, with their priority. */
	const siblings = (parentId: string | null) =>
		database
			.select({id: nodeContent.id, name: nodeContent.name, priority: nodeMetadata.priority})
			.from(nodeContent)
			.innerJoin(
				nodeMetadata,
				and(eq(nodeMetadata.nodeId, nodeContent.id), eq(nodeMetadata.systemTo, FAR_FUTURE_DATE)),
			)
			.where(
				and(
					parentId === null ? isNull(nodeContent.parentId) : eq(nodeContent.parentId, parentId),
					eq(nodeContent.systemTo, FAR_FUTURE_DATE),
				),
			)
			.orderBy(asc(nodeMetadata.priority))
			.all();

	/** Every node_metadata version, closed ones included, of `ids`. */
	const metadataVersions = (ids: string[]) =>
		database
			.select({
				nodeId: nodeMetadata.nodeId,
				priority: nodeMetadata.priority,
				createdAt: nodeMetadata.createdAt,
				modifiedAt: nodeMetadata.modifiedAt,
				completedAt: nodeMetadata.completedAt,
				layoutMode: nodeMetadata.layoutMode,
				systemFrom: nodeMetadata.systemFrom,
				systemTo: nodeMetadata.systemTo,
			})
			.from(nodeMetadata)
			.where(inArray(nodeMetadata.nodeId, ids))
			.orderBy(asc(nodeMetadata.nodeId), asc(nodeMetadata.systemFrom))
			.all();

	/** Every node_content version, closed ones included, of `ids`. */
	const contentVersions = (ids: string[]) =>
		database
			.select()
			.from(nodeContent)
			.where(inArray(nodeContent.id, ids))
			.orderBy(asc(nodeContent.id), asc(nodeContent.systemFrom))
			.all();

	const mirrorVersions = () => database.select().from(mirrors).all();

	return {writer, siblings, metadataVersions, contentVersions, mirrorVersions};
}

/** A metadata version a seeded node keeps, or the one it ends at `NOW`. */
function seeded(nodeId: string, priority: number, systemTo = FAR_FUTURE_DATE) {
	return {
		nodeId,
		priority,
		createdAt: SEEDED,
		modifiedAt: SEEDED,
		completedAt: null,
		layoutMode: null,
		systemFrom: SEEDED_AT,
		systemTo,
	};
}

/** The version a seeded node opens at `NOW` with only its priority changed. */
function renumbered(nodeId: string, priority: number) {
	return {...seeded(nodeId, priority), systemFrom: NOW};
}

describe("LocalTreeWriter", () => {
	beforeEach(() => {
		vi.useFakeTimers({toFake: ["Date"], now: NOW_DATE});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("creates a node at the top with the client's id, renumbering every sibling below it", () => {
		const {writer, siblings, metadataVersions, contentVersions} = setup();

		const result = writer.createAt({parentId: "p", index: 0, id: "n", name: "new", note: "a note"});

		expect({
			result,
			siblings: siblings("p"),
			metadata: metadataVersions(["a", "b", "c", "n"]),
			content: contentVersions(["n"]),
		}).toStrictEqual({
			result: {id: "n"},
			siblings: [
				{id: "n", name: "new", priority: 0},
				{id: "a", name: "a", priority: 1},
				{id: "b", name: "b", priority: 2},
				{id: "c", name: "c", priority: 3},
			],
			metadata: [
				seeded("a", 0, NOW),
				renumbered("a", 1),
				seeded("b", 1, NOW),
				renumbered("b", 2),
				seeded("c", 2, NOW),
				renumbered("c", 3),
				{
					nodeId: "n",
					priority: 0,
					createdAt: NOW_DATE,
					modifiedAt: NOW_DATE,
					completedAt: null,
					layoutMode: null,
					systemFrom: NOW,
					systemTo: FAR_FUTURE_DATE,
				},
			],
			content: [
				{id: "n", name: "new", note: "a note", parentId: "p", systemFrom: NOW, systemTo: FAR_FUTURE_DATE},
			],
		});
	});

	it("creates a node in the middle by index, renumbering only the siblings after it", () => {
		const {writer, siblings, metadataVersions} = setup();

		writer.createAt({parentId: "p", index: 1, id: "n", name: "new"});

		expect({siblings: siblings("p"), metadata: metadataVersions(["a", "b", "c"])}).toStrictEqual({
			siblings: [
				{id: "a", name: "a", priority: 0},
				{id: "n", name: "new", priority: 1},
				{id: "b", name: "b", priority: 2},
				{id: "c", name: "c", priority: 3},
			],
			metadata: [
				seeded("a", 0),
				seeded("b", 1, NOW),
				renumbered("b", 2),
				seeded("c", 2, NOW),
				renumbered("c", 3),
			],
		});
	});

	it("creates a node right after afterId, which wins over index while it is a live sibling", () => {
		const {writer, siblings} = setup();

		writer.createAt({parentId: "p", afterId: "b", index: 0, id: "n", name: "new"});

		expect(siblings("p")).toStrictEqual([
			{id: "a", name: "a", priority: 0},
			{id: "b", name: "b", priority: 1},
			{id: "n", name: "new", priority: 2},
			{id: "c", name: "c", priority: 3},
		]);
	});

	it("creates a node at the bottom by default with a generated id, writing no sibling", () => {
		const {writer, siblings, metadataVersions} = setup();

		const {id} = writer.createAt({parentId: null, name: "new"});

		expect({
			id: UUID.test(id),
			siblings: siblings(null),
			metadata: metadataVersions(["p", "q"]),
		}).toStrictEqual({
			id: true,
			siblings: [
				{id: "p", name: "p", priority: 0},
				{id: "q", name: "q", priority: 1},
				{id, name: "new", priority: 2},
			],
			metadata: [seeded("p", 0), seeded("q", 1)],
		});
	});

	it("edits a node's name and note, closing the old content version and touching modifiedAt", () => {
		const {writer, contentVersions, metadataVersions} = setup();

		writer.updateNode("a", {name: "renamed", note: "noted"});

		expect({content: contentVersions(["a"]), metadata: metadataVersions(["a"])}).toStrictEqual({
			content: [
				{id: "a", name: "a", note: null, parentId: "p", systemFrom: SEEDED_AT, systemTo: NOW},
				{id: "a", name: "renamed", note: "noted", parentId: "p", systemFrom: NOW, systemTo: FAR_FUTURE_DATE},
			],
			metadata: [seeded("a", 0, NOW), {...renumbered("a", 0), modifiedAt: NOW_DATE}],
		});
	});

	it("writes a mirror's edit and completion to its original", () => {
		const {writer, contentVersions, metadataVersions} = setup();

		writer.updateNode("m", {name: "via mirror"});
		vi.setSystemTime(new Date("2026-03-01T00:00:01.000Z"));
		writer.completeNode("m");

		const later = new Date("2026-03-01T00:00:01.000Z");
		expect({content: contentVersions(["c1", "m"]), metadata: metadataVersions(["c1", "m"])}).toStrictEqual({
			content: [
				{id: "c1", name: "c1", note: null, parentId: "c", systemFrom: SEEDED_AT, systemTo: NOW},
				{id: "c1", name: "via mirror", note: null, parentId: "c", systemFrom: NOW, systemTo: FAR_FUTURE_DATE},
				{id: "m", name: null, note: null, parentId: "q", systemFrom: SEEDED_AT, systemTo: FAR_FUTURE_DATE},
			],
			metadata: [
				seeded("c1", 0, NOW),
				{...renumbered("c1", 0), modifiedAt: NOW_DATE, systemTo: "2026-03-01 00:00:01.000"},
				{
					...seeded("c1", 0),
					modifiedAt: later,
					completedAt: later,
					systemFrom: "2026-03-01 00:00:01.000",
				},
				seeded("m", 1),
			],
		});
	});

	it("completes and uncompletes a node, keeping every version", () => {
		const {writer, metadataVersions} = setup();

		writer.completeNode("a");
		const later = new Date("2026-03-02T00:00:00.000Z");
		vi.setSystemTime(later);
		writer.uncompleteNode("a");

		expect(metadataVersions(["a"])).toStrictEqual([
			seeded("a", 0, NOW),
			{...renumbered("a", 0), modifiedAt: NOW_DATE, completedAt: NOW_DATE, systemTo: "2026-03-02 00:00:00.000"},
			{...seeded("a", 0), modifiedAt: later, systemFrom: "2026-03-02 00:00:00.000"},
		]);
	});

	it("moves a node down within its parent, counting the slot before removal", () => {
		const {writer, siblings, metadataVersions, contentVersions} = setup();

		writer.moveTo({ids: ["a"], parentId: "p", index: 3});

		expect({
			siblings: siblings("p"),
			metadata: metadataVersions(["a", "b", "c"]),
			content: contentVersions(["a"]),
		}).toStrictEqual({
			siblings: [
				{id: "b", name: "b", priority: 0},
				{id: "c", name: "c", priority: 1},
				{id: "a", name: "a", priority: 2},
			],
			metadata: [
				seeded("a", 0, NOW),
				{...renumbered("a", 2), modifiedAt: NOW_DATE},
				seeded("b", 1, NOW),
				renumbered("b", 0),
				seeded("c", 2, NOW),
				renumbered("c", 1),
			],
			content: [
				{id: "a", name: "a", note: null, parentId: "p", systemFrom: SEEDED_AT, systemTo: FAR_FUTURE_DATE},
			],
		});
	});

	it("moves a node across parents, renumbering both parents' children", () => {
		const {writer, siblings, metadataVersions, contentVersions} = setup();

		writer.moveTo({ids: ["b"], parentId: "q", index: 0});

		expect({
			p: siblings("p"),
			q: siblings("q"),
			metadata: metadataVersions(["b", "c", "x", "m"]),
			content: contentVersions(["b"]),
		}).toStrictEqual({
			p: [
				{id: "a", name: "a", priority: 0},
				{id: "c", name: "c", priority: 1},
			],
			q: [
				{id: "b", name: "b", priority: 0},
				{id: "x", name: "x", priority: 1},
				{id: "m", name: null, priority: 2},
			],
			metadata: [
				seeded("b", 1, NOW),
				{...renumbered("b", 0), modifiedAt: NOW_DATE},
				seeded("c", 2, NOW),
				renumbered("c", 1),
				seeded("m", 1, NOW),
				renumbered("m", 2),
				seeded("x", 0, NOW),
				renumbered("x", 1),
			],
			content: [
				{id: "b", name: "b", note: null, parentId: "p", systemFrom: SEEDED_AT, systemTo: NOW},
				{id: "b", name: "b", note: null, parentId: "q", systemFrom: NOW, systemTo: FAR_FUTURE_DATE},
			],
		});
	});

	it("moves several blocks in one unit of work, each planned against the outline the earlier ones leave", () => {
		const {writer, siblings} = setup();

		writer.moveBlocks([
			{ids: ["a", "c"], parentId: "q"},
			{ids: ["x"], parentId: "q"},
		]);

		expect({p: siblings("p"), q: siblings("q")}).toStrictEqual({
			p: [{id: "b", name: "b", priority: 0}],
			q: [
				{id: "m", name: null, priority: 0},
				{id: "a", name: "a", priority: 1},
				{id: "c", name: "c", priority: 2},
				{id: "x", name: "x", priority: 3},
			],
		});
	});

	it("refuses to move a node under itself", () => {
		const {writer} = setup();

		expect(() => {
			writer.moveTo({ids: ["p"], parentId: "c1"});
		}).toThrow("Cannot move p under its own subtree");
	});

	it("deletes a subtree, closing its rows and mirror rows, and renumbers the remaining siblings", () => {
		const {writer, siblings, metadataVersions, contentVersions, mirrorVersions} = setup();

		writer.deleteNode("b");
		vi.setSystemTime(new Date("2026-03-02T00:00:00.000Z"));
		writer.deleteNode("c");

		expect({
			siblings: siblings("p"),
			metadata: metadataVersions(["b", "c", "c1"]),
			content: contentVersions(["c1"]),
			mirrors: mirrorVersions(),
		}).toStrictEqual({
			siblings: [{id: "a", name: "a", priority: 0}],
			metadata: [
				seeded("b", 1, NOW),
				seeded("c", 2, NOW),
				{...renumbered("c", 1), systemTo: "2026-03-02 00:00:00.000"},
				seeded("c1", 0, "2026-03-02 00:00:00.000"),
			],
			content: [
				{
					id: "c1",
					name: "c1",
					note: null,
					parentId: "c",
					systemFrom: SEEDED_AT,
					systemTo: "2026-03-02 00:00:00.000",
				},
			],
			mirrors: [{mirrorId: "m", originalId: "c1", systemFrom: SEEDED_AT, systemTo: "2026-03-02 00:00:00.000"}],
		});
	});
});
