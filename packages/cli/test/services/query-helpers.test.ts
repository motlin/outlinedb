import {beforeEach, afterEach, describe, expect, it} from "vite-plus/test";
import {nodeContent, nodeMetadata} from "@outlinedb/shared/db";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import {randomUUID} from "node:crypto";
import os from "node:os";
import path from "node:path";
import {QueryHelpers} from "../../src/services/query-helpers.js";
import {cleanupTestDatabase, createTestDatabase} from "../db/migration-helper.js";
import type {TestDatabase} from "../db/migration-helper.js";
import {createTestNode, getShortId, splitNodeIntoContentAndMetadata} from "../helpers/node-fixtures.js";
import {withoutSystemFrom} from "../helpers/assertion-helpers.js";

function insertTestNodes(
	db: ReturnType<typeof createTestDatabase>["db"],
	testNodes: ReturnType<typeof createTestNode>[],
) {
	const contents = testNodes.map((n) => splitNodeIntoContentAndMetadata(n).content);
	const metadatas = testNodes.map((n) => splitNodeIntoContentAndMetadata(n).metadata);
	db.insert(nodeContent).values(contents).run();
	db.insert(nodeMetadata).values(metadatas).run();
}

describe("QueryHelpers", () => {
	let testDatabase: TestDatabase;
	let queryHelpers: QueryHelpers;

	beforeEach(() => {
		const tempDbPath = path.join(os.tmpdir(), `test-outlinedb-${randomUUID()}.sqlite`);
		testDatabase = createTestDatabase(tempDbPath);

		queryHelpers = new QueryHelpers(testDatabase.db);
	});

	afterEach(() => {
		cleanupTestDatabase(testDatabase);
	});

	describe("getNodeById", () => {
		it("returns node when it exists", () => {
			insertTestNodes(testDatabase.db, [
				createTestNode({
					id: "test-node",
					name: "Test Node",
					note: "Test note",
					parentId: null,
					priority: 100,
					createdAt: new Date(1_700_000_000 * 1000),
					modifiedAt: new Date(1_700_001_000 * 1000),
					completedAt: null,
					layoutMode: "bullets",
				}),
			]);

			const node = queryHelpers.getNodeById("test-node");

			const actualSystemFrom = node!.systemFrom;

			expect(withoutSystemFrom(node)).toStrictEqual({
				id: "test-node",
				shortId: getShortId("test-node"),
				name: "Test Node",
				note: "Test note",
				parentId: null,
				priority: 100,
				createdAt: new Date(1_700_000_000 * 1000),
				modifiedAt: new Date(1_700_001_000 * 1000),
				completedAt: null,
				layoutMode: "bullets",
				collapsed: false,
				mirror: {isMirror: false, originalNodeId: null},
				systemTo: FAR_FUTURE_DATE,
			});

			// Verify systemFrom is a valid timestamp
			expect(actualSystemFrom).toBeTypeOf("string");
		});

		it("returns undefined for non-existent ID", () => {
			const node = queryHelpers.getNodeById("non-existent");
			expect(node).toBeUndefined();
		});
	});

	describe("getChildren", () => {
		beforeEach(() => {
			insertTestNodes(testDatabase.db, [
				createTestNode({id: "parent", name: "Parent", parentId: null}),
				createTestNode({id: "child-1", name: "Child 1", parentId: "parent", priority: 300}),
				createTestNode({id: "child-2", name: "Child 2", parentId: "parent", priority: 100}),
				createTestNode({id: "child-3", name: "Child 3", parentId: "parent", priority: 200}),
			]);
		});

		it("returns children ordered by priority when available", () => {
			const children = queryHelpers.getChildren("parent");

			expect(children.map(({id, priority}) => ({id, priority}))).toStrictEqual([
				{id: "child-2", priority: 100},
				{id: "child-3", priority: 200},
				{id: "child-1", priority: 300},
			]);
		});

		it("returns root nodes when parentId is null", () => {
			const roots = queryHelpers.getChildren(null);

			expect(roots.map((r) => r.id)).toStrictEqual(["parent"]);
		});

		it("returns empty array for parent with no children", () => {
			const children = queryHelpers.getChildren("child-1");
			expect(children).toStrictEqual([]);
		});

		it("maintains order when priority not available", () => {
			insertTestNodes(testDatabase.db, [
				createTestNode({id: "other-parent", name: "Other Parent", parentId: null, priority: null}),
				createTestNode({id: "other-child-1", name: "Other Child 1", parentId: "other-parent", priority: null}),
				createTestNode({id: "other-child-2", name: "Other Child 2", parentId: "other-parent", priority: null}),
			]);

			const children = queryHelpers.getChildren("other-parent");

			// The canonical Node defaults a missing DB priority to 0.
			expect(children.map(({id, priority}) => ({id, priority}))).toStrictEqual([
				{id: "other-child-1", priority: 0},
				{id: "other-child-2", priority: 0},
			]);
		});
	});

	describe("getCompletedTasks", () => {
		it("returns only completed tasks ordered by completion time", () => {
			insertTestNodes(testDatabase.db, [
				createTestNode({
					id: "task-1",
					name: "Completed Task 1",
					parentId: null,
					createdAt: new Date(1_700_000_000 * 1000),
					modifiedAt: new Date(1_700_001_000 * 1000),
					completedAt: new Date(1_700_002_000 * 1000),
				}),
				createTestNode({
					id: "task-2",
					name: "Incomplete Task",
					parentId: null,
					createdAt: new Date(1_700_000_000 * 1000),
					modifiedAt: new Date(1_700_001_000 * 1000),
					completedAt: null,
				}),
				createTestNode({
					id: "task-3",
					name: "Completed Task 2",
					parentId: null,
					createdAt: new Date(1_700_000_000 * 1000),
					modifiedAt: new Date(1_700_001_000 * 1000),
					completedAt: new Date(1_700_001_500 * 1000),
				}),
			]);

			const completed = queryHelpers.getCompletedTasks();

			// Verify ordering: task-3 completed earlier (1_700_001_500), task-1 completed later (1_700_002_000)
			expect(completed.map((c) => c.id)).toStrictEqual(["task-3", "task-1"]);
		});

		it("returns empty array when no completed tasks exist", () => {
			insertTestNodes(testDatabase.db, [
				createTestNode({
					id: "incomplete",
					name: "Incomplete",
					parentId: null,
					completedAt: null,
				}),
			]);

			const completed = queryHelpers.getCompletedTasks();
			expect(completed).toStrictEqual([]);
		});
	});

	describe("findNodeByPath", () => {
		beforeEach(() => {
			insertTestNodes(testDatabase.db, [
				createTestNode({id: "work", name: "<span>Work</span>", parentId: null}),
				createTestNode({id: "journal", name: "Journal", parentId: "work"}),
				createTestNode({id: "archive", name: '<span class="colored">Archive</span>', parentId: "journal"}),
				createTestNode({id: "personal", name: "Personal", parentId: null}),
			]);
		});

		it("finds node by path from root", () => {
			const node = queryHelpers.findNodeByPath(["Work", "Journal", "Archive"]);

			// Verify node identity and that name contains Archive with HTML tags
			expect(node!.id).toBe("archive");
			expect(node!.name).toBe('<span class="colored">Archive</span>');
		});

		it("finds node with HTML tags in name", () => {
			const node = queryHelpers.findNodeByPath(["Work"]);

			expect(node!.id).toBe("work");
			expect(node!.name).toBe("<span>Work</span>");
		});

		it("returns undefined for non-existent path", () => {
			const node = queryHelpers.findNodeByPath(["Work", "NonExistent"]);
			expect(node).toBeUndefined();
		});

		it("returns undefined for empty path", () => {
			const node = queryHelpers.findNodeByPath([]);
			expect(node).toBeUndefined();
		});

		it("finds node from specified root", () => {
			const node = queryHelpers.findNodeByPath(["Journal", "Archive"], "work");

			expect(node!.id).toBe("archive");
		});

		it("finds root-level node", () => {
			const node = queryHelpers.findNodeByPath(["Personal"]);

			expect(node!.id).toBe("personal");
		});
	});
});
