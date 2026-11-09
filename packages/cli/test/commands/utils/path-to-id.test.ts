import {it, afterEach, expect, describe, beforeEach} from "vite-plus/test";
import {nodeContent, nodeMetadata} from "@outlinedb/shared/db";
import {captureOutput} from "@oclif/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import PathToId from "../../../src/commands/utils/path-to-id.js";
import {cleanupTestDatabase, createTestDatabase} from "../../db/migration-helper.js";
import type {TestDatabase} from "../../db/migration-helper.js";
import {createTestNode, splitNodeIntoContentAndMetadata} from "../../helpers/node-fixtures.js";

function insertTestNodes(
	db: ReturnType<typeof createTestDatabase>["db"],
	testNodes: ReturnType<typeof createTestNode>[],
) {
	const contents = testNodes.map((n) => splitNodeIntoContentAndMetadata(n).content);
	const metadatas = testNodes.map((n) => splitNodeIntoContentAndMetadata(n).metadata);
	db.insert(nodeContent).values(contents).run();
	db.insert(nodeMetadata).values(metadatas).run();
}

describe("utils:path-to-id command", () => {
	let originalEnv: typeof process.env;
	let mockFetch: typeof globalThis.fetch;
	let tempDir: string;
	let testDatabase: TestDatabase;

	beforeEach(() => {
		originalEnv = process.env;
		mockFetch = globalThis.fetch;

		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "outlinedb-test-"));
		const testDbPath = path.join(tempDir, "test.sqlite");
		testDatabase = createTestDatabase(testDbPath);
		process.env.OUTLINEDB_DB_PATH = testDbPath;

		testDatabase.db.run("PRAGMA foreign_keys = OFF");
		testDatabase.db.delete(nodeContent).run();
		testDatabase.db.delete(nodeMetadata).run();
		testDatabase.db.run("PRAGMA foreign_keys = ON");
	});

	afterEach(() => {
		process.env = originalEnv;
		globalThis.fetch = mockFetch;

		cleanupTestDatabase(testDatabase);

		if (fs.existsSync(tempDir)) {
			try {
				if (fs.existsSync(testDatabase.path)) {
					fs.unlinkSync(testDatabase.path);
				}
				fs.rmdirSync(tempDir);
			} catch {
				// Ignore cleanup errors
			}
		}
	});

	describe("command metadata", () => {
		it("has correct description", () => {
			expect(PathToId.description).toBe("Resolve a Workflowy path to a node ID");
		});

		it("has correct flag configuration", () => {
			expect({
				path: {
					char: PathToId.flags.path.char,
					required: PathToId.flags.path.required,
				},
				rootId: {char: PathToId.flags["root-id"].char},
				dataSource: {
					char: PathToId.flags["data-source"].char,
					default: PathToId.flags["data-source"].default,
				},
			}).toStrictEqual({
				path: {char: "p", required: true},
				rootId: {char: "r"},
				dataSource: {char: "d", default: "auto"},
			});
		});
	});

	describe("path resolution from cache", () => {
		beforeEach(() => {
			delete process.env.WORKFLOWY_API_KEY;

			insertTestNodes(testDatabase.db, [
				createTestNode({id: "root-node-id", parentId: null, name: "Work", priority: 0}),
				createTestNode({id: "projects-node-id", parentId: "root-node-id", name: "Projects", priority: 0}),
				createTestNode({
					id: "my-project-node-id",
					parentId: "projects-node-id",
					name: "My Project",
					priority: 0,
				}),
			]);
		});

		it("resolves a single-level path and outputs only the ID", async () => {
			const {stdout} = await captureOutput(async () => {
				await PathToId.run(["--path", "Work"]);
			});

			expect(stdout.trim()).toBe("root-node-id");
		});

		it("resolves a multi-level path and outputs only the ID", async () => {
			const {stdout} = await captureOutput(async () => {
				await PathToId.run(["--path", "Work,Projects,My Project"]);
			});

			expect(stdout.trim()).toBe("my-project-node-id");
		});

		it("uses short flag -p for path", async () => {
			const {stdout} = await captureOutput(async () => {
				await PathToId.run(["-p", "Work,Projects"]);
			});

			expect(stdout.trim()).toBe("projects-node-id");
		});
	});

	describe("path resolution with root-id", () => {
		beforeEach(() => {
			delete process.env.WORKFLOWY_API_KEY;

			insertTestNodes(testDatabase.db, [
				createTestNode({id: "root-node-id", parentId: null, name: "Work", priority: 0}),
				createTestNode({id: "tasks-node-id", parentId: "root-node-id", name: "Tasks", priority: 0}),
				createTestNode({id: "today-node-id", parentId: "tasks-node-id", name: "Today", priority: 0}),
			]);
		});

		it("resolves path relative to root-id", async () => {
			const {stdout} = await captureOutput(async () => {
				await PathToId.run(["--root-id", "root-node-id", "--path", "Tasks,Today"]);
			});

			expect(stdout.trim()).toBe("today-node-id");
		});

		it("uses short flag -r for root-id", async () => {
			const {stdout} = await captureOutput(async () => {
				await PathToId.run(["-r", "root-node-id", "-p", "Tasks"]);
			});

			expect(stdout.trim()).toBe("tasks-node-id");
		});
	});

	describe("error handling", () => {
		beforeEach(() => {
			delete process.env.WORKFLOWY_API_KEY;
		});

		it("throws error when path not found in cache", async () => {
			await expect(PathToId.run(["--path", "NonExistent,Path", "--data-source", "cache"])).rejects.toThrow(
				"Error: Could not find node at path: NonExistent > Path (not in cache)",
			);
		});

		it("throws error when path not found and no API key", async () => {
			await expect(PathToId.run(["--path", "NonExistent,Path"])).rejects.toThrow(
				"Error: Could not find node at path: NonExistent > Path (no cached data and no API key)",
			);
		});
	});

	describe("API fallback", () => {
		beforeEach(() => {
			process.env.WORKFLOWY_API_KEY = "test-api-key";
		});

		it("falls back to API when path not in cache", async () => {
			let capturedUrl: string | undefined;
			globalThis.fetch = async (url: RequestInfo | URL) => {
				capturedUrl = url instanceof Request ? url.url : String(url);
				if (capturedUrl.includes("parent_id")) {
					return Promise.resolve(
						Response.json(
							{
								nodes: [
									{
										id: "api-project-id",
										name: "Projects",
										priority: 0,
										completed: false,
										data: {},
										createdAt: Date.now(),
										modifiedAt: Date.now(),
										completedAt: null,
									},
								],
							},
							{status: 200},
						),
					);
				}
				return Promise.resolve(
					Response.json(
						{
							nodes: [
								{
									id: "api-work-id",
									name: "Work",
									priority: 0,
									completed: false,
									data: {},
									createdAt: Date.now(),
									modifiedAt: Date.now(),
									completedAt: null,
								},
							],
						},
						{status: 200},
					),
				);
			};

			const {stdout} = await captureOutput(async () => {
				await PathToId.run(["--path", "Work,Projects"]);
			});

			expect(capturedUrl).toBe("https://workflowy.com/api/v1/nodes?parent_id=api-work-id");
			expect(stdout.trim()).toBe("api-project-id");
		});
	});

	describe("data-source flag", () => {
		beforeEach(() => {
			process.env.WORKFLOWY_API_KEY = "test-api-key";

			insertTestNodes(testDatabase.db, [
				createTestNode({id: "cached-node-id", parentId: null, name: "Cached", priority: 0}),
			]);
		});

		it("uses cache when data-source is cache", async () => {
			const {stdout} = await captureOutput(async () => {
				await PathToId.run(["--path", "Cached", "--data-source", "cache"]);
			});

			expect(stdout.trim()).toBe("cached-node-id");
		});

		it("uses short flag -d for data-source", async () => {
			const {stdout} = await captureOutput(async () => {
				await PathToId.run(["-p", "Cached", "-d", "cache"]);
			});

			expect(stdout.trim()).toBe("cached-node-id");
		});
	});
});
