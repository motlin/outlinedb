import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import DatabaseConstructor from "better-sqlite3";
import {and, asc, eq, inArray, isNull} from "drizzle-orm";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {join} from "node:path";
import {AccountNotProvisionedError} from "../src/cache/account-store.js";
import {provisionLocalAccount} from "../src/cache/local-account.js";
import {LocalTreeWriter} from "../src/cache/local-tree-writer.js";
import * as schema from "../src/db/schema.js";
import
{
	mirrors,
	nodeContent,
	nodeDisplayMetadata,
	nodeMetadata,
	nodeTableCellSizes,
	rootPreferences,
} from "../src/db/schema.js";
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

function setup()
{
	const sqlite = new DatabaseConstructor(":memory:");
	const database = drizzle(
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
	database
		.insert(nodeContent)
		.values(
			SEED.map(([id, parentId]) => (
			{
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
			SEED.map(([id, , priority]) => (
			{
				nodeId: id,
				orderKey: `a${priority}`,
				createdAt: SEEDED,
				modifiedAt: SEEDED,
				systemFrom: SEEDED_AT,
				systemTo: FAR_FUTURE_DATE,
			})),
		)
		.run();
	database
		.insert(mirrors)
		.values(
			{
				mirrorId: "m",
				originalId: "c1",
				systemFrom: SEEDED_AT,
				systemTo: FAR_FUTURE_DATE,
			},
		)
		.run();

	const writer = new LocalTreeWriter(database);

	/** A parent's current children (Home's for null) in sibling order, with their order key. */
	const siblings = (parentId: string | null) =>
		database
			.select(
				{
					id: nodeContent.id,
					name: nodeContent.name,
					orderKey: nodeMetadata.orderKey,
				},
			)
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
			.orderBy(asc(nodeMetadata.orderKey), asc(nodeMetadata.createdAt), asc(nodeContent.id))
			.all();

	/** Every node_metadata version, closed ones included, of `ids`. */
	const metadataVersions = (ids: string[]) =>
		database
			.select(
				{
					nodeId: nodeMetadata.nodeId,
					orderKey: nodeMetadata.orderKey,
					createdAt: nodeMetadata.createdAt,
					modifiedAt: nodeMetadata.modifiedAt,
					completedAt: nodeMetadata.completedAt,
					layoutMode: nodeMetadata.layoutMode,
					systemFrom: nodeMetadata.systemFrom,
					systemTo: nodeMetadata.systemTo,
				},
			)
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

	const displayVersions = () =>
		database.select().from(nodeDisplayMetadata).orderBy(asc(nodeDisplayMetadata.systemFrom)).all();

	const cellSizeVersions = () => database.select().from(nodeTableCellSizes).all();

	const homeLayoutVersions = () =>
		database
			.select(
				{
					userId: rootPreferences.userId,
					homeLayoutMode: rootPreferences.homeLayoutMode,
					systemFrom: rootPreferences.systemFrom,
					systemTo: rootPreferences.systemTo,
				},
			)
			.from(rootPreferences)
			.orderBy(asc(rootPreferences.systemFrom))
			.all();

	return {
		database,
		writer,
		siblings,
		metadataVersions,
		contentVersions,
		mirrorVersions,
		displayVersions,
		cellSizeVersions,
		homeLayoutVersions,
	};
}

/** A metadata version a seeded node keeps, or the one it ends at `NOW`, keyed as the integer key of its seed position. */
function seeded(nodeId: string, priority: number, systemTo = FAR_FUTURE_DATE)
{
	return {
		nodeId,
		orderKey: `a${priority}`,
		createdAt: SEEDED,
		modifiedAt: SEEDED,
		completedAt: null,
		layoutMode: null,
		systemFrom: SEEDED_AT,
		systemTo,
	};
}

/** The version a seeded node opens at `NOW`, before the changes a test spreads over it. */
function reversioned(nodeId: string, priority: number)
{
	return {
		...seeded(nodeId, priority),
		systemFrom: NOW,
	};
}

describe("LocalTreeWriter", () =>
{
	beforeEach(() =>
	{
		vi.useFakeTimers(
			{
				toFake: ["Date"],
				now: NOW_DATE,
			},
		);
	});

	afterEach(() =>
	{
		vi.useRealTimers();
	});

	it("creates a node at the top with the client's id and a key before its first sibling, writing no sibling", () =>
	{
		const {writer, siblings, metadataVersions, contentVersions} = setup();

		const result = writer.createAt(
			{
				parentId: "p",
				index: 0,
				id: "n",
				name: "new",
				note: "a note",
			},
		);

		expect(
			{
				result,
				siblings: siblings("p"),
				metadata: metadataVersions(["a", "b", "c", "n"]),
				content: contentVersions(["n"]),
			},
		).toStrictEqual(
			{
				result:
				{
					id: "n",
				},
				siblings: [
					{
						id: "n",
						name: "new",
						orderKey: "Zz",
					},
					{
						id: "a",
						name: "a",
						orderKey: "a0",
					},
					{
						id: "b",
						name: "b",
						orderKey: "a1",
					},
					{
						id: "c",
						name: "c",
						orderKey: "a2",
					},
				],
				metadata: [
					seeded("a", 0),
					seeded("b", 1),
					seeded("c", 2),
					{
						nodeId: "n",
						orderKey: "Zz",
						createdAt: NOW_DATE,
						modifiedAt: NOW_DATE,
						completedAt: null,
						layoutMode: null,
						systemFrom: NOW,
						systemTo: FAR_FUTURE_DATE,
					},
				],
				content: [
					{
						id: "n",
						name: "new",
						note: "a note",
						parentId: "p",
						systemFrom: NOW,
						systemTo: FAR_FUTURE_DATE,
					},
				],
			},
		);
	});

	it("creates a node in the middle by index with a key between its neighbours, writing no sibling", () =>
	{
		const {writer, siblings, metadataVersions} = setup();

		writer.createAt(
			{
				parentId: "p",
				index: 1,
				id: "n",
				name: "new",
			},
		);

		expect(
			{
				siblings: siblings("p"),
				metadata: metadataVersions(["a", "b", "c"]),
			},
		).toStrictEqual(
			{
				siblings: [
					{
						id: "a",
						name: "a",
						orderKey: "a0",
					},
					{
						id: "n",
						name: "new",
						orderKey: "a0V",
					},
					{
						id: "b",
						name: "b",
						orderKey: "a1",
					},
					{
						id: "c",
						name: "c",
						orderKey: "a2",
					},
				],
				metadata: [seeded("a", 0), seeded("b", 1), seeded("c", 2)],
			},
		);
	});

	it("creates a node between siblings with tied keys, rekeying only the tied sibling after the slot", () =>
	{
		const {database, writer, siblings, metadataVersions} = setup();
		// b ties a's key, so created_at and then id put it after a.
		database
			.update(nodeMetadata)
			.set(
				{
					orderKey: "a0",
				},
			)
			.where(eq(nodeMetadata.nodeId, "b"))
			.run();

		writer.createAt(
			{
				parentId: "p",
				index: 1,
				id: "n",
				name: "new",
			},
		);

		expect(
			{
				siblings: siblings("p"),
				metadata: metadataVersions(["a", "b", "c"]),
			},
		).toStrictEqual(
			{
				siblings: [
					{
						id: "a",
						name: "a",
						orderKey: "a0",
					},
					{
						id: "n",
						name: "new",
						orderKey: "a0V",
					},
					{
						id: "b",
						name: "b",
						orderKey: "a1",
					},
					{
						id: "c",
						name: "c",
						orderKey: "a2",
					},
				],
				metadata: [
					seeded("a", 0),
					seeded("b", 0, NOW),
					{
						...reversioned("b", 0),
						orderKey: "a1",
					},
					seeded("c", 2),
				],
			},
		);
	});

	it("creates a node right after afterId, which wins over index while it is a live sibling", () =>
	{
		const {writer, siblings} = setup();

		writer.createAt(
			{
				parentId: "p",
				afterId: "b",
				index: 0,
				id: "n",
				name: "new",
			},
		);

		expect(siblings("p")).toStrictEqual([
			{
				id: "a",
				name: "a",
				orderKey: "a0",
			},
			{
				id: "b",
				name: "b",
				orderKey: "a1",
			},
			{
				id: "n",
				name: "new",
				orderKey: "a1V",
			},
			{
				id: "c",
				name: "c",
				orderKey: "a2",
			},
		]);
	});

	it("creates a node at the bottom by default with a generated id, writing no sibling", () =>
	{
		const {writer, siblings, metadataVersions} = setup();

		const {id} = writer.createAt(
			{
				parentId: null,
				name: "new",
			},
		);

		expect(
			{
				id: UUID.test(id),
				siblings: siblings(null),
				metadata: metadataVersions(["p", "q"]),
			},
		).toStrictEqual(
			{
				id: true,
				siblings: [
					{
						id: "p",
						name: "p",
						orderKey: "a0",
					},
					{
						id: "q",
						name: "q",
						orderKey: "a1",
					},
					{
						id: id,
						name: "new",
						orderKey: "a2",
					},
				],
				metadata: [seeded("p", 0), seeded("q", 1)],
			},
		);
	});

	it("edits a node's name and note, closing the old content version and touching modifiedAt", () =>
	{
		const {writer, contentVersions, metadataVersions} = setup();

		writer.updateNode(
			"a",
			{
				name: "renamed",
				note: "noted",
			},
		);

		expect(
			{
				content: contentVersions(["a"]),
				metadata: metadataVersions(["a"]),
			},
		).toStrictEqual(
			{
				content: [
					{
						id: "a",
						name: "a",
						note: null,
						parentId: "p",
						systemFrom: SEEDED_AT,
						systemTo: NOW,
					},
					{
						id: "a",
						name: "renamed",
						note: "noted",
						parentId: "p",
						systemFrom: NOW,
						systemTo: FAR_FUTURE_DATE,
					},
				],
				metadata: [
					seeded("a", 0, NOW),
					{
						...reversioned("a", 0),
						modifiedAt: NOW_DATE,
					},
				],
			},
		);
	});

	it("writes a mirror's edit and completion to its original", () =>
	{
		const {writer, contentVersions, metadataVersions} = setup();

		writer.updateNode(
			"m",
			{
				name: "via mirror",
			},
		);
		vi.setSystemTime(new Date("2026-03-01T00:00:01.000Z"));
		writer.completeNode("m");

		const later = new Date("2026-03-01T00:00:01.000Z");
		expect(
			{
				content: contentVersions(["c1", "m"]),
				metadata: metadataVersions(["c1", "m"]),
			},
		).toStrictEqual(
			{
				content: [
					{
						id: "c1",
						name: "c1",
						note: null,
						parentId: "c",
						systemFrom: SEEDED_AT,
						systemTo: NOW,
					},
					{
						id: "c1",
						name: "via mirror",
						note: null,
						parentId: "c",
						systemFrom: NOW,
						systemTo: FAR_FUTURE_DATE,
					},
					{
						id: "m",
						name: null,
						note: null,
						parentId: "q",
						systemFrom: SEEDED_AT,
						systemTo: FAR_FUTURE_DATE,
					},
				],
				metadata: [
					seeded("c1", 0, NOW),
					{
						...reversioned("c1", 0),
						modifiedAt: NOW_DATE,
						systemTo: "2026-03-01 00:00:01.000",
					},
					{
						...seeded("c1", 0),
						modifiedAt: later,
						completedAt: later,
						systemFrom: "2026-03-01 00:00:01.000",
					},
					seeded("m", 1),
				],
			},
		);
	});

	it("completes and uncompletes a node, keeping every version", () =>
	{
		const {writer, metadataVersions} = setup();

		writer.completeNode("a");
		const later = new Date("2026-03-02T00:00:00.000Z");
		vi.setSystemTime(later);
		writer.uncompleteNode("a");

		expect(metadataVersions(["a"])).toStrictEqual([
			seeded("a", 0, NOW),
			{
				...reversioned("a", 0),
				modifiedAt: NOW_DATE,
				completedAt: NOW_DATE,
				systemTo: "2026-03-02 00:00:00.000",
			},
			{
				...seeded("a", 0),
				modifiedAt: later,
				systemFrom: "2026-03-02 00:00:00.000",
			},
		]);
	});

	it("moves a node down within its parent, counting the slot before removal", () =>
	{
		const {writer, siblings, metadataVersions, contentVersions} = setup();

		writer.moveTo(
			{
				ids: ["a"],
				parentId: "p",
				index: 3,
			},
		);

		expect(
			{
				siblings: siblings("p"),
				metadata: metadataVersions(["a", "b", "c"]),
				content: contentVersions(["a"]),
			},
		).toStrictEqual(
			{
				siblings: [
					{
						id: "b",
						name: "b",
						orderKey: "a1",
					},
					{
						id: "c",
						name: "c",
						orderKey: "a2",
					},
					{
						id: "a",
						name: "a",
						orderKey: "a3",
					},
				],
				metadata: [
					seeded("a", 0, NOW),
					{
						...reversioned("a", 0),
						orderKey: "a3",
						modifiedAt: NOW_DATE,
					},
					seeded("b", 1),
					seeded("c", 2),
				],
				content: [
					{
						id: "a",
						name: "a",
						note: null,
						parentId: "p",
						systemFrom: SEEDED_AT,
						systemTo: FAR_FUTURE_DATE,
					},
				],
			},
		);
	});

	it("moves a node across parents with a key before its new first sibling, writing no sibling in either parent", () =>
	{
		const {writer, siblings, metadataVersions, contentVersions} = setup();

		writer.moveTo(
			{
				ids: ["b"],
				parentId: "q",
				index: 0,
			},
		);

		expect(
			{
				p: siblings("p"),
				q: siblings("q"),
				metadata: metadataVersions(["b", "c", "x", "m"]),
				content: contentVersions(["b"]),
			},
		).toStrictEqual(
			{
				p: [
					{
						id: "a",
						name: "a",
						orderKey: "a0",
					},
					{
						id: "c",
						name: "c",
						orderKey: "a2",
					},
				],
				q: [
					{
						id: "b",
						name: "b",
						orderKey: "Zz",
					},
					{
						id: "x",
						name: "x",
						orderKey: "a0",
					},
					{
						id: "m",
						name: null,
						orderKey: "a1",
					},
				],
				metadata: [
					seeded("b", 1, NOW),
					{
						...reversioned("b", 1),
						orderKey: "Zz",
						modifiedAt: NOW_DATE,
					},
					seeded("c", 2),
					seeded("m", 1),
					seeded("x", 0),
				],
				content: [
					{
						id: "b",
						name: "b",
						note: null,
						parentId: "p",
						systemFrom: SEEDED_AT,
						systemTo: NOW,
					},
					{
						id: "b",
						name: "b",
						note: null,
						parentId: "q",
						systemFrom: NOW,
						systemTo: FAR_FUTURE_DATE,
					},
				],
			},
		);
	});

	it("moves several blocks in one unit of work, each planned against the outline the earlier ones leave", () =>
	{
		const {writer, siblings} = setup();

		writer.moveBlocks([
			{
				ids: ["a", "c"],
				parentId: "q",
			},
			{
				ids: ["x"],
				parentId: "q",
			},
		]);

		expect(
			{
				p: siblings("p"),
				q: siblings("q"),
			},
		).toStrictEqual(
			{
				p: [
					{
						id: "b",
						name: "b",
						orderKey: "a1",
					},
				],
				q: [
					{
						id: "m",
						name: null,
						orderKey: "a1",
					},
					{
						id: "a",
						name: "a",
						orderKey: "a2",
					},
					{
						id: "c",
						name: "c",
						orderKey: "a3",
					},
					{
						id: "x",
						name: "x",
						orderKey: "a4",
					},
				],
			},
		);
	});

	it("refuses to move a node under itself", () =>
	{
		const {writer} = setup();

		expect(() =>
		{
			writer.moveTo(
				{
					ids: ["p"],
					parentId: "c1",
				},
			);
		}).toThrow("Cannot move p under its own subtree");
	});

	it("deletes a subtree, closing its rows and mirror rows, and leaves the remaining siblings' keys alone", () =>
	{
		const {writer, siblings, metadataVersions, contentVersions, mirrorVersions} = setup();

		writer.deleteNode("b");
		vi.setSystemTime(new Date("2026-03-02T00:00:00.000Z"));
		writer.deleteNode("c");

		expect(
			{
				siblings: siblings("p"),
				metadata: metadataVersions(["b", "c", "c1"]),
				content: contentVersions(["c1"]),
				mirrors: mirrorVersions(),
			},
		).toStrictEqual(
			{
				siblings: [
					{
						id: "a",
						name: "a",
						orderKey: "a0",
					},
				],
				metadata: [
					seeded("b", 1, NOW),
					seeded("c", 2, "2026-03-02 00:00:00.000"),
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
				mirrors: [
					{
						mirrorId: "m",
						originalId: "c1",
						systemFrom: SEEDED_AT,
						systemTo: "2026-03-02 00:00:00.000",
					},
				],
			},
		);
	});

	it("creates a forest of trees at one slot with notes, completion, metadata, children and child mirrors", () =>
	{
		const {writer, siblings, metadataVersions, contentVersions, mirrorVersions, displayVersions} = setup();

		const result = writer.createTreesAt(
			{
				parentId: "p",
				afterId: "a",
				index: 0,
				trees: [
					{
						id: "t1",
						name: "t1",
						note: "a note",
						completed: true,
						metadata:
						{
							layoutMode: "board",
							numbered_start: 3,
						},
						children: [
							{
								id: "t2",
								name: "t2",
							},
							{
								id: "t3",
								name: "",
								metadata:
								{
									mirror:
									{
										originalId: "x",
										isMirrorRoot: true,
									},
								},
							},
						],
					},
					{
						name: "t4",
					},
				],
			},
		);
		const [, t4 = ""] = result.ids;
		const created = (nodeId: string, orderKey: string, extra: object = {}) => (
		{
			nodeId,
			orderKey,
			createdAt: NOW_DATE,
			modifiedAt: NOW_DATE,
			completedAt: null,
			layoutMode: null,
			systemFrom: NOW,
			systemTo: FAR_FUTURE_DATE,
			...extra,
		});

		expect(
			{
				result,
				t4: UUID.test(t4),
				siblings: siblings("p"),
				children: siblings("t1"),
				metadata: metadataVersions(["t1", "t2", "t3", t4]),
				content: contentVersions(["t1", "t3"]),
				mirrors: mirrorVersions(),
				display: displayVersions(),
			},
		).toStrictEqual(
			{
				result:
				{
					ids: ["t1", t4],
				},
				t4: true,
				siblings: [
					{
						id: "a",
						name: "a",
						orderKey: "a0",
					},
					{
						id: "t1",
						name: "t1",
						orderKey: "a0G",
					},
					{
						id: t4,
						name: "t4",
						orderKey: "a0V",
					},
					{
						id: "b",
						name: "b",
						orderKey: "a1",
					},
					{
						id: "c",
						name: "c",
						orderKey: "a2",
					},
				],
				children: [
					{
						id: "t2",
						name: "t2",
						orderKey: "a0",
					},
					{
						id: "t3",
						name: "",
						orderKey: "a1",
					},
				],
				metadata: [
					created(
						"t1",
						"a0G",
						{
							completedAt: NOW_DATE,
							layoutMode: "board",
						},
					),
					created("t2", "a0"),
					created("t3", "a1"),
					created(t4, "a0V"),
				].toSorted((left, right) => left.nodeId.localeCompare(right.nodeId)),
				content: [
					{
						id: "t1",
						name: "t1",
						note: "a note",
						parentId: "p",
						systemFrom: NOW,
						systemTo: FAR_FUTURE_DATE,
					},
					{
						id: "t3",
						name: "",
						note: null,
						parentId: "t1",
						systemFrom: NOW,
						systemTo: FAR_FUTURE_DATE,
					},
				],
				mirrors: [
					{
						mirrorId: "m",
						originalId: "c1",
						systemFrom: SEEDED_AT,
						systemTo: FAR_FUTURE_DATE,
					},
					{
						mirrorId: "t3",
						originalId: "x",
						systemFrom: NOW,
						systemTo: FAR_FUTURE_DATE,
					},
				],
				display: [
					{
						nodeId: "t1",
						numberedStart: 3,
						restorableUniqueNode: null,
						tableHeaders: null,
						tableSkipHeaders: null,
						tableBg: null,
						priorityDefaultToBottom: null,
						systemFrom: NOW,
						systemTo: FAR_FUTURE_DATE,
					},
				],
			},
		);
	});

	it("sets a node's metadata values in the typed tables and removes a key for an undefined value", () =>
	{
		const {writer, metadataVersions, displayVersions, cellSizeVersions} = setup();
		const LATER = "2026-03-02 00:00:00.000";
		const LATER_DATE = new Date("2026-03-02T00:00:00.000Z");

		writer.setNodeMetaValues("a", [
			{
				path: ["layoutMode"],
				value: "numbered",
			},
			{
				path: ["numbered_start"],
				value: 5,
			},
			{
				path: ["priority", "defaultToBottom"],
				value: true,
			},
			{
				path: ["table", "sizes", "c1"],
				value: 200,
			},
		]);
		vi.setSystemTime(LATER_DATE);
		writer.setNodeMetaValues("a", [
			{
				path: ["numbered_start"],
				value: undefined,
			},
		]);

		const display =
		{
			nodeId: "a",
			numberedStart: 5,
			restorableUniqueNode: null,
			tableHeaders: null,
			tableSkipHeaders: null,
			tableBg: null,
			priorityDefaultToBottom: 1,
		};
		expect(
			{
				metadata: metadataVersions(["a"]),
				display: displayVersions(),
				sizes: cellSizeVersions(),
			},
		).toStrictEqual(
			{
				metadata: [
					seeded("a", 0, NOW),
					{
						...reversioned("a", 0),
						modifiedAt: NOW_DATE,
						layoutMode: "numbered",
						systemTo: LATER,
					},
					{
						...reversioned("a", 0),
						modifiedAt: LATER_DATE,
						layoutMode: "numbered",
						systemFrom: LATER,
					},
				],
				display: [
					{
						...display,
						systemFrom: NOW,
						systemTo: LATER,
					},
					{
						...display,
						numberedStart: null,
						systemFrom: LATER,
						systemTo: FAR_FUTURE_DATE,
					},
				],
				sizes: [
					{
						nodeId: "a",
						cellId: "c1",
						size: 200,
						systemFrom: NOW,
						systemTo: FAR_FUTURE_DATE,
					},
				],
			},
		);
	});

	it("sets Home's layout in the root preferences", () =>
	{
		const {database, writer, homeLayoutVersions} = setup();
		const LATER = "2026-03-02 00:00:00.000";
		provisionLocalAccount(
			database,
			{
				userId: "user-a",
				email: "a@example.com",
				joinedAt: new Date(0),
			},
		);

		writer.setNodeMetaValues("home", [
			{
				path: ["layoutMode"],
				value: "board",
			},
		]);
		vi.setSystemTime(new Date("2026-03-02T00:00:00.000Z"));
		writer.setNodeMetaValues("home", [
			{
				path: ["layoutMode"],
				value: undefined,
			},
		]);

		expect(homeLayoutVersions()).toStrictEqual([
			{
				userId: "user-a",
				homeLayoutMode: "board",
				systemFrom: NOW,
				systemTo: LATER,
			},
			{
				userId: "user-a",
				homeLayoutMode: null,
				systemFrom: LATER,
				systemTo: FAR_FUTURE_DATE,
			},
		]);
	});

	it("refuses Home's layout when no account row exists, rather than inventing a user id", () =>
	{
		const {writer} = setup();

		expect(() =>
		{
			writer.setNodeMetaValues("home", [
				{
					path: ["layoutMode"],
					value: "board",
				},
			]);
		}).toThrow(new AccountNotProvisionedError());
	});

	it("restores a deleted subtree where it was, from its last closed versions under the original ids", () =>
	{
		const {writer, siblings, metadataVersions, contentVersions, mirrorVersions} = setup();
		const LATER = "2026-03-02 00:00:00.000";

		writer.deleteNode("c");
		vi.setSystemTime(new Date("2026-03-02T00:00:00.000Z"));
		const restored = writer.restoreNode(
			{
				id: "c",
			},
		);

		expect(
			{
				restored,
				siblings: siblings("p"),
				metadata: metadataVersions(["c", "c1"]),
				content: contentVersions(["c1"]),
				mirrors: mirrorVersions(),
			},
		).toStrictEqual(
			{
				restored: true,
				siblings: [
					{
						id: "a",
						name: "a",
						orderKey: "a0",
					},
					{
						id: "b",
						name: "b",
						orderKey: "a1",
					},
					{
						id: "c",
						name: "c",
						orderKey: "a2",
					},
				],
				metadata: [
					seeded("c", 2, NOW),
					{
						...seeded("c", 2),
						systemFrom: LATER,
					},
					seeded("c1", 0, NOW),
					{
						...seeded("c1", 0),
						systemFrom: LATER,
					},
				],
				content: [
					{
						id: "c1",
						name: "c1",
						note: null,
						parentId: "c",
						systemFrom: SEEDED_AT,
						systemTo: NOW,
					},
					{
						id: "c1",
						name: "c1",
						note: null,
						parentId: "c",
						systemFrom: LATER,
						systemTo: FAR_FUTURE_DATE,
					},
				],
				mirrors: [
					{
						mirrorId: "m",
						originalId: "c1",
						systemFrom: SEEDED_AT,
						systemTo: NOW,
					},
					{
						mirrorId: "m",
						originalId: "c1",
						systemFrom: LATER,
						systemTo: FAR_FUTURE_DATE,
					},
				],
			},
		);
	});

	it("restores a deleted node at a requested parent and slot, and refuses a live or unknown node", () =>
	{
		const {writer, siblings} = setup();

		writer.deleteNode("b");
		vi.setSystemTime(new Date("2026-03-02T00:00:00.000Z"));
		const restored = writer.restoreNode(
			{
				id: "b",
				parentId: "q",
				index: 0,
			},
		);

		expect(
			{
				restored,
				unknown: writer.restoreNode(
					{
						id: "nope",
					},
				),
				p: siblings("p"),
				q: siblings("q"),
			},
		).toStrictEqual(
			{
				restored: true,
				unknown: false,
				p: [
					{
						id: "a",
						name: "a",
						orderKey: "a0",
					},
					{
						id: "c",
						name: "c",
						orderKey: "a2",
					},
				],
				q: [
					{
						id: "b",
						name: "b",
						orderKey: "Zz",
					},
					{
						id: "x",
						name: "x",
						orderKey: "a0",
					},
					{
						id: "m",
						name: null,
						orderKey: "a1",
					},
				],
			},
		);
		expect(() =>
			writer.restoreNode(
				{
					id: "a",
				},
			),
		).toThrow("Node a is not deleted");
	});
});
