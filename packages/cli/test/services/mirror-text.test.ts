import {expect, describe, beforeEach, beforeAll, vi, it, afterEach, afterAll} from "vite-plus/test";
import {CacheService, NodeTreeReader, PathBuilder} from "@outlinedb/shared/cache";
import {nodeContent} from "@outlinedb/shared/db";
import {buildSearchConditions, parseSearchQuery} from "@outlinedb/shared/search";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import {and} from "drizzle-orm";
import {cleanupTestDatabase, createInMemoryTestDatabase, nodeFixtures, seedTestData} from "../db/migration-helper.js";
import type {TestDatabase} from "../db/migration-helper.js";
import {createTestNode} from "../helpers/node-fixtures.js";

const NOW = new Date("2026-01-01T12:00:00.000Z");
const SYSTEM_FROM = "2026-01-01 12:00:00.000";

/**
 * A mirror never has text of its own: Workflowy renders it with its original's
 * name and note. The REST API and backups can still return stale text stored on
 * the mirror node (left behind by old writes to the mirror id), so every reader
 * must ignore that text and use the original's.
 */
describe("mirror text comes from the original", () =>
{
	let testDatabase: TestDatabase;
	let cacheService: CacheService;

	beforeAll(() =>
	{
		testDatabase = createInMemoryTestDatabase();
		cacheService = new CacheService(testDatabase.db);
	});

	beforeEach(() =>
	{
		vi.useFakeTimers(
			{
				shouldAdvanceTime: true,
			},
		);
		vi.setSystemTime(NOW);
		seedTestData(
			testDatabase,
			{
				...nodeFixtures([
					createTestNode(
						{
							id: "p",
							name: "Parent",
							parentId: null,
							priority: 0,
						},
					),
					createTestNode(
						{
							id: "elsewhere",
							name: "Elsewhere",
							parentId: null,
							priority: 1,
						},
					),
					createTestNode(
						{
							id: "orig",
							name: "Original Name",
							note: "Original Note",
							parentId: "elsewhere",
						},
					),
					createTestNode(
						{
							id: "orig-child",
							name: "Original Child",
							parentId: "orig",
						},
					),
					// Stale text stored on the mirrors themselves, as the API and backups can return it.
					createTestNode(
						{
							id: "mir",
							name: "Stale mirror name",
							note: "Stale mirror note",
							parentId: "p",
							priority: 0,
						},
					),
					createTestNode(
						{
							id: "orphan",
							name: "Stale orphan name",
							parentId: "p",
							priority: 1,
						},
					),
				]),
				mirrors: [
					{
						originalId: "orig",
						mirrorId: "mir",
						systemFrom: SYSTEM_FROM,
						systemTo: FAR_FUTURE_DATE,
					},
					// The original of this mirror is not in the cache.
					{
						originalId: "missing",
						mirrorId: "orphan",
						systemFrom: SYSTEM_FROM,
						systemTo: FAR_FUTURE_DATE,
					},
				],
			},
		);
	});

	afterEach(() =>
	{
		vi.useRealTimers();
	});

	afterAll(() =>
	{
		cleanupTestDatabase(testDatabase);
	});

	const baseNode =
	{
		priority: 0,
		layoutMode: "bullets",
		createdAt: NOW,
		modifiedAt: NOW,
		completedAt: null,
		collapsed: false,
		systemFrom: SYSTEM_FROM,
		systemTo: FAR_FUTURE_DATE,
	};
	const mirrorNode =
	{
		...baseNode,
		id: "mir",
		shortId: "mir",
		parentId: "p",
		name: "Original Name",
		note: "Original Note",
		mirror:
		{
			isMirror: true,
			originalNodeId: "orig",
		},
	};
	const orphanNode =
	{
		...baseNode,
		id: "orphan",
		shortId: "orphan",
		parentId: "p",
		name: null,
		note: null,
		priority: 1,
		mirror:
		{
			isMirror: true,
			originalNodeId: "missing",
		},
	};

	it("NodeTreeReader ignores stale mirror text instead of throwing", async () =>
	{
		const trees = await new NodeTreeReader(cacheService).readChildren(
			"p",
			{
				depth: 1,
			},
		);

		expect(trees).toStrictEqual([
			{
				...mirrorNode,
				inChat: false,
				hasReferencesRoot: false,
				children: [
					{
						...baseNode,
						id: "orig-child",
						shortId: "origchild",
						parentId: "orig",
						name: "Original Child",
						note: null,
						mirror:
						{
							isMirror: false,
							originalNodeId: null,
						},
						inChat: false,
						hasReferencesRoot: false,
					},
				],
			},
			{
				...orphanNode,
				inChat: false,
				hasReferencesRoot: false,
			},
		]);
	});

	it("CacheService node reads use the original text", () =>
	{
		expect(
			{
				node: cacheService.getNode("mir"),
				children: cacheService.getChildren("p"),
				many: [...cacheService.getMultipleNodes(["mir", "orphan"]).entries()],
			},
		).toStrictEqual(
			{
				node: mirrorNode,
				children: [mirrorNode, orphanNode],
				many: [
					["mir", mirrorNode],
					["orphan", orphanNode],
				],
			},
		);
	});

	it("findNodeByPath matches a mirror by its original name and descends into the original", () =>
	{
		const node = cacheService.findNodeByPath(["Parent", "Original Name", "Original Child"]);

		expect(node?.id).toBe("orig-child");
	});

	it("PathBuilder uses the original text for paths, content, and children", () =>
	{
		const pathBuilder = new PathBuilder(testDatabase.db);

		expect(
			{
				path: pathBuilder.buildFullPath("mir"),
				content: pathBuilder.buildTextContentBatch(["mir", "orphan"]),
				children: pathBuilder.buildChildrenTextBatch(["p"]),
			},
		).toStrictEqual(
			{
				path: "Parent > Original Name",
				content: new Map([
					["mir", "Original Name\n\nOriginal Note"],
					["orphan", ""],
				]),
				children: new Map([["p", "Original Name: Original Note\n"]]),
			},
		);
	});

	it("text search never matches stale mirror text", () =>
	{
		expect(
			{
				stale: cacheService.searchText(
					{
						query: "Stale",
					},
				),
				original: cacheService.searchText(
					{
						query: "Original Name",
					},
				),
			},
		).toStrictEqual(
			{
				stale: [],
				original: [
					{
						id: "orig",
						name: "Original Name",
						note: "Original Note",
						shortId: "orig",
						completedAt: null,
					},
				],
			},
		);
	});

	it("web search conditions never match stale mirror text", () =>
	{
		const matchingIds = (query: string) =>
			testDatabase.db
				.select(
					{
						id: nodeContent.id,
					},
				)
				.from(nodeContent)
				.where(and(...buildSearchConditions(parseSearchQuery(query)).contentConditions))
				.all();

		expect(
			{
				stale: matchingIds("Stale"),
				original: matchingIds("Original Name"),
			},
		).toStrictEqual(
			{
				stale: [],
				original: [
					{
						id: "orig",
					},
				],
			},
		);
	});
});
