import {beforeEach, vi, afterEach, describe, expect, it} from "vite-plus/test";
import {FAR_FUTURE_DATE, formatTemporalTimestamp} from "@outlinedb/shared/temporal";
import {captureOutput} from "@oclif/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Get from "../../src/commands/node/get.js";
import {cleanupTestDatabase, createTestDatabase, nodeFixtures, seedTestData} from "../db/migration-helper.js";
import type {TestDatabase} from "../db/migration-helper.js";
import {createTestNode} from "../helpers/node-fixtures.js";
import {z} from "zod";

const NodeOutputSchema = z.looseObject({
	id: z.string().optional(),
	name: z.string().optional(),
	note: z.string().nullish(),
	mirror: z.unknown().optional(),
	get children() {
		return z.array(NodeOutputSchema).optional();
	},
});

const parseNodeOutput = (stdout: string) => NodeOutputSchema.parse(JSON.parse(stdout));

describe("node get command", () => {
	let originalEnv: typeof process.env;
	let tempDir: string;
	let testDatabase: TestDatabase;

	beforeEach(() => {
		originalEnv = {...process.env};

		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "outlinedb-read-test-"));
		const testDbPath = path.join(tempDir, "test.sqlite");
		testDatabase = createTestDatabase(testDbPath);
		process.env.OUTLINEDB_DB_PATH = testDbPath;
		process.env.WORKFLOWY_API_KEY = "test-api-key";

		vi.spyOn(globalThis, "fetch");
	});

	afterEach(() => {
		process.env = originalEnv;

		cleanupTestDatabase(testDatabase);

		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, {recursive: true, force: true});
		}
	});

	describe("flag validation", () => {
		it("requires either --id or --path", async () => {
			await expect(Get.run([])).rejects.toThrow("Either --id or --path is required");
		});
	});

	describe("reading by ID", () => {
		it("reads a node by full UUID", async () => {
			const nodeId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
			const now = new Date();
			const oneHourAgo = new Date(now.getTime() - 3600 * 1000);

			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode({
						id: nodeId,
						name: "Test Node",
						note: "A test note",
						parentId: null,
						createdAt: oneHourAgo,
						modifiedAt: now,
					}),
				]),
			);

			const {stdout} = await captureOutput(async () => {
				await Get.run(["--id", nodeId, "--json"]);
			});

			const output = parseNodeOutput(stdout);
			expect(output.id).toBe(nodeId);
			expect(output.name).toBe("Test Node");
			expect(output.note).toBe("A test note");
		});

		// Short ID resolution is tested at the CacheService level (packages/cli/test/services/cache.test.ts)
		// Command-level testing has environment isolation issues with separate DB connections

		it("errors when node not found", async () => {
			await expect(Get.run(["--id", "nonexistent-id"])).rejects.toThrow("Node not found with ID: nonexistent-id");
		});
	});

	describe("reading by path", () => {
		it("reads a node by path from cache", async () => {
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode({id: "work-id", name: "Work", parentId: null}),
					createTestNode({
						id: "projects-id",
						name: "Projects",
						parentId: "work-id",
					}),
					createTestNode({
						id: "target-id",
						name: "My Project",
						note: "Project notes",
						parentId: "projects-id",
					}),
				]),
			);

			const {stdout} = await captureOutput(async () => {
				await Get.run(["--path", "Work,Projects,My Project", "--json"]);
			});

			const output = parseNodeOutput(stdout);
			expect(output.id).toBe("target-id");
			expect(output.name).toBe("My Project");
			expect(output.note).toBe("Project notes");
		});

		it("errors when path not found", async () => {
			await expect(Get.run(["--path", "Missing,Path"])).rejects.toThrow("Node not found at path: Missing > Path");
		});
	});

	describe("children and depth", () => {
		it("fetches children with depth", async () => {
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode({id: "parent-id", name: "Parent", parentId: null}),
					createTestNode({
						id: "child-1",
						name: "Child 1",
						parentId: "parent-id",
						priority: 0,
					}),
					createTestNode({
						id: "child-2",
						name: "Child 2",
						parentId: "parent-id",
						priority: 1,
					}),
				]),
			);

			const {stdout} = await captureOutput(async () => {
				await Get.run(["--id", "parent-id", "--depth", "1", "--json"]);
			});

			const output = parseNodeOutput(stdout);
			expect({
				id: output.id,
				name: output.name,
				children: output.children?.map(({id, name}) => ({id, name})),
			}).toStrictEqual({
				id: "parent-id",
				name: "Parent",
				children: [
					{id: "child-1", name: "Child 1"},
					{id: "child-2", name: "Child 2"},
				],
			});
		});

		it("returns node without children property when node has none", async () => {
			seedTestData(
				testDatabase,
				nodeFixtures([createTestNode({id: "leaf-id", name: "Leaf Node", parentId: null})]),
			);

			const {stdout} = await captureOutput(async () => {
				await Get.run(["--id", "leaf-id", "--depth", "1", "--json"]);
			});

			const output = parseNodeOutput(stdout);
			expect({id: output.id, name: output.name, children: output.children}).toStrictEqual({
				id: "leaf-id",
				name: "Leaf Node",
				children: undefined,
			});
		});
	});

	describe("JSON output", () => {
		it("outputs correct JSON structure", async () => {
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode({
						id: "json-node-id",
						name: "JSON Node",
						note: "Test note",
						parentId: null,
						createdAt: new Date("2000-01-01T00:00:00.000Z"),
						modifiedAt: new Date("2000-01-02T00:00:00.000Z"),
						systemFrom: "2000-01-01 00:00:00.000",
					}),
				]),
			);

			const {stdout} = await captureOutput(async () => {
				await Get.run(["--id", "json-node-id", "--json"]);
			});

			const output: unknown = JSON.parse(stdout);
			expect(output).toStrictEqual({
				id: "json-node-id",
				shortId: "jsonnodeid",
				parentId: null,
				name: "JSON Node",
				note: "Test note",
				priority: 0,
				layoutMode: "bullets",
				createdAt: "2000-01-01T00:00:00.000Z",
				modifiedAt: "2000-01-02T00:00:00.000Z",
				completedAt: null,
				collapsed: false,
				inChat: false,
				hasReferencesRoot: false,
				mirror: {isMirror: false, originalNodeId: null},
				path: "JSON Node",
				systemFrom: "2000-01-01 00:00:00.000",
				systemTo: "9999-12-31 23:59:59",
			});
		});

		it("filters to only requested fields", async () => {
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode({
						id: "filter-node-id",
						name: "Filter Node",
						note: "Note to filter",
						parentId: null,
					}),
				]),
			);

			const {stdout} = await captureOutput(async () => {
				await Get.run(["--id", "filter-node-id", "--json", "--fields", "id,name"]);
			});

			const output: unknown = JSON.parse(stdout);
			expect(output).toStrictEqual({id: "filter-node-id", name: "Filter Node"});
		});
	});

	describe("mirror handling", () => {
		it("includes mirror info in JSON output", async () => {
			const systemFrom = formatTemporalTimestamp(new Date());

			seedTestData(testDatabase, {
				...nodeFixtures([
					createTestNode({
						id: "original-id",
						name: "Original Node",
						parentId: null,
						systemFrom,
					}),
					// A mirror carries no content of its own; it inherits the original's.
					createTestNode({
						id: "mirror-id",
						name: "",
						parentId: null,
						systemFrom,
					}),
				]),
				mirrors: [
					{
						mirrorId: "mirror-id",
						originalId: "original-id",
						systemFrom,
						systemTo: FAR_FUTURE_DATE,
					},
				],
			});

			const {stdout} = await captureOutput(async () => {
				await Get.run(["--id", "mirror-id", "--json"]);
			});

			const output = parseNodeOutput(stdout);
			expect(output.id).toBe("mirror-id");
			expect(output.name).toBe("Original Node");
			expect(output.mirror).toStrictEqual({
				isMirror: true,
				originalNodeId: "original-id",
			});
		});

		it("shows the original text for a mirror that stores stale text of its own", async () => {
			const systemFrom = formatTemporalTimestamp(new Date());

			seedTestData(testDatabase, {
				...nodeFixtures([
					createTestNode({
						id: "original-id",
						name: "Original Node",
						note: "Original note",
						parentId: null,
						systemFrom,
					}),
					createTestNode({id: "mirror-id", name: "💼 Stale mirror text", parentId: null, systemFrom}),
				]),
				mirrors: [{mirrorId: "mirror-id", originalId: "original-id", systemFrom, systemTo: FAR_FUTURE_DATE}],
			});

			const {stdout} = await captureOutput(async () => {
				await Get.run(["--id", "mirror-id", "--json", "--fields", "id,name,note"]);
			});

			expect(JSON.parse(stdout)).toStrictEqual({
				id: "mirror-id",
				name: "Original Node",
				note: "Original note",
				mirror: {isMirror: true, originalNodeId: "original-id"},
			});
		});

		it("follows mirror to original with --follow-mirror", async () => {
			const systemFrom = formatTemporalTimestamp(new Date());

			seedTestData(testDatabase, {
				...nodeFixtures([
					createTestNode({
						id: "original-id",
						name: "Original Node",
						note: "Original note",
						parentId: null,
						systemFrom,
					}),
					createTestNode({
						id: "mirror-id",
						name: "Mirror Node",
						parentId: null,
						systemFrom,
					}),
				]),
				mirrors: [
					{
						mirrorId: "mirror-id",
						originalId: "original-id",
						systemFrom,
						systemTo: FAR_FUTURE_DATE,
					},
				],
			});

			const {stdout} = await captureOutput(async () => {
				await Get.run(["--id", "mirror-id", "--follow-mirror", "--json"]);
			});

			const output = parseNodeOutput(stdout);
			expect(output.id).toBe("original-id");
			expect(output.name).toBe("Original Node");
			expect(output.note).toBe("Original note");
		});
	});

	describe("mirror resolution in children", () => {
		it("resolves mirror child content from original node", async () => {
			const systemFrom = formatTemporalTimestamp(new Date());

			seedTestData(testDatabase, {
				...nodeFixtures([
					createTestNode({
						id: "parent-id",
						name: "Parent",
						parentId: null,
						systemFrom,
					}),
					createTestNode({
						id: "mirror-child-id",
						name: "",
						parentId: "parent-id",
						priority: 0,
						systemFrom,
					}),
					createTestNode({
						id: "original-node-id",
						name: "Original Content",
						note: "Original note",
						parentId: "some-other-parent",
						systemFrom,
					}),
				]),
				mirrors: [
					{
						mirrorId: "mirror-child-id",
						originalId: "original-node-id",
						systemFrom,
						systemTo: FAR_FUTURE_DATE,
					},
				],
			});

			const {stdout} = await captureOutput(async () => {
				await Get.run(["--id", "parent-id", "--depth", "1", "--json"]);
			});

			const output = parseNodeOutput(stdout);
			expect(
				output.children?.map(({name, note, mirror}) => ({
					name,
					note,
					mirror,
				})),
			).toStrictEqual([
				{
					name: "Original Content",
					note: "Original note",
					mirror: {isMirror: true, originalNodeId: "original-node-id"},
				},
			]);
		});

		it("resolves mirror children with filtered fields", async () => {
			const systemFrom = formatTemporalTimestamp(new Date());

			seedTestData(testDatabase, {
				...nodeFixtures([
					createTestNode({
						id: "parent-id",
						name: "Parent",
						parentId: null,
						systemFrom,
					}),
					createTestNode({
						id: "mirror-child-id",
						name: "",
						parentId: "parent-id",
						priority: 0,
						systemFrom,
					}),
					createTestNode({
						id: "original-node-id",
						name: "Original Content",
						parentId: "some-other-parent",
						systemFrom,
					}),
				]),
				mirrors: [
					{
						mirrorId: "mirror-child-id",
						originalId: "original-node-id",
						systemFrom,
						systemTo: FAR_FUTURE_DATE,
					},
				],
			});

			const {stdout} = await captureOutput(async () => {
				await Get.run(["--id", "parent-id", "--depth", "1", "--json", "--fields", "id,name,children"]);
			});

			const output = parseNodeOutput(stdout);
			expect(output.children?.map(({name, mirror}) => ({name, mirror}))).toStrictEqual([
				{
					name: "Original Content",
					mirror: {isMirror: true, originalNodeId: "original-node-id"},
				},
			]);
		});

		it("fetches children of original node for mirror children", async () => {
			const systemFrom = formatTemporalTimestamp(new Date());

			seedTestData(testDatabase, {
				...nodeFixtures([
					createTestNode({
						id: "parent-id",
						name: "Parent",
						parentId: null,
						systemFrom,
					}),
					createTestNode({
						id: "mirror-child-id",
						name: "",
						parentId: "parent-id",
						priority: 0,
						systemFrom,
					}),
					createTestNode({
						id: "original-node-id",
						name: "Original Content",
						parentId: "some-other-parent",
						systemFrom,
					}),
					createTestNode({
						id: "grandchild-1",
						name: "Grandchild 1",
						parentId: "original-node-id",
						priority: 0,
						systemFrom,
					}),
					createTestNode({
						id: "grandchild-2",
						name: "Grandchild 2",
						parentId: "original-node-id",
						priority: 1,
						systemFrom,
					}),
				]),
				mirrors: [
					{
						mirrorId: "mirror-child-id",
						originalId: "original-node-id",
						systemFrom,
						systemTo: FAR_FUTURE_DATE,
					},
				],
			});

			const {stdout} = await captureOutput(async () => {
				await Get.run(["--id", "parent-id", "--depth", "2", "--json"]);
			});

			const output = parseNodeOutput(stdout);
			const mirrorChild = output.children?.[0];
			expect({
				name: mirrorChild?.name,
				mirror: mirrorChild?.mirror,
				children: mirrorChild?.children?.map(({name}) => name),
			}).toStrictEqual({
				name: "Original Content",
				mirror: {isMirror: true, originalNodeId: "original-node-id"},
				children: ["Grandchild 1", "Grandchild 2"],
			});
		});

		it("ignores stale text stored on a mirror child and shows the original text", async () => {
			const systemFrom = formatTemporalTimestamp(new Date());

			seedTestData(testDatabase, {
				...nodeFixtures([
					createTestNode({id: "parent-id", name: "Parent", parentId: null, systemFrom}),
					createTestNode({
						id: "mirror-child-id",
						name: "💼 Stale mirror text",
						note: "Stale mirror note",
						parentId: "parent-id",
						priority: 0,
						systemFrom,
					}),
					createTestNode({
						id: "original-node-id",
						name: "Original text",
						note: null,
						parentId: "some-other-parent",
						systemFrom,
					}),
				]),
				mirrors: [
					{
						mirrorId: "mirror-child-id",
						originalId: "original-node-id",
						systemFrom,
						systemTo: FAR_FUTURE_DATE,
					},
				],
			});

			const {stdout} = await captureOutput(async () => {
				await Get.run(["--id", "parent-id", "--depth", "1", "--json", "--fields", "id,name,note,children"]);
			});

			expect(parseNodeOutput(stdout).children).toStrictEqual([
				{
					id: "mirror-child-id",
					name: "Original text",
					note: null,
					mirror: {isMirror: true, originalNodeId: "original-node-id"},
				},
			]);
		});
	});

	describe("completed status", () => {
		it("returns completedAt timestamp in JSON", async () => {
			// Use fixed dates for deterministic deep equality comparison
			const completedAt = new Date("2024-06-15T10:30:00.000Z");
			const createdAt = new Date("2024-06-15T08:00:00.000Z");
			const modifiedAt = new Date("2024-06-15T10:30:00.000Z");

			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode({
						id: "completed-node",
						name: "Completed Task",
						parentId: null,
						completedAt,
						createdAt,
						modifiedAt,
					}),
				]),
			);

			const {stdout} = await captureOutput(async () => {
				await Get.run(["--id", "completed-node", "--json"]);
			});

			const output = parseNodeOutput(stdout);

			// Delete dynamic fields before deep equality comparison
			delete output.systemFrom;
			delete output.path;

			expect(output).toStrictEqual({
				id: "completed-node",
				shortId: "ompletednode", // getShortId removes dashes and takes last 12 chars
				name: "Completed Task",
				note: null,
				parentId: null,
				priority: 0, // default from createTestNode
				createdAt: "2024-06-15T08:00:00.000Z",
				modifiedAt: "2024-06-15T10:30:00.000Z",
				completedAt: "2024-06-15T10:30:00.000Z",
				layoutMode: "bullets", // default from createTestNode
				collapsed: false,
				mirror: {isMirror: false, originalNodeId: null},
				systemTo: FAR_FUTURE_DATE,
				inChat: false,
				hasReferencesRoot: false,
			});
		});
	});

	describe("command metadata", () => {
		it("has correct description", () => {
			expect(Get.description).toBe("Read a single Workflowy node with optional children");
		});

		it("has examples", () => {
			expect(Array.isArray(Get.examples)).toBe(true);
			expect(Get.examples).toStrictEqual([
				"# Read node by ID",
				"<%= config.bin %> <%= command.id %> --id abc123",
				"",
				"# Read node by short ID from Workflowy URL (12 hex chars)",
				"<%= config.bin %> <%= command.id %> --id c8708df23f1e",
				"",
				"# Read node by path",
				'<%= config.bin %> <%= command.id %> --path "Work,Projects,My Project"',
				"",
				"# Read node with children (depth 3)",
				"<%= config.bin %> <%= command.id %> --id abc123 --depth 3",
				"",
				"# Read node with full tree and follow links",
				'<%= config.bin %> <%= command.id %> --path "Personal,Inbox" --depth 5 --follow-links',
				"",
				"# Follow a mirror to its original node",
				"<%= config.bin %> <%= command.id %> --id abc123 --follow-mirror",
				"",
				"# Output as JSON",
				"<%= config.bin %> <%= command.id %> --id abc123 --json",
				"",
				"# Output JSON with only specific fields (reduces token usage for LLM processing)",
				'<%= config.bin %> <%= command.id %> --path "Metadata,Inboxes" --depth 3 --json --fields id,name,note,completed,children',
			]);
		});
	});
});
