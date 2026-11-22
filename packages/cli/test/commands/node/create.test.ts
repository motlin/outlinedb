import {it, vi, afterEach, expect, describe, beforeEach} from "vite-plus/test";
import {captureOutput} from "@oclif/test";
import {calendarNodeId, WorkflowyInternalAdapter} from "@outlinedb/shared/internal";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {Readable} from "node:stream";
import type {MockInstance} from "vite-plus/test";
import Create from "../../../src/commands/node/create.js";
import {CacheService} from "../../../src/services/cache.js";
import {cleanupTestDatabase, createTestDatabase, nodeFixtures, seedTestData} from "../../db/migration-helper.js";
import type {TestDatabase} from "../../db/migration-helper.js";
import {seedTaggedCalendar} from "../../helpers/calendar-fixture.js";
import {createTestNode} from "../../helpers/node-fixtures.js";
import {fakeUpstream, isolateInternalAuth, pendingOutbox} from "../../helpers/upstream-outbox.js";
import type {UpstreamFake} from "../../helpers/upstream-outbox.js";

/** The `n`th id the command generates: the internal client's transient id takes the first. */
function uuid(n: number): string
{
	return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** A parent's children in order, as the local tables hold them, each with its own children. */
interface LocalTree
{
	id: string;
	name: string | null;
	note?: string;
	children?: LocalTree[];
}

describe("node create command", () =>
{
	let originalEnv: typeof process.env;
	let fetchStub: MockInstance<typeof fetch>;
	let tempDir: string;
	let testDatabase: TestDatabase;

	beforeEach(() =>
	{
		originalEnv =
		{
			...process.env,
		};

		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "outlinedb-create-test-"));
		const testDbPath = path.join(tempDir, "test.sqlite");
		testDatabase = createTestDatabase(testDbPath);
		process.env.OUTLINEDB_DB_PATH = testDbPath;
		process.env.WORKFLOWY_API_KEY = "test-api-key";
		isolateInternalAuth(tempDir);

		fetchStub = vi.spyOn(globalThis, "fetch");
		let generated = 0;
		vi.spyOn(crypto, "randomUUID").mockImplementation(() =>
		{
			generated += 1;
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a well-formed UUID
			return uuid(generated) as ReturnType<typeof crypto.randomUUID>;
		});
	});

	afterEach(() =>
	{
		vi.restoreAllMocks();
		process.env = originalEnv;

		cleanupTestDatabase(testDatabase);

		if (fs.existsSync(tempDir))
		{
			fs.rmSync(
				tempDir,
				{
					recursive: true,
					force: true,
				},
			);
		}
	});

	/** `Parent` (`parent-id`) at Home, holding `Sibling` (`sibling-id`). */
	function seedParent(): void
	{
		seedTestData(
			testDatabase,
			nodeFixtures([
				createTestNode(
					{
						id: "parent-id",
						name: "Parent",
						parentId: null,
					},
				),
				createTestNode(
					{
						id: "sibling-id",
						name: "Sibling",
						parentId: "parent-id",
					},
				),
			]),
		);
	}

	function localTree(parentId: string | null): LocalTree[]
	{
		const cache = new CacheService(testDatabase.db);
		return cache.getChildren(parentId).map((child) =>
		{
			const children = localTree(child.id);
			return {
				id: child.id,
				name: child.name,
				...(child.note === null
					? {}
					:
						{
							note: child.note,
						}),
				...(children.length === 0
					? {}
					:
						{
							children,
						}),
			};
		});
	}

	/** When the local tables say `id` was created, as the command prints it. */
	function createdAt(id: string): string
	{
		return new CacheService(testDatabase.db).getNode(id)?.createdAt?.toISOString() ?? "";
	}

	/** Each push's ops: the op type, its parent and slot, and the created trees without their timestamps. */
	function pushedCreates(upstream: UpstreamFake): unknown[][]
	{
		return upstream.pushes.map((ops) =>
			ops.map(({type, data}) => (
			{
				type,
				parentid: data.parentid,
				priority: data.starting_priority,
				trees:
					typeof data.project_trees === "string"
						? (JSON.parse(data.project_trees, (key, value: unknown) =>
								key === "ct" || key === "cb" ? undefined : value,
							) as unknown)
						: undefined,
			})),
		);
	}

	describe("environment variable validation", () =>
	{
		it("requires WORKFLOWY_API_KEY", async () =>
		{
			delete process.env.WORKFLOWY_API_KEY;

			await expect(Create.run(["--parent-id", "inbox", "--name", "Test"])).rejects.toThrow(
				"WORKFLOWY_API_KEY environment variable is required",
			);
		});
	});

	describe("flag validation", () =>
	{
		it("requires either --name, --json, or --json-file", async () =>
		{
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode(
						{
							id: "parent-id",
							name: "Parent",
							parentId: null,
						},
					),
				]),
			);

			await expect(Create.run(["--parent-id", "parent-id"])).rejects.toThrow(
				"Either --name, --json, or --json-file is required",
			);
		});

		it("requires parent specifier", async () =>
		{
			await expect(Create.run(["--name", "Test Node"])).rejects.toThrow("Parent node is required");
		});
	});

	describe("dry run mode", () =>
	{
		it("previews the local create and the drain's ops without saving or sending anything", async () =>
		{
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode(
						{
							id: "parent-id",
							name: "Parent",
							parentId: null,
						},
					),
				]),
			);

			const {stdout} = await captureOutput(async () =>
			{
				await Create.run(["--parent-id", "parent-id", "--name", "Test Node", "--dry-run"]);
			});

			expect(fetchStub.mock.calls).toStrictEqual([]);
			expect(pendingOutbox(testDatabase)).toStrictEqual([]);
			expect(new CacheService(testDatabase.db).getChildren("parent-id")).toStrictEqual([]);
			expect(stdout).toBe(
				"Would create node: Test Node\n" +
					"Parent: Parent\n" +
					"Would save locally (outbox rows):\n" +
					"  00000000-0000-4000-8000-000000000001  create  Test Node\n" +
					"  00000000-0000-4000-8000-000000000001  placement  Test Node\n" +
					"Would push to workflowy.com:\n" +
					'  bulk_create {"parentid":"parent-id","starting_priority":0,"project_trees":[{"id":"00000000-0000-4000-8000-000000000001","nm":"Test Node","ch":[]}],"isForSearch":false}\n',
			);
		});

		it("accepts an empty --name for a blank node", async () =>
		{
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode(
						{
							id: "parent-id",
							name: "Parent",
							parentId: null,
						},
					),
				]),
			);

			const {stdout} = await captureOutput(async () =>
			{
				await Create.run(["--parent-id", "parent-id", "--name", "", "--dry-run"]);
			});

			expect(fetchStub.mock.calls).toStrictEqual([]);
			expect(stdout).toBe(
				"Would create node: \n" +
					"Parent: Parent\n" +
					"Would save locally (outbox rows):\n" +
					"  00000000-0000-4000-8000-000000000001  create\n" +
					"  00000000-0000-4000-8000-000000000001  placement\n" +
					"Would push to workflowy.com:\n" +
					'  bulk_create {"parentid":"parent-id","starting_priority":0,"project_trees":[{"id":"00000000-0000-4000-8000-000000000001","nm":"","ch":[]}],"isForSearch":false}\n',
			);
		});

		it("includes note in dry run output", async () =>
		{
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode(
						{
							id: "parent-id",
							name: "Parent",
							parentId: null,
						},
					),
				]),
			);

			const {stdout} = await captureOutput(async () =>
			{
				await Create.run([
					"--parent-id",
					"parent-id",
					"--name",
					"Test Node",
					"--note",
					"This is a note",
					"--dry-run",
				]);
			});

			expect(stdout).toBe(
				"Would create node: Test Node\n" +
					"Parent: Parent\n" +
					"Would save locally (outbox rows):\n" +
					"  00000000-0000-4000-8000-000000000001  create  Test Node\n" +
					"  00000000-0000-4000-8000-000000000001  placement  Test Node\n" +
					"Would push to workflowy.com:\n" +
					'  bulk_create {"parentid":"parent-id","starting_priority":0,"project_trees":[{"id":"00000000-0000-4000-8000-000000000001","nm":"Test Node","no":"This is a note","ch":[]}],"isForSearch":false}\n',
			);
		});

		it("includes layout mode in dry run output", async () =>
		{
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode(
						{
							id: "parent-id",
							name: "Parent",
							parentId: null,
						},
					),
				]),
			);

			const {stdout} = await captureOutput(async () =>
			{
				await Create.run([
					"--parent-id",
					"parent-id",
					"--name",
					"Test Node",
					"--layout-mode",
					"document",
					"--dry-run",
				]);
			});

			expect(stdout).toBe(
				"Would create node: Test Node\n" +
					"Parent: Parent\n" +
					"Would save locally (outbox rows):\n" +
					"  00000000-0000-4000-8000-000000000001  create  Test Node\n" +
					"  00000000-0000-4000-8000-000000000001  placement  Test Node\n" +
					"Would push to workflowy.com:\n" +
					'  bulk_create {"parentid":"parent-id","starting_priority":0,"project_trees":[{"id":"00000000-0000-4000-8000-000000000001","nm":"Test Node","metadata":{"layoutMode":"document"},"ch":[]}],"isForSearch":false}\n',
			);
		});
	});

	describe("single node creation", () =>
	{
		it("creates the node locally at the bottom of its parent, delivers it in one push, and leaves nothing pending", async () =>
		{
			seedParent();
			const upstream = fakeUpstream(fetchStub, testDatabase, tempDir);

			const {stdout, error} = await captureOutput(async () =>
			{
				await Create.run([
					"--parent-id",
					"parent-id",
					"--name",
					"Test Node",
					"--note",
					"A note",
					"--layout-mode",
					"document",
				]);
			});

			expect(
				{
					error,
					stdout,
					local: localTree("parent-id"),
					pushes: pushedCreates(upstream),
					pending: pendingOutbox(testDatabase),
				},
			).toStrictEqual(
				{
					error: undefined,
					stdout: `Creating node: Test Node\nParent: Parent\n\nSuccessfully created node\n  ID: ${uuid(2)}\n  Name: Test Node\n  Created: ${createdAt(uuid(2))}\n  URL: https://workflowy.com/#/000000000002\n`,
					local: [
						{
							id: "sibling-id",
							name: "Sibling",
						},
						{
							id: uuid(2),
							name: "Test Node",
							note: "A note",
						},
					],
					pushes: [
						[
							{
								type: "bulk_create",
								parentid: "parent-id",
								priority: 1,
								trees: [
									{
										id: uuid(2),
										nm: "Test Node",
										no: "A note",
										metadata:
										{
											layoutMode: "document",
										},
										ch: [],
									},
								],
							},
						],
					],
					pending: [],
				},
			);
		});

		it("keeps the created node and its outbox rows when the push fails, and exits non-zero with the pending count", async () =>
		{
			seedParent();
			fakeUpstream(
				fetchStub,
				testDatabase,
				tempDir,
				{
					failPush: true,
				},
			);

			const {stdout, error} = await captureOutput(async () =>
			{
				await Create.run(["--parent-id", "parent-id", "--name", "Test Node"]);
			});

			expect(
				{
					stdout,
					error: error?.message,
					exit: error?.oclif?.exit,
					local: localTree("parent-id"),
					pending: pendingOutbox(testDatabase),
				},
			).toStrictEqual(
				{
					stdout: "Creating node: Test Node\nParent: Parent\n",
					error: `Saved locally (created node ${uuid(2)}), but delivering it to workflowy.com failed: Workflowy rejected the operations: upstream_rejected\n2 outbox rows pending; they go out on the next write or with 'outbox drain'.`,
					exit: 1,
					local: [
						{
							id: "sibling-id",
							name: "Sibling",
						},
						{
							id: uuid(2),
							name: "Test Node",
						},
					],
					pending: [
						{
							nodeId: uuid(2),
							aspect: "create",
							lastError: "Workflowy rejected the operations: upstream_rejected",
						},
						{
							nodeId: uuid(2),
							aspect: "placement",
							lastError: "Workflowy rejected the operations: upstream_rejected",
						},
					],
				},
			);
		});

		it("creates at the top of the parent with --position top", async () =>
		{
			seedParent();
			fakeUpstream(fetchStub, testDatabase, tempDir);

			const {error} = await captureOutput(async () =>
			{
				await Create.run(["--parent-id", "parent-id", "--name", "First", "--position", "top"]);
			});

			expect(
				{
					error,
					local: localTree("parent-id"),
				},
			).toStrictEqual(
				{
					error: undefined,
					local: [
						{
							id: uuid(2),
							name: "First",
						},
						{
							id: "sibling-id",
							name: "Sibling",
						},
					],
				},
			);
		});

		it("refuses to write without internal-API credentials, leaving the outline and the outbox alone", async () =>
		{
			seedParent();

			await expect(Create.run(["--parent-id", "parent-id", "--name", "Test Node"])).rejects.toThrow(
				"Writing needs the internal API",
			);

			expect(
				{
					local: localTree("parent-id"),
					pending: pendingOutbox(testDatabase),
					fetches: fetchStub.mock.calls.length,
				},
			).toStrictEqual(
				{
					local: [
						{
							id: "sibling-id",
							name: "Sibling",
						},
					],
					pending: [],
					fetches: 0,
				},
			);
		});
	});

	describe("backlinks", () =>
	{
		const TARGET_ID = "01234567-0000-4000-8000-0123456789ab";
		const TARGET_LINK = '<a href="https://workflowy.com/#/0123456789ab">t</a>';

		function seedTarget(): void
		{
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode(
						{
							id: "parent-id",
							name: "Parent",
							parentId: null,
						},
					),
					createTestNode(
						{
							id: TARGET_ID,
							name: "Target",
							parentId: null,
						},
					),
				]),
			);
		}

		it("creates a backlink item under the linked node, delivered in the same drain as the new node", async () =>
		{
			seedTarget();
			const upstream = fakeUpstream(fetchStub, testDatabase, tempDir);

			const {error} = await captureOutput(async () =>
			{
				await Create.run(["--parent-id", "parent-id", "--name", `see ${TARGET_LINK}`]);
			});

			expect(
				{
					error,
					target: localTree(TARGET_ID),
					types: upstream.pushes.map((ops) => ops.map((op) => op.type)),
					pending: pendingOutbox(testDatabase),
				},
			).toStrictEqual(
				{
					error: undefined,
					target: [
						{
							id: uuid(3),
							name: "",
							children: [
								{
									id: uuid(4),
									name: `see ${TARGET_LINK}`,
								},
							],
						},
					],
					types: [["bulk_create", "bulk_create", "bulk_create"]],
					pending: [],
				},
			);
		});

		it("creates backlink items for every node of a --json tree with a link", async () =>
		{
			seedTarget();
			fakeUpstream(fetchStub, testDatabase, tempDir);
			const json = JSON.stringify(
				{
					name: `root ${TARGET_LINK}`,
					children: [
						{
							name: "plain",
						},
						{
							name: "child",
							note: `note ${TARGET_LINK}`,
						},
					],
				},
			);

			const {error} = await captureOutput(async () =>
			{
				await Create.run(["--parent-id", "parent-id", "--json", json]);
			});

			expect(
				{
					error,
					target: localTree(TARGET_ID),
				},
			).toStrictEqual(
				{
					error: undefined,
					target: [
						{
							id: uuid(5),
							name: "",
							children: [
								{
									id: uuid(7),
									name: "child",
									note: `note ${TARGET_LINK}`,
								},
								{
									id: uuid(6),
									name: `root ${TARGET_LINK}`,
								},
							],
						},
					],
				},
			);
		});
	});

	describe("calendar adoption", () =>
	{
		const day21 = '<time startYear="2026" startMonth="10" startDay="21">Wed, Oct 21, 2026</time>';
		const seedCalendar = () =>
		{
			seedTaggedCalendar(testDatabase);
		};

		it("tags a dated row created under a calendar month as that day, and delivers the tag with the create", async () =>
		{
			seedCalendar();
			const upstream = fakeUpstream(fetchStub, testDatabase, tempDir);

			const {error} = await captureOutput(async () =>
			{
				await Create.run(["--parent-id", "m10", "--name", day21]);
			});

			expect(
				{
					error,
					pushes: pushedCreates(upstream),
				},
			).toStrictEqual(
				{
					error: undefined,
					pushes: [
						[
							{
								type: "bulk_create",
								parentid: "m10",
								priority: 3,
								trees: [
									{
										id: uuid(2),
										nm: day21,
										metadata:
										{
											calendar:
											{
												level: "day",
												value: "21",
												timestamp: new Date(2026, 9, 21).getTime(),
												dateId: 20_261_021,
											},
										},
										ch: [],
									},
								],
							},
						],
					],
				},
			);
		});

		it("adds no calendar metadata under a non-calendar parent", async () =>
		{
			seedCalendar();
			seedParent();
			const upstream = fakeUpstream(fetchStub, testDatabase, tempDir);

			const {error} = await captureOutput(async () =>
			{
				await Create.run(["--parent-id", "parent-id", "--name", day21]);
			});

			expect(
				{
					error,
					pushes: pushedCreates(upstream),
				},
			).toStrictEqual(
				{
					error: undefined,
					pushes: [
						[
							{
								type: "bulk_create",
								parentid: "parent-id",
								priority: 1,
								trees: [
									{
										id: uuid(2),
										nm: day21,
										ch: [],
									},
								],
							},
						],
					],
				},
			);
		});

		it("ensures a missing calendar month for --create-path instead of creating a name-only one", async () =>
		{
			seedCalendar();
			const upstream = fakeUpstream(fetchStub, testDatabase, tempDir);
			vi.spyOn(WorkflowyInternalAdapter.prototype, "getEntropyKey").mockResolvedValue("k");
			vi.spyOn(WorkflowyInternalAdapter.prototype, "getRootMeta").mockResolvedValue(undefined);
			const ensure = vi.spyOn(WorkflowyInternalAdapter.prototype, "ensureCalendarDay");
			const november = calendarNodeId("k", "month", 20_261_100);

			const {error} = await captureOutput(async () =>
			{
				await Create.run(["--parent-path", "📆 Calendar,2026,11,Notes", "--create-path", "--name", "Entry"]);
			});

			expect(
				{
					error,
					calls: ensure.mock.calls,
					month: localTree("y2026").filter((node) => node.id === november),
					pushed: upstream.pushes.map((ops) => ops.map(({type, data}) => `${type} ${String(data.parentid)}`)),
					pending: pendingOutbox(testDatabase),
				},
			).toStrictEqual(
				{
					error: undefined,
					calls: [],
					month: [
						{
							id: november,
							name: "11",
							children: [
								{
									id: uuid(2),
									name: "Notes",
									children: [
										{
											id: uuid(3),
											name: "Entry",
										},
									],
								},
							],
						},
					],
					// One drain delivers the month under its year, then the path under it.
					pushed: [["bulk_create y2026", `bulk_create ${november}`, `bulk_create ${uuid(2)}`]],
					pending: [],
				},
			);
		});
	});

	describe("parent resolution", () =>
	{
		it("resolves parent by path", async () =>
		{
			seedParent();
			fakeUpstream(fetchStub, testDatabase, tempDir);

			const {stdout, error} = await captureOutput(async () =>
			{
				await Create.run(["--parent-path", "Parent,Sibling", "--name", "Nested"]);
			});

			expect(
				{
					error,
					stdout,
					local: localTree("sibling-id"),
				},
			).toStrictEqual(
				{
					error: undefined,
					stdout: `Creating node: Nested\nParent: Parent > Sibling\n\nSuccessfully created node\n  ID: ${uuid(2)}\n  Name: Nested\n  Created: ${createdAt(uuid(2))}\n  URL: https://workflowy.com/#/000000000002\n`,
					local: [
						{
							id: uuid(2),
							name: "Nested",
						},
					],
				},
			);
		});

		it("creates missing path segments locally with --create-path", async () =>
		{
			seedParent();
			fakeUpstream(fetchStub, testDatabase, tempDir);

			const {error} = await captureOutput(async () =>
			{
				await Create.run(["--parent-path", "Parent,New,Deeper", "--create-path", "--name", "Leaf"]);
			});

			expect(
				{
					error,
					local: localTree("parent-id"),
					pending: pendingOutbox(testDatabase),
				},
			).toStrictEqual(
				{
					error: undefined,
					local: [
						{
							id: "sibling-id",
							name: "Sibling",
						},
						{
							id: uuid(2),
							name: "New",
							children: [
								{
									id: uuid(3),
									name: "Deeper",
									children: [
										{
											id: uuid(4),
											name: "Leaf",
										},
									],
								},
							],
						},
					],
					pending: [],
				},
			);
		});

		it("resolves the inbox system target to the account's Inbox node", async () =>
		{
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode(
						{
							id: "inbox-uuid",
							name: "Inbox",
							parentId: null,
						},
					),
				]),
			);
			fakeUpstream(fetchStub, testDatabase, tempDir);

			const {error} = await captureOutput(async () =>
			{
				await Create.run(["--parent-id", "inbox", "--name", "Test"]);
			});

			expect(
				{
					error,
					local: localTree("inbox-uuid"),
				},
			).toStrictEqual(
				{
					error: undefined,
					local: [
						{
							id: uuid(2),
							name: "Test",
						},
					],
				},
			);
		});
	});

	describe("home (top level)", () =>
	{
		it("dry run shows Home as the parent and pushes under the root", async () =>
		{
			const {stdout} = await captureOutput(async () =>
			{
				await Create.run(["--parent-id", "home", "--name", "Area", "--dry-run"]);
			});

			expect(stdout).toBe(
				"Would create node: Area\n" +
					"Parent: Home\n" +
					"Would save locally (outbox rows):\n" +
					"  00000000-0000-4000-8000-000000000001  create  Area\n" +
					"  00000000-0000-4000-8000-000000000001  placement  Area\n" +
					"Would push to workflowy.com:\n" +
					'  bulk_create {"parentid":"None","starting_priority":0,"project_trees":[{"id":"00000000-0000-4000-8000-000000000001","nm":"Area","ch":[]}],"isForSearch":false}\n',
			);
		});

		it("creates a top-level node with a null parent", async () =>
		{
			seedParent();
			const upstream = fakeUpstream(fetchStub, testDatabase, tempDir);

			const {error} = await captureOutput(async () =>
			{
				await Create.run(["--parent-id", "home", "--name", "Area"]);
			});

			expect(
				{
					error,
					home: localTree(null),
					pushes: pushedCreates(upstream),
				},
			).toStrictEqual(
				{
					error: undefined,
					home: [
						{
							id: "parent-id",
							name: "Parent",
							children: [
								{
									id: "sibling-id",
									name: "Sibling",
								},
							],
						},
						{
							id: uuid(2),
							name: "Area",
						},
					],
					pushes: [
						[
							{
								type: "bulk_create",
								parentid: "None",
								priority: 1,
								trees: [
									{
										id: uuid(2),
										nm: "Area",
										ch: [],
									},
								],
							},
						],
					],
				},
			);
		});
	});

	describe("JSON mode", () =>
	{
		it("creates a nested tree in one unit of work and prints its ids", async () =>
		{
			seedParent();
			const upstream = fakeUpstream(fetchStub, testDatabase, tempDir);
			const json = JSON.stringify(
				{
					name: "Project",
					note: "Plan",
					layoutMode: "board",
					children: [
						{
							name: "Task 1",
						},
						{
							name: "Task 2",
						},
					],
				},
			);

			const {stdout, error} = await captureOutput(async () =>
			{
				await Create.run(["--parent-id", "parent-id", "--json", json]);
			});

			expect(
				{
					error,
					stdout,
					local: localTree("parent-id"),
					pushes: pushedCreates(upstream),
					pending: pendingOutbox(testDatabase),
				},
			).toStrictEqual(
				{
					error: undefined,
					stdout: `Creating node tree...\nParent: Parent\n\nSuccessfully created node tree:\n- Project\n  ID: ${uuid(2)}\n  URL: https://workflowy.com/#/000000000002\n  - Task 1\n    ID: ${uuid(3)}\n    URL: https://workflowy.com/#/000000000003\n  - Task 2\n    ID: ${uuid(4)}\n    URL: https://workflowy.com/#/000000000004\n\nCreated node IDs (JSON):\n${JSON.stringify(
						[
							{
								id: uuid(2),
								name: "Project",
								parentId: null,
							},
							{
								id: uuid(3),
								name: "Task 1",
								parentId: uuid(2),
							},
							{
								id: uuid(4),
								name: "Task 2",
								parentId: uuid(2),
							},
						],
						null,
						2,
					)}\n`,
					local: [
						{
							id: "sibling-id",
							name: "Sibling",
						},
						{
							id: uuid(2),
							name: "Project",
							note: "Plan",
							children: [
								{
									id: uuid(3),
									name: "Task 1",
								},
								{
									id: uuid(4),
									name: "Task 2",
								},
							],
						},
					],
					pushes: [
						[
							{
								type: "bulk_create",
								parentid: "parent-id",
								priority: 1,
								trees: [
									{
										id: uuid(2),
										nm: "Project",
										no: "Plan",
										metadata:
										{
											layoutMode: "board",
										},
										ch: [],
									},
								],
							},
							{
								type: "bulk_create",
								parentid: uuid(2),
								priority: 0,
								trees: [
									{
										id: uuid(3),
										nm: "Task 1",
										ch: [],
									},
								],
							},
							{
								type: "bulk_create",
								parentid: uuid(2),
								priority: 1,
								trees: [
									{
										id: uuid(4),
										nm: "Task 2",
										ch: [],
									},
								],
							},
						],
					],
					pending: [],
				},
			);
		});

		it("dry run shows node tree preview for JSON", async () =>
		{
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode(
						{
							id: "parent-id",
							name: "Parent",
							parentId: null,
						},
					),
				]),
			);

			const json = JSON.stringify(
				{
					name: "Project",
					children: [
						{
							name: "Task 1",
						},
						{
							name: "Task 2",
						},
					],
				},
			);

			const {stdout} = await captureOutput(async () =>
			{
				await Create.run(["--parent-id", "parent-id", "--json", json, "--dry-run"]);
			});

			expect(stdout).toBe(
				"Would create the following node tree:\nParent: Parent\n\n- Project\n  - Task 1\n  - Task 2\n\n" +
					"Would save locally (outbox rows):\n" +
					"  00000000-0000-4000-8000-000000000001  create  Project\n" +
					"  00000000-0000-4000-8000-000000000001  placement  Project\n" +
					"  00000000-0000-4000-8000-000000000002  create  Task 1\n" +
					"  00000000-0000-4000-8000-000000000003  create  Task 2\n" +
					"Would push to workflowy.com:\n" +
					'  bulk_create {"parentid":"parent-id","starting_priority":0,"project_trees":[{"id":"00000000-0000-4000-8000-000000000001","nm":"Project","ch":[]}],"isForSearch":false}\n' +
					'  bulk_create {"parentid":"00000000-0000-4000-8000-000000000001","starting_priority":0,"project_trees":[{"id":"00000000-0000-4000-8000-000000000002","nm":"Task 1","ch":[]}],"isForSearch":false}\n' +
					'  bulk_create {"parentid":"00000000-0000-4000-8000-000000000001","starting_priority":1,"project_trees":[{"id":"00000000-0000-4000-8000-000000000003","nm":"Task 2","ch":[]}],"isForSearch":false}\n',
			);
			expect(fetchStub.mock.calls).toStrictEqual([]);
		});

		it("handles invalid JSON in --json flag", async () =>
		{
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode(
						{
							id: "parent-id",
							name: "Parent",
							parentId: null,
						},
					),
				]),
			);

			await expect(Create.run(["--parent-id", "parent-id", "--json", "not valid json"])).rejects.toThrow(
				"Invalid JSON",
			);
		});

		it("validates JSON structure", async () =>
		{
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode(
						{
							id: "parent-id",
							name: "Parent",
							parentId: null,
						},
					),
				]),
			);

			await expect(
				Create.run(["--parent-id", "parent-id", "--json", '{"invalid": "structure"}']),
			).rejects.toThrow("Invalid JSON structure");
		});
	});

	describe("JSON file mode", () =>
	{
		it("creates nodes from JSON file", async () =>
		{
			seedParent();
			fakeUpstream(fetchStub, testDatabase, tempDir);
			const jsonFile = path.join(tempDir, "tree.json");
			fs.writeFileSync(
				jsonFile,
				JSON.stringify(
					{
						name: "From File",
						children: [
							{
								name: "Child",
							},
						],
					},
				),
			);

			const {error} = await captureOutput(async () =>
			{
				await Create.run(["--parent-id", "parent-id", "--json-file", jsonFile]);
			});

			expect(
				{
					error,
					local: localTree("parent-id"),
				},
			).toStrictEqual(
				{
					error: undefined,
					local: [
						{
							id: "sibling-id",
							name: "Sibling",
						},
						{
							id: uuid(2),
							name: "From File",
							children: [
								{
									id: uuid(3),
									name: "Child",
								},
							],
						},
					],
				},
			);
		});

		it("handles non-existent JSON file", async () =>
		{
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode(
						{
							id: "parent-id",
							name: "Parent",
							parentId: null,
						},
					),
				]),
			);

			await expect(
				Create.run(["--parent-id", "parent-id", "--json-file", "/nonexistent/file.json"]),
			).rejects.toThrow("File not found");
		});
	});

	describe("stdin markdown mode", () =>
	{
		let stdinDescriptor: PropertyDescriptor | undefined;

		beforeEach(() =>
		{
			stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");
		});

		afterEach(() =>
		{
			if (stdinDescriptor)
			{
				Object.defineProperty(process, "stdin", stdinDescriptor);
			}
		});

		function pipeStdin(input: string): void
		{
			Object.defineProperty(
				process,
				"stdin",
				{
					value: Readable.from([input]),
					configurable: true,
				},
			);
		}

		it("nests an indented 3-level bullet outline exactly like the equivalent --json tree", async () =>
		{
			seedParent();
			fakeUpstream(fetchStub, testDatabase, tempDir);
			pipeStdin("- Project\n  - Task 1\n    - Step A\n\n  - Task 2\n");

			const {stdout, error} = await captureOutput(async () =>
			{
				await Create.run(["--parent-id", "parent-id", "--name", "-"]);
			});

			expect(
				{
					error,
					stdout,
					local: localTree("parent-id"),
				},
			).toStrictEqual(
				{
					error: undefined,
					stdout: `Creating node tree...\nParent: Parent\n\nSuccessfully created node tree:\n- Project\n  ID: ${uuid(2)}\n  URL: https://workflowy.com/#/000000000002\n  - Task 1\n    ID: ${uuid(3)}\n    URL: https://workflowy.com/#/000000000003\n    - Step A\n      ID: ${uuid(4)}\n      URL: https://workflowy.com/#/000000000004\n  - Task 2\n    ID: ${uuid(5)}\n    URL: https://workflowy.com/#/000000000005\n\nCreated node IDs (JSON):\n${JSON.stringify(
						[
							{
								id: uuid(2),
								name: "Project",
								parentId: null,
							},
							{
								id: uuid(3),
								name: "Task 1",
								parentId: uuid(2),
							},
							{
								id: uuid(4),
								name: "Step A",
								parentId: uuid(3),
							},
							{
								id: uuid(5),
								name: "Task 2",
								parentId: uuid(2),
							},
						],
						null,
						2,
					)}\n`,
					local: [
						{
							id: "sibling-id",
							name: "Sibling",
						},
						{
							id: uuid(2),
							name: "Project",
							children: [
								{
									id: uuid(3),
									name: "Task 1",
									children: [
										{
											id: uuid(4),
											name: "Step A",
										},
									],
								},
								{
									id: uuid(5),
									name: "Task 2",
								},
							],
						},
					],
				},
			);
		});

		it("creates each top-level bullet as its own tree under the parent, in order, even at the top", async () =>
		{
			seedParent();
			fakeUpstream(fetchStub, testDatabase, tempDir);
			pipeStdin("* First\n\t* Child\n* Second\n");

			const {error} = await captureOutput(async () =>
			{
				await Create.run(["--parent-id", "parent-id", "--name", "-", "--position", "top"]);
			});

			expect(
				{
					error,
					local: localTree("parent-id"),
				},
			).toStrictEqual(
				{
					error: undefined,
					local: [
						{
							id: uuid(2),
							name: "First",
							children: [
								{
									id: uuid(3),
									name: "Child",
								},
							],
						},
						{
							id: uuid(4),
							name: "Second",
						},
						{
							id: "sibling-id",
							name: "Sibling",
						},
					],
				},
			);
		});

		it("sends non-outline markdown as a single node name", async () =>
		{
			seedParent();
			fakeUpstream(fetchStub, testDatabase, tempDir);
			pipeStdin("## Section 1\n\nParagraph text\n- a bullet\n");

			const {error} = await captureOutput(async () =>
			{
				await Create.run(["--parent-id", "parent-id", "--name", "-"]);
			});

			expect(
				{
					error,
					local: localTree("parent-id"),
				},
			).toStrictEqual(
				{
					error: undefined,
					local: [
						{
							id: "sibling-id",
							name: "Sibling",
						},
						{
							id: uuid(2),
							name: "## Section 1\n\nParagraph text\n- a bullet\n",
						},
					],
				},
			);
		});
	});

	describe("command metadata", () =>
	{
		it("has correct description", () =>
		{
			expect(Create.description).toBe("Create a new Workflowy node or tree of nodes from JSON");
		});

		it("has examples", () =>
		{
			expect(Create.examples).toStrictEqual([
				"# Create node in inbox (system target)",
				'<%= config.bin %> <%= command.id %> --parent-id inbox --name "New Task"',
				"",
				"# Create a top-level node (Home)",
				'<%= config.bin %> <%= command.id %> --parent-id home --name "Area"',
				"",
				"# Create node under a parent by ID",
				'<%= config.bin %> <%= command.id %> --parent-id abc123 --name "Subtask"',
				"",
				"# Create node under a parent by path",
				'<%= config.bin %> <%= command.id %> --parent-path "Work,Projects" --name "Subtask"',
				"",
				"# Create node with a specific layout mode",
				'<%= config.bin %> <%= command.id %> --parent-id abc123 --name "Notes" --layout-mode document',
				"",
				"# Create from stdin (use - for name)",
				String.raw`echo "## Section 1\n\nParagraph text" | <%= config.bin %> <%= command.id %> --parent-id abc123 --name -`,
				"",
				"# Import article content via clean-mark",
				"npx clean-mark https://example.com/article --stdout | <%= config.bin %> <%= command.id %> --parent-id abc123 --name -",
				"",
				"# Preview the API call without creating",
				'<%= config.bin %> <%= command.id %> --parent-id inbox --name "New Task" --dry-run',
				"",
				"# Create nested nodes from inline JSON",
				'<%= config.bin %> <%= command.id %> --parent-id abc123 --json \'{"name": "Project", "children": [{"name": "Task 1"}, {"name": "Task 2"}]}\'',
				"",
				"# Create nested nodes from a JSON file",
				"<%= config.bin %> <%= command.id %> --parent-id abc123 --json-file ./project-template.json",
				"",
				"# Create node under a path, creating missing segments (like mkdir -p)",
				'<%= config.bin %> <%= command.id %> --parent-path "Metadata,Scanner State,my-scanner" --name "state.json" --create-path',
			]);
		});
	});
});
