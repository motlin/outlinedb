import {and, eq} from "drizzle-orm";
import {describe, expect, it} from "vite-plus/test";
import {CacheService} from "../src/cache/cache-service.js";
import {upstreamRelationshipMetadata} from "../src/cache/item-relationships.js";
import {applyMirrorText, loadMirrorOriginals} from "../src/cache/mirror-text.js";
import {endNodeComposites, runUnitOfWork, withdrawNodeComposites} from "../src/cache/node-composite.js";
import {PathBuilder} from "../src/cache/path-builder.js";
import {ChangeDetector} from "../src/changes/change-detector.js";
import {mirrors, nodeContent} from "../src/db/schema.js";
import {FAR_FUTURE_DATE} from "../src/temporal/constants.js";
import {buildTestDb} from "./helpers/round-trip-helpers.js";

/** Durable Object SQLite rejects a statement with more than 100 bound parameters. */
const DURABLE_OBJECT_PARAMETER_CAP = 100;

/** More ids than one statement may bind on a Durable Object. */
const COUNT = 150;

const SEEDED = "2026-01-01 00:00:00.000";

const childIds = Array.from({length: COUNT}, (_, index) => `child-${String(index).padStart(3, "0")}`);
const mirrorIds = childIds.map((id) => `mirror-of-${id}`);

/**
 * A migrated in-memory cache seeded with `parent` holding {@link COUNT} children,
 * each mirrored once under `elsewhere`, whose statements fail past the Durable
 * Object's bound-parameter cap the way workerd does.
 */
function cappedDatabase() {
	const {database, sqlite} = buildTestDb();
	const live = {systemFrom: SEEDED, systemTo: FAR_FUTURE_DATE};
	database
		.insert(nodeContent)
		.values([
			{id: "parent", name: "Parent", note: null, parentId: null, ...live},
			{id: "elsewhere", name: "Elsewhere", note: null, parentId: null, ...live},
		])
		.run();
	for (const [index, id] of childIds.entries()) {
		database
			.insert(nodeContent)
			.values([
				{id, name: `Child ${index}`, note: `Note ${index}`, parentId: "parent", ...live},
				{id: mirrorIds[index] ?? "", name: null, note: null, parentId: "elsewhere", ...live},
			])
			.run();
		database
			.insert(mirrors)
			.values({mirrorId: mirrorIds[index] ?? "", originalId: id, ...live})
			.run();
	}
	const prepare = sqlite.prepare.bind(sqlite);
	sqlite.prepare = (source: string) => {
		const parameters = source.match(/\?/gu)?.length ?? 0;
		if (parameters > DURABLE_OBJECT_PARAMETER_CAP) {
			throw new Error(`too many SQL variables: ${parameters}`);
		}
		return prepare(source);
	};
	return database;
}

describe("id batches on a Durable Object's 100-bound-parameter cap", () => {
	it("ends more composites than the cap in one call, mirrors included", () => {
		const database = cappedDatabase();

		runUnitOfWork(database, (unitOfWork) => {
			endNodeComposites(unitOfWork, childIds);
		});

		const liveChildren = database
			.select({id: nodeContent.id})
			.from(nodeContent)
			.where(and(eq(nodeContent.parentId, "parent"), eq(nodeContent.systemTo, FAR_FUTURE_DATE)))
			.all();
		const liveMirrors = database
			.select({id: mirrors.mirrorId})
			.from(mirrors)
			.where(eq(mirrors.systemTo, FAR_FUTURE_DATE))
			.all();
		expect({liveChildren, liveMirrors}).toStrictEqual({liveChildren: [], liveMirrors: []});
	});

	it("withdraws more composites than the cap in one call", () => {
		const database = cappedDatabase();

		runUnitOfWork(database, (unitOfWork) => {
			withdrawNodeComposites(unitOfWork, mirrorIds);
		});

		const liveMirrors = database
			.select({id: mirrors.mirrorId})
			.from(mirrors)
			.where(eq(mirrors.systemTo, FAR_FUTURE_DATE))
			.all();
		expect(liveMirrors).toStrictEqual([]);
	});

	it("reads upstream relationship metadata for more ids than the cap", () => {
		const database = cappedDatabase();

		const metadata = upstreamRelationshipMetadata(database, mirrorIds);

		expect(metadata.get(mirrorIds[COUNT - 1] ?? "")).toStrictEqual({
			mirror: {originalId: childIds[COUNT - 1], isMirrorRoot: true},
		});
	});

	it("loads and applies mirror text for more mirrors than the cap", () => {
		const database = cappedDatabase();

		const originals = loadMirrorOriginals(database, mirrorIds);
		const rows = applyMirrorText(
			database,
			mirrorIds.map((id) => ({id, name: null, note: null})),
			originals,
		);

		expect({size: originals.size, last: rows.at(-1)}).toStrictEqual({
			size: COUNT,
			last: {id: mirrorIds[COUNT - 1], name: `Child ${COUNT - 1}`, note: `Note ${COUNT - 1}`},
		});
	});

	it("plans a subtree delete over more children than the cap", () => {
		const database = cappedDatabase();

		const subtree = new CacheService(database).getSubtreeMirrors("parent");

		expect(subtree.mirrorsOf.get(childIds[0] ?? "")).toStrictEqual([mirrorIds[0]]);
	});

	it("builds paths, text and leaf sets for more nodes than the cap", () => {
		const database = cappedDatabase();
		const pathBuilder = new PathBuilder(database);

		const paths = pathBuilder.buildFullPathsBatch(childIds);
		const texts = pathBuilder.buildTextContentBatch(childIds);
		const nonLeaf = pathBuilder.getNonLeafNodeIds([...childIds, "parent"]);
		const childrenText = pathBuilder.buildChildrenTextBatch([...childIds, "parent"]);

		expect({
			path: paths.get(childIds[0] ?? ""),
			text: texts.get(childIds[0] ?? ""),
			nonLeaf: [...nonLeaf],
			childrenTextLines: childrenText.get("parent")?.split("\n").length,
		}).toStrictEqual({
			path: "Parent > Child 0",
			text: "Child 0\n\nNote 0",
			nonLeaf: ["parent"],
			childrenTextLines: COUNT,
		});
	});

	it("detects changes across more mirrors than the cap", () => {
		const database = cappedDatabase();

		const {changes} = new ChangeDetector(database).detectChanges(new Date("2025-12-31T00:00:00.000Z"));

		expect(changes.find((change) => change.id === mirrorIds[COUNT - 1])).toStrictEqual({
			id: mirrorIds[COUNT - 1],
			isNew: true,
			isDeleted: false,
			contentChanged: false,
			parentChanged: false,
			completionChanged: false,
			noteChanged: false,
			oldName: null,
			oldNote: null,
			oldParentId: null,
			oldCompletedAt: null,
			currentName: `Child ${COUNT - 1}`,
			currentNote: `Note ${COUNT - 1}`,
			currentParentId: "elsewhere",
			currentCompletedAt: null,
			parentId: "elsewhere",
		});
	});
});
