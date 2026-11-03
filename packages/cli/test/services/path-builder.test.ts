import {beforeEach, beforeAll, afterAll, describe, expect, it} from "vite-plus/test";
import {PathBuilder} from "@workflowy/shared/cache";
import {cleanupTestDatabase, createInMemoryTestDatabase, nodeFixtures, seedTestData} from "../db/migration-helper.js";
import type {TestDatabase} from "../db/migration-helper.js";
import {createTestNode} from "../helpers/node-fixtures.js";

describe("PathBuilder", () => {
	let testDatabase: TestDatabase;
	let pathBuilder: PathBuilder;

	// An in-memory database still replays every migration, so build one for the
	// whole file. Seeding clears every table first, which keeps each test starting
	// from an empty database.
	beforeAll(() => {
		testDatabase = createInMemoryTestDatabase();
		pathBuilder = new PathBuilder(testDatabase.db);
	});

	beforeEach(() => {
		seedTestData(testDatabase, {});
	});

	afterAll(() => {
		cleanupTestDatabase(testDatabase);
	});

	describe("buildFullPathsBatch", () => {
		it("returns empty map for empty input", () => {
			const result = pathBuilder.buildFullPathsBatch([]);
			expect(result.size).toBe(0);
		});

		it("builds path for single root node", () => {
			seedTestData(testDatabase, nodeFixtures([createTestNode({id: "root-id", name: "Root", parentId: null})]));

			const result = pathBuilder.buildFullPathsBatch(["root-id"]);

			expect(result.get("root-id")).toBe("Root");
		});

		it("builds path for nested node", () => {
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode({id: "root-id", name: "Root", parentId: null}),
					createTestNode({id: "child-id", name: "Child", parentId: "root-id"}),
					createTestNode({id: "grandchild-id", name: "Grandchild", parentId: "child-id"}),
				]),
			);

			const result = pathBuilder.buildFullPathsBatch(["grandchild-id"]);

			expect(result.get("grandchild-id")).toBe("Root > Child > Grandchild");
		});

		it("builds paths for multiple nodes at different depths", () => {
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode({id: "root-id", name: "Root", parentId: null}),
					createTestNode({id: "child-id", name: "Child", parentId: "root-id"}),
					createTestNode({id: "grandchild-id", name: "Grandchild", parentId: "child-id"}),
				]),
			);

			const result = pathBuilder.buildFullPathsBatch(["root-id", "child-id", "grandchild-id"]);

			expect(result.get("root-id")).toBe("Root");
			expect(result.get("child-id")).toBe("Root > Child");
			expect(result.get("grandchild-id")).toBe("Root > Child > Grandchild");
		});

		it("stops the path where a stale cache's parent chain loops back on itself", () => {
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode({id: "a-id", name: "A", parentId: "b-id"}),
					createTestNode({id: "b-id", name: "B", parentId: "a-id"}),
					createTestNode({id: "leaf-id", name: "Leaf", parentId: "a-id"}),
				]),
			);

			const result = pathBuilder.buildFullPathsBatch(["leaf-id"]);

			expect(result).toStrictEqual(new Map([["leaf-id", "B > A > Leaf"]]));
		});

		it("handles nodes that share ancestors", () => {
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode({id: "root-id", name: "Root", parentId: null}),
					createTestNode({id: "parent-id", name: "Parent", parentId: "root-id"}),
					createTestNode({id: "sibling-1", name: "Sibling One", parentId: "parent-id"}),
					createTestNode({id: "sibling-2", name: "Sibling Two", parentId: "parent-id"}),
				]),
			);

			const result = pathBuilder.buildFullPathsBatch(["sibling-1", "sibling-2"]);

			expect(result.get("sibling-1")).toBe("Root > Parent > Sibling One");
			expect(result.get("sibling-2")).toBe("Root > Parent > Sibling Two");
		});

		it("skips nodes with empty names in path", () => {
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode({id: "root-id", name: "Root", parentId: null}),
					createTestNode({id: "unnamed-id", name: "", parentId: "root-id"}),
					createTestNode({id: "child-id", name: "Child", parentId: "unnamed-id"}),
				]),
			);

			const result = pathBuilder.buildFullPathsBatch(["child-id"]);

			expect(result.get("child-id")).toBe("Root > Child");
		});

		it("returns empty string for non-existent node", () => {
			const result = pathBuilder.buildFullPathsBatch(["non-existent-id"]);

			expect(result.get("non-existent-id")).toBe("");
		});

		it("strips HTML tags from node names", () => {
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode({id: "root-id", name: "<b>Bold Root</b>", parentId: null}),
					createTestNode({id: "child-id", name: "<time>Jan 1</time> Event", parentId: "root-id"}),
				]),
			);

			const result = pathBuilder.buildFullPathsBatch(["child-id"]);

			expect(result.get("child-id")).toBe("Bold Root > Jan 1 Event");
		});
	});

	describe("buildTextContentBatch", () => {
		it("returns empty map for empty input", () => {
			const result = pathBuilder.buildTextContentBatch([]);
			expect(result.size).toBe(0);
		});

		it("returns name only when no note", () => {
			seedTestData(testDatabase, nodeFixtures([createTestNode({id: "node-id", name: "Test Node", note: null})]));

			const result = pathBuilder.buildTextContentBatch(["node-id"]);

			expect(result.get("node-id")).toBe("Test Node");
		});

		it("returns name and note when both present", () => {
			seedTestData(
				testDatabase,
				nodeFixtures([createTestNode({id: "node-id", name: "Test Node", note: "This is a note"})]),
			);

			const result = pathBuilder.buildTextContentBatch(["node-id"]);

			expect(result.get("node-id")).toBe("Test Node\n\nThis is a note");
		});

		it("strips HTML from name and note", () => {
			seedTestData(
				testDatabase,
				nodeFixtures([createTestNode({id: "node-id", name: "<b>Bold</b> Name", note: "<i>Italic</i> note"})]),
			);

			const result = pathBuilder.buildTextContentBatch(["node-id"]);

			expect(result.get("node-id")).toBe("Bold Name\n\nItalic note");
		});

		it("handles multiple nodes", () => {
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode({id: "node-1", name: "First", note: "Note 1"}),
					createTestNode({id: "node-2", name: "Second", note: null}),
				]),
			);

			const result = pathBuilder.buildTextContentBatch(["node-1", "node-2"]);

			expect(result.get("node-1")).toBe("First\n\nNote 1");
			expect(result.get("node-2")).toBe("Second");
		});
	});

	describe("buildFullPath (single node)", () => {
		it("delegates to batch method", () => {
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode({id: "root-id", name: "Root", parentId: null}),
					createTestNode({id: "child-id", name: "Child", parentId: "root-id"}),
				]),
			);

			const result = pathBuilder.buildFullPath("child-id");

			expect(result).toBe("Root > Child");
		});
	});

	describe("buildTextContent (single node)", () => {
		it("delegates to batch method", () => {
			seedTestData(testDatabase, nodeFixtures([createTestNode({id: "node-id", name: "Name", note: "Note"})]));

			const result = pathBuilder.buildTextContent("node-id");

			expect(result).toBe("Name\n\nNote");
		});
	});

	describe("getNonLeafNodeIds", () => {
		it("returns empty set for empty input", () => {
			const result = pathBuilder.getNonLeafNodeIds([]);
			expect(result.size).toBe(0);
		});

		it("returns empty set when all nodes are leaf nodes", () => {
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode({id: "leaf-1", name: "Leaf 1", parentId: null}),
					createTestNode({id: "leaf-2", name: "Leaf 2", parentId: null}),
				]),
			);

			const result = pathBuilder.getNonLeafNodeIds(["leaf-1", "leaf-2"]);

			expect(result.size).toBe(0);
		});

		it("identifies parent nodes with children", () => {
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode({id: "parent-id", name: "Parent", parentId: null}),
					createTestNode({id: "child-id", name: "Child", parentId: "parent-id"}),
				]),
			);

			const result = pathBuilder.getNonLeafNodeIds(["parent-id", "child-id"]);

			expect(result).toStrictEqual(new Set(["parent-id"]));
		});

		it("handles deep hierarchy", () => {
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode({id: "root-id", name: "Root", parentId: null}),
					createTestNode({id: "middle-id", name: "Middle", parentId: "root-id"}),
					createTestNode({id: "leaf-id", name: "Leaf", parentId: "middle-id"}),
				]),
			);

			const result = pathBuilder.getNonLeafNodeIds(["root-id", "middle-id", "leaf-id"]);

			expect(result).toStrictEqual(new Set(["middle-id", "root-id"]));
		});

		it("handles multiple children under same parent", () => {
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode({id: "parent-id", name: "Parent", parentId: null}),
					createTestNode({id: "child-1", name: "Child 1", parentId: "parent-id"}),
					createTestNode({id: "child-2", name: "Child 2", parentId: "parent-id"}),
				]),
			);

			const result = pathBuilder.getNonLeafNodeIds(["parent-id", "child-1", "child-2"]);

			expect(result).toStrictEqual(new Set(["parent-id"]));
		});
	});

	describe("buildChildrenTextBatch", () => {
		it("returns empty map for empty input", () => {
			const result = pathBuilder.buildChildrenTextBatch([]);
			expect(result.size).toBe(0);
		});

		it("returns empty map for nodes without children", () => {
			seedTestData(testDatabase, nodeFixtures([createTestNode({id: "leaf-id", name: "Leaf", parentId: null})]));

			const result = pathBuilder.buildChildrenTextBatch(["leaf-id"]);

			expect(result.size).toBe(0);
		});

		it("returns children text for parent node", () => {
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode({id: "parent-id", name: "Parent", parentId: null}),
					createTestNode({id: "child-1", name: "First Child", parentId: "parent-id"}),
					createTestNode({id: "child-2", name: "Second Child", parentId: "parent-id"}),
				]),
			);

			const result = pathBuilder.buildChildrenTextBatch(["parent-id"]);

			expect(result.get("parent-id")).toBe("First Child\nSecond Child");
		});

		it("includes child notes in text", () => {
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode({id: "parent-id", name: "Parent", parentId: null}),
					createTestNode({id: "child-id", name: "Child Name", note: "Child Note", parentId: "parent-id"}),
				]),
			);

			const result = pathBuilder.buildChildrenTextBatch(["parent-id"]);

			expect(result.get("parent-id")).toBe("Child Name: Child Note");
		});

		it("strips HTML from children text", () => {
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode({id: "parent-id", name: "Parent", parentId: null}),
					createTestNode({
						id: "child-id",
						name: "<b>Bold Child</b>",
						note: "<i>Italic note</i>",
						parentId: "parent-id",
					}),
				]),
			);

			const result = pathBuilder.buildChildrenTextBatch(["parent-id"]);

			expect(result.get("parent-id")).toBe("Bold Child: Italic note");
		});

		it("only includes direct children, not grandchildren", () => {
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode({id: "grandparent-id", name: "Grandparent", parentId: null}),
					createTestNode({id: "parent-id", name: "Parent", parentId: "grandparent-id"}),
					createTestNode({id: "child-id", name: "Child", parentId: "parent-id"}),
				]),
			);

			const result = pathBuilder.buildChildrenTextBatch(["grandparent-id"]);

			expect(result.get("grandparent-id")).toBe("Parent");
		});

		it("handles multiple parents in one batch", () => {
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode({id: "parent-1", name: "Parent 1", parentId: null}),
					createTestNode({id: "parent-2", name: "Parent 2", parentId: null}),
					createTestNode({id: "child-1a", name: "Child 1A", parentId: "parent-1"}),
					createTestNode({id: "child-2a", name: "Child 2A", parentId: "parent-2"}),
				]),
			);

			const result = pathBuilder.buildChildrenTextBatch(["parent-1", "parent-2"]);

			expect(result.get("parent-1")).toBe("Child 1A");
			expect(result.get("parent-2")).toBe("Child 2A");
		});
	});
});
