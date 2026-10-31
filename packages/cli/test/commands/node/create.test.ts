import {it, vi, afterEach, expect, describe, beforeEach} from "vite-plus/test";
import {captureOutput} from "@oclif/test";
import {nodeContent} from "@workflowy/shared/db";
import {FAR_FUTURE_DATE} from "@workflowy/shared/temporal";
import {and, eq} from "drizzle-orm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {MockInstance} from "vite-plus/test";
import {z} from "zod";
import {WorkflowyInternalAdapter} from "@workflowy/shared/internal";
import {storeTreeTxId} from "@workflowy/shared/cache";
import Create from "../../../src/commands/node/create.js";
import {cleanupTestDatabase, createTestDatabase, nodeFixtures, seedTestData} from "../../db/migration-helper.js";
import type {TestDatabase} from "../../db/migration-helper.js";
import {seedTaggedCalendar} from "../../helpers/calendar-fixture.js";
import {createTestNode} from "../../helpers/node-fixtures.js";
import {catchUpResponse} from "../../helpers/internal-catch-up.js";
import {requestBody, requestJson} from "../../helpers/request-body.js";

describe("node create command", () => {
	let originalEnv: typeof process.env;
	let fetchStub: MockInstance<typeof fetch>;
	let tempDir: string;
	let testDatabase: TestDatabase;

	beforeEach(() => {
		originalEnv = {...process.env};

		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflowy-create-test-"));
		const testDbPath = path.join(tempDir, "test.sqlite");
		testDatabase = createTestDatabase(testDbPath);
		process.env.WORKFLOWY_DB_PATH = testDbPath;
		process.env.WORKFLOWY_API_KEY = "test-api-key";

		fetchStub = vi.spyOn(globalThis, "fetch");

		vi.useFakeTimers({shouldAdvanceTime: true});
		vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
		process.env = originalEnv;

		cleanupTestDatabase(testDatabase);

		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, {recursive: true, force: true});
		}
	});

	const createBodySchema = z.looseObject({name: z.string(), note: z.string().optional(), parent_id: z.string()});

	/** Each fetch made, as `METHOD url`. */
	const requests = () =>
		fetchStub.mock.calls.map(
			([url, init]) => `${init?.method ?? "GET"} ${url instanceof Request ? url.url : String(url)}`,
		);

	/**
	 * Answer each create with the next of `ids`, and a GET of a created node with
	 * what was sent for it. Returns the create request bodies, in order.
	 */
	function fakeCreates(...ids: string[]): unknown[] {
		const bodies: unknown[] = [];
		const created = new Map<string, {name: string; note?: string; parent_id: string}>();
		fetchStub.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
			if (init?.method === "POST") {
				const body = createBodySchema.parse(requestJson(init));
				const id = ids[bodies.length];
				if (id === undefined) {
					throw new Error("fakeCreates ran out of ids");
				}
				bodies.push(body);
				created.set(id, body);
				return Promise.resolve(Response.json({item_id: id}, {status: 200}));
			}
			const toApi = (id: string) => {
				const body = created.get(id)!;
				const now = Math.floor(Date.now() / 1000);
				return {
					id,
					name: body.name,
					note: body.note ?? null,
					parent_id: body.parent_id,
					priority: 100 * bodies.indexOf(body),
					completed: false,
					createdAt: now,
					modifiedAt: now,
					completedAt: null,
				};
			};
			const target = new URL(url instanceof Request ? url.url : url.toString());
			const parentId = target.searchParams.get("parent_id");
			if (parentId !== null) {
				const nodes = [...created].filter(([, body]) => body.parent_id === parentId).map(([id]) => toApi(id));
				return Promise.resolve(Response.json({nodes}, {status: 200}));
			}
			return Promise.resolve(Response.json({node: toApi(target.pathname.split("/").pop()!)}, {status: 200}));
		});
		return bodies;
	}

	describe("environment variable validation", () => {
		it("requires WORKFLOWY_API_KEY", async () => {
			delete process.env.WORKFLOWY_API_KEY;

			await expect(Create.run(["--parent-id", "inbox", "--name", "Test"])).rejects.toThrow(
				"WORKFLOWY_API_KEY environment variable is required",
			);
		});
	});

	describe("flag validation", () => {
		it("requires either --name, --json, or --json-file", async () => {
			seedTestData(
				testDatabase,
				nodeFixtures([createTestNode({id: "parent-id", name: "Parent", parentId: null})]),
			);

			await expect(Create.run(["--parent-id", "parent-id"])).rejects.toThrow(
				"Either --name, --json, or --json-file is required",
			);
		});

		it("requires parent specifier", async () => {
			await expect(Create.run(["--name", "Test Node"])).rejects.toThrow("Parent node is required");
		});
	});

	describe("dry run mode", () => {
		it("shows API call without executing for single node", async () => {
			seedTestData(
				testDatabase,
				nodeFixtures([createTestNode({id: "parent-id", name: "Parent", parentId: null})]),
			);

			const {stdout} = await captureOutput(async () => {
				await Create.run(["--parent-id", "parent-id", "--name", "Test Node", "--dry-run"]);
			});

			expect(fetchStub.mock.calls).toStrictEqual([]);
			expect(stdout).toBe(
				'Would execute API call:\n  Method: POST\n  URL: https://workflowy.com/api/v1/nodes/\n  Headers:\n    Authorization: Bearer <WORKFLOWY_API_KEY>\n    Content-Type: application/json\n  Body:\n    {\n      "parent_id": "parent-id",\n      "name": "Test Node"\n    }\n\nParent: Parent\n',
			);
		});

		it("accepts an empty --name for a blank node", async () => {
			seedTestData(
				testDatabase,
				nodeFixtures([createTestNode({id: "parent-id", name: "Parent", parentId: null})]),
			);

			const {stdout} = await captureOutput(async () => {
				await Create.run(["--parent-id", "parent-id", "--name", "", "--dry-run"]);
			});

			expect(fetchStub.mock.calls).toStrictEqual([]);
			expect(stdout).toBe(
				'Would execute API call:\n  Method: POST\n  URL: https://workflowy.com/api/v1/nodes/\n  Headers:\n    Authorization: Bearer <WORKFLOWY_API_KEY>\n    Content-Type: application/json\n  Body:\n    {\n      "parent_id": "parent-id",\n      "name": ""\n    }\n\nParent: Parent\n',
			);
		});

		it("includes note in dry run output", async () => {
			seedTestData(
				testDatabase,
				nodeFixtures([createTestNode({id: "parent-id", name: "Parent", parentId: null})]),
			);

			const {stdout} = await captureOutput(async () => {
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
				'Would execute API call:\n  Method: POST\n  URL: https://workflowy.com/api/v1/nodes/\n  Headers:\n    Authorization: Bearer <WORKFLOWY_API_KEY>\n    Content-Type: application/json\n  Body:\n    {\n      "parent_id": "parent-id",\n      "name": "Test Node",\n      "note": "This is a note"\n    }\n\nParent: Parent\n',
			);
		});

		it("includes layout mode in dry run output", async () => {
			seedTestData(
				testDatabase,
				nodeFixtures([createTestNode({id: "parent-id", name: "Parent", parentId: null})]),
			);

			const {stdout} = await captureOutput(async () => {
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
				'Would execute API call:\n  Method: POST\n  URL: https://workflowy.com/api/v1/nodes/\n  Headers:\n    Authorization: Bearer <WORKFLOWY_API_KEY>\n    Content-Type: application/json\n  Body:\n    {\n      "parent_id": "parent-id",\n      "name": "Test Node",\n      "layoutMode": "document"\n    }\n\nParent: Parent\n',
			);
		});
	});

	describe("single node creation", () => {
		it("creates node via API and updates cache", async () => {
			const createdNodeId = "new-node-id";

			seedTestData(
				testDatabase,
				nodeFixtures([createTestNode({id: "parent-id", name: "Parent", parentId: null})]),
			);

			// The API returns just {item_id: "..."}, so the created node is read back for its priority
			fakeCreates(createdNodeId);

			const {stdout} = await captureOutput(async () => {
				await Create.run(["--parent-id", "parent-id", "--name", "Test Node"]);
			});

			expect(stdout).toBe(
				"Creating node: Test Node\nParent: Parent\n\nSuccessfully created node\n  ID: new-node-id\n  Name: Test Node\n  Created: 2026-01-01T00:00:00.000Z\n  URL: https://workflowy.com/#/newnodeid\n",
			);
			expect(requests()).toStrictEqual([
				"POST https://workflowy.com/api/v1/nodes/",
				"GET https://workflowy.com/api/v1/nodes/new-node-id",
				"GET https://workflowy.com/api/v1/nodes?parent_id=parent-id",
			]);
		});

		it("sends correct request body", async () => {
			seedTestData(
				testDatabase,
				nodeFixtures([createTestNode({id: "parent-id", name: "Parent", parentId: null})]),
			);

			const bodies = fakeCreates("new-id");

			await captureOutput(async () => {
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

			expect(bodies).toStrictEqual([
				{
					parent_id: "parent-id",
					name: "Test Node",
					note: "A note",
					layoutMode: "document",
				},
			]);
		});
	});

	describe("backlinks", () => {
		it("syncs the new node's backlinks through the internal API when its text links to a node", async () => {
			process.env.WORKFLOWY_USERNAME = "alice@example.com";
			process.env.WORKFLOWY_PASSWORD = "hunter2";
			process.env.WORKFLOWY_SESSION_FILE = path.join(tempDir, "workflowy-session");
			seedTestData(
				testDatabase,
				nodeFixtures([createTestNode({id: "parent-id", name: "Parent", parentId: null})]),
			);
			storeTreeTxId(testDatabase.db, "1234567");
			fakeCreates("new-id");
			const publicApi = fetchStub.getMockImplementation()!;
			fetchStub.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
				const {pathname} = new URL(url instanceof Request ? url.url : url.toString());
				if (pathname === "/ajax_login") {
					return Promise.resolve(
						new Response("", {status: 200, headers: {"set-cookie": "sessionid=abc; Path=/"}}),
					);
				}
				const internal = catchUpResponse(pathname);
				if (internal !== undefined) {
					return Promise.resolve(internal);
				}
				return publicApi(url, init);
			});

			await captureOutput(async () => {
				await Create.run([
					"--parent-id",
					"parent-id",
					"--name",
					'see <a href="https://workflowy.com/#/0123456789ab">t</a>',
				]);
			});

			expect(
				requests()
					.filter((entry) => !entry.includes("/api/v1/"))
					.map((entry) => entry.split("?")[0]),
			).toStrictEqual([
				"POST https://workflowy.com/ajax_login",
				"GET https://workflowy.com/get_initialization_data",
				"POST https://workflowy.com/push_and_poll",
			]);
		});
		it("syncs the backlinks of every node a --json tree creates with a link, in one call", async () => {
			process.env.WORKFLOWY_USERNAME = "alice@example.com";
			process.env.WORKFLOWY_PASSWORD = "hunter2";
			process.env.WORKFLOWY_SESSION_FILE = path.join(tempDir, "workflowy-session");
			seedTestData(
				testDatabase,
				nodeFixtures([createTestNode({id: "parent-id", name: "Parent", parentId: null})]),
			);
			fakeCreates("root-id", "plain-id", "linked-id");
			const sync = vi
				.spyOn(WorkflowyInternalAdapter.prototype, "syncBacklinks")
				.mockResolvedValue({created: [], referencesRoots: [], deleted: []});
			const link = '<a href="https://workflowy.com/#/0123456789ab">t</a>';

			await captureOutput(async () => {
				await Create.run([
					"--parent-id",
					"parent-id",
					"--json",
					JSON.stringify({
						name: `root ${link}`,
						children: [{name: "plain"}, {name: "linked", note: link}],
					}),
				]);
			});

			expect(sync.mock.calls).toStrictEqual([[["root-id", "linked-id"]]]);
		});

		it("leaves the internal API alone when no node of a --json tree links anywhere", async () => {
			seedTestData(
				testDatabase,
				nodeFixtures([createTestNode({id: "parent-id", name: "Parent", parentId: null})]),
			);
			fakeCreates("root-id");
			const sync = vi.spyOn(WorkflowyInternalAdapter.prototype, "syncBacklinks");

			await captureOutput(async () => {
				await Create.run(["--parent-id", "parent-id", "--json", JSON.stringify({name: "plain"})]);
			});

			expect(sync.mock.calls).toStrictEqual([]);
		});
	});

	describe("calendar adoption", () => {
		const day21 = '<time startYear="2026" startMonth="10" startDay="21">Wed, Oct 21, 2026</time>';
		const useInternalAuth = () => {
			process.env.WORKFLOWY_USERNAME = "alice@example.com";
			process.env.WORKFLOWY_PASSWORD = "hunter2";
			process.env.WORKFLOWY_SESSION_FILE = path.join(tempDir, "workflowy-session");
		};
		// The fake clock stands still between its 20 ms steps, so step past the seed's millisecond before the command re-reads a seeded row.
		const seedCalendar = () => {
			seedTaggedCalendar(testDatabase);
			vi.setSystemTime(Date.now() + 1);
		};
		const noInternalAuth = () => {
			delete process.env.WORKFLOWY_USERNAME;
			delete process.env.WORKFLOWY_PASSWORD;
			process.env.WORKFLOWY_SESSION_FILE = path.join(tempDir, "no-session");
		};

		it("tags a dated row created under a calendar month as that day", async () => {
			seedCalendar();
			useInternalAuth();
			fakeCreates("new-id");
			const setMeta = vi.spyOn(WorkflowyInternalAdapter.prototype, "setNodeMetaValues").mockResolvedValue();

			await captureOutput(async () => {
				await Create.run(["--parent-id", "m10", "--name", day21]);
			});

			expect(setMeta.mock.calls).toStrictEqual([
				[
					"new-id",
					[
						{
							path: ["calendar"],
							value: {
								level: "day",
								value: "21",
								timestamp: new Date(2026, 9, 21).getTime(),
								dateId: 20_261_021,
							},
						},
					],
				],
			]);
		});

		it("makes no metadata call under a non-calendar parent", async () => {
			seedCalendar();
			seedTestData(testDatabase, nodeFixtures([createTestNode({id: "plain", name: "Plain", parentId: null})]));
			useInternalAuth();
			fakeCreates("new-id");
			const setMeta = vi.spyOn(WorkflowyInternalAdapter.prototype, "setNodeMetaValues").mockResolvedValue();

			await captureOutput(async () => {
				await Create.run(["--parent-id", "plain", "--name", day21]);
			});

			expect(setMeta.mock.calls).toStrictEqual([]);
		});

		it("warns on stderr and exits 0 without internal auth", async () => {
			seedCalendar();
			noInternalAuth();
			fakeCreates("new-id");

			const {stderr, error} = await captureOutput(async () => {
				await Create.run(["--parent-id", "m10", "--name", day21]);
			});

			expect({stderr, error}).toStrictEqual({
				stderr: `warning: ${day21} was created under a 📆 Calendar month without calendar metadata; workflowy.com will not use it as that day. Run ./bin/run.js calendar day --date YYYY-MM-DD --ensure instead.\n`,
				error: undefined,
			});
		});

		it("ensures a missing calendar month for --create-path instead of creating a name-only one", async () => {
			seedCalendar();
			useInternalAuth();
			const ensure = vi
				.spyOn(WorkflowyInternalAdapter.prototype, "ensureCalendarDay")
				.mockResolvedValue({dayId: "ensured-month", firstChildId: null, created: ["ensured-month"]});
			const bodies = fakeCreates("new-id");

			await captureOutput(async () => {
				await Create.run(["--parent-path", "📆 Calendar,2026,11", "--create-path", "--name", "Entry"]);
			});

			expect({calls: ensure.mock.calls, bodies}).toStrictEqual({
				calls: [[20_261_101, {stopAt: "month", createChild: false}]],
				bodies: [{parent_id: "ensured-month", name: "Entry"}],
			});
		});
	});

	describe("parent resolution", () => {
		it("resolves parent by ID", async () => {
			seedTestData(
				testDatabase,
				nodeFixtures([createTestNode({id: "specific-parent-id", name: "Parent", parentId: null})]),
			);

			const bodies = fakeCreates("new-id");

			await captureOutput(async () => {
				await Create.run(["--parent-id", "specific-parent-id", "--name", "Test"]);
			});

			expect(bodies).toStrictEqual([{parent_id: "specific-parent-id", name: "Test"}]);
		});

		it("resolves parent by path", async () => {
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode({id: "work-id", name: "Work", parentId: null}),
					createTestNode({id: "projects-id", name: "Projects", parentId: "work-id"}),
				]),
			);

			const bodies = fakeCreates("new-id");

			await captureOutput(async () => {
				await Create.run(["--parent-path", "Work,Projects", "--name", "Test"]);
			});

			expect(bodies).toStrictEqual([{parent_id: "projects-id", name: "Test"}]);
		});

		it("resolves system target via --parent-id", async () => {
			// The API accepts 'inbox' as parent_id on create but 404s on GET /nodes/inbox,
			// so the real parent is learned by fetching the created node.
			seedTestData(
				testDatabase,
				nodeFixtures([createTestNode({id: "inbox-uuid", name: "Inbox", parentId: null})]),
			);

			const now = Math.floor(Date.now() / 1000);
			const capturedRequests: string[] = [];
			let capturedBody: string | undefined;

			fetchStub.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
				const urlStr = url instanceof Request ? url.url : String(url);
				const method = init?.method ?? "GET";
				capturedRequests.push(`${method} ${urlStr}`);

				if (method === "POST" && urlStr.endsWith("/nodes/")) {
					capturedBody = requestBody(init);
					return Promise.resolve(Response.json({item_id: "new-id"}, {status: 200}));
				}

				const node = {
					id: "new-id",
					name: "Test",
					note: null,
					parent_id: "inbox-uuid",
					priority: 0,
					completed: false,
					createdAt: now,
					modifiedAt: now,
					completedAt: null,
					data: {layoutMode: "bullets"},
				};
				if (method === "GET" && urlStr.endsWith("/nodes/new-id")) {
					return Promise.resolve(Response.json({node}, {status: 200}));
				}
				if (method === "GET" && urlStr.endsWith("/nodes?parent_id=inbox-uuid")) {
					return Promise.resolve(Response.json({nodes: [node]}, {status: 200}));
				}

				return Promise.resolve(Response.json({error: "Not found"}, {status: 404}));
			});

			const {stdout} = await captureOutput(async () => {
				await Create.run(["--parent-id", "inbox", "--name", "Test"]);
			});

			expect(stdout).toBe(
				"Creating node: Test\nParent: \n\nSuccessfully created node\n  ID: new-id\n  Name: Test\n  Created: 2026-01-01T00:00:00.000Z\n  URL: https://workflowy.com/#/newid\n",
			);
			expect(JSON.parse(capturedBody!)).toStrictEqual({parent_id: "inbox", name: "Test"});
			expect(capturedRequests).toStrictEqual([
				"POST https://workflowy.com/api/v1/nodes/",
				"GET https://workflowy.com/api/v1/nodes/new-id",
				"GET https://workflowy.com/api/v1/nodes?parent_id=inbox-uuid",
			]);
			expect(
				testDatabase.db
					.select({id: nodeContent.id, name: nodeContent.name, parentId: nodeContent.parentId})
					.from(nodeContent)
					.where(and(eq(nodeContent.id, "new-id"), eq(nodeContent.systemTo, FAR_FUTURE_DATE)))
					.all(),
			).toStrictEqual([{id: "new-id", name: "Test", parentId: "inbox-uuid"}]);
		});
	});

	describe("home (top level)", () => {
		it("dry run omits parent_id and shows Home as the parent", async () => {
			const {stdout} = await captureOutput(async () => {
				await Create.run(["--parent-id", "home", "--name", "Top", "--dry-run"]);
			});

			expect(fetchStub.mock.calls).toStrictEqual([]);
			expect(stdout).toBe(
				'Would execute API call:\n  Method: POST\n  URL: https://workflowy.com/api/v1/nodes/\n  Headers:\n    Authorization: Bearer <WORKFLOWY_API_KEY>\n    Content-Type: application/json\n  Body:\n    {\n      "name": "Top"\n    }\n\nParent: Home\n',
			);
		});

		it("creates a top-level node by omitting parent_id, and caches it with a null parent", async () => {
			const now = Math.floor(Date.now() / 1000);
			const node = {
				id: "new-id",
				name: "Top",
				note: null,
				parent_id: null,
				priority: 0,
				completed: false,
				createdAt: now,
				modifiedAt: now,
				completedAt: null,
				data: {layoutMode: "bullets"},
			};
			const bodies: unknown[] = [];
			fetchStub.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
				const urlStr = url instanceof Request ? url.url : String(url);
				const method = init?.method ?? "GET";
				if (method === "POST" && urlStr === "https://workflowy.com/api/v1/nodes/") {
					bodies.push(requestJson(init));
					return Promise.resolve(Response.json({item_id: "new-id"}, {status: 200}));
				}
				if (method === "GET" && urlStr === "https://workflowy.com/api/v1/nodes/new-id") {
					return Promise.resolve(Response.json({node}, {status: 200}));
				}
				if (method === "GET" && urlStr === "https://workflowy.com/api/v1/nodes") {
					return Promise.resolve(Response.json({nodes: [node]}, {status: 200}));
				}
				return Promise.resolve(Response.json({error: "Not found"}, {status: 404}));
			});

			const {stdout} = await captureOutput(async () => {
				await Create.run(["--parent-id", "home", "--name", "Top"]);
			});

			expect({stdout, bodies, requests: requests()}).toStrictEqual({
				stdout: "Creating node: Top\nParent: Home\n\nSuccessfully created node\n  ID: new-id\n  Name: Top\n  Created: 2026-01-01T00:00:00.000Z\n  URL: https://workflowy.com/#/newid\n",
				bodies: [{name: "Top"}],
				requests: [
					"POST https://workflowy.com/api/v1/nodes/",
					"GET https://workflowy.com/api/v1/nodes/new-id",
					"GET https://workflowy.com/api/v1/nodes",
				],
			});
			expect(
				testDatabase.db
					.select({id: nodeContent.id, name: nodeContent.name, parentId: nodeContent.parentId})
					.from(nodeContent)
					.where(and(eq(nodeContent.id, "new-id"), eq(nodeContent.systemTo, FAR_FUTURE_DATE)))
					.all(),
			).toStrictEqual([{id: "new-id", name: "Top", parentId: null}]);
		});
	});

	describe("JSON mode", () => {
		it("creates single node from JSON", async () => {
			seedTestData(
				testDatabase,
				nodeFixtures([createTestNode({id: "parent-id", name: "Parent", parentId: null})]),
			);

			fakeCreates("new-id");

			const {stdout} = await captureOutput(async () => {
				await Create.run(["--parent-id", "parent-id", "--json", '{"name": "JSON Node"}']);
			});

			expect(stdout).toBe(
				'Creating node tree...\nParent: Parent\n\nSuccessfully created node tree:\n- JSON Node\n  ID: new-id\n  URL: https://workflowy.com/#/newid\n\nCreated node IDs (JSON):\n[\n  {\n    "id": "new-id",\n    "name": "JSON Node",\n    "parentId": null\n  }\n]\n',
			);
		});

		it("creates nested tree from JSON", async () => {
			seedTestData(
				testDatabase,
				nodeFixtures([createTestNode({id: "parent-id", name: "Parent", parentId: null})]),
			);

			fakeCreates("node-1", "node-2", "node-3");

			const json = JSON.stringify({
				name: "Project",
				children: [{name: "Task 1"}, {name: "Task 2"}],
			});

			const {stdout} = await captureOutput(async () => {
				await Create.run(["--parent-id", "parent-id", "--json", json]);
			});

			expect(requests()).toStrictEqual([
				"POST https://workflowy.com/api/v1/nodes/",
				"GET https://workflowy.com/api/v1/nodes/node-1",
				"GET https://workflowy.com/api/v1/nodes?parent_id=parent-id",
				"POST https://workflowy.com/api/v1/nodes/",
				"GET https://workflowy.com/api/v1/nodes/node-2",
				"GET https://workflowy.com/api/v1/nodes?parent_id=node-1",
				"POST https://workflowy.com/api/v1/nodes/",
				"GET https://workflowy.com/api/v1/nodes/node-3",
				"GET https://workflowy.com/api/v1/nodes?parent_id=node-1",
			]);
			expect(stdout).toBe(
				'Creating node tree...\nParent: Parent\n\nSuccessfully created node tree:\n- Project\n  ID: node-1\n  URL: https://workflowy.com/#/node1\n  - Task 1\n    ID: node-2\n    URL: https://workflowy.com/#/node2\n  - Task 2\n    ID: node-3\n    URL: https://workflowy.com/#/node3\n\nCreated node IDs (JSON):\n[\n  {\n    "id": "node-1",\n    "name": "Project",\n    "parentId": null\n  },\n  {\n    "id": "node-2",\n    "name": "Task 1",\n    "parentId": "node-1"\n  },\n  {\n    "id": "node-3",\n    "name": "Task 2",\n    "parentId": "node-1"\n  }\n]\n',
			);
		});

		it("dry run shows node tree preview for JSON", async () => {
			seedTestData(
				testDatabase,
				nodeFixtures([createTestNode({id: "parent-id", name: "Parent", parentId: null})]),
			);

			const json = JSON.stringify({
				name: "Project",
				children: [{name: "Task 1"}, {name: "Task 2"}],
			});

			const {stdout} = await captureOutput(async () => {
				await Create.run(["--parent-id", "parent-id", "--json", json, "--dry-run"]);
			});

			expect(stdout).toBe(
				"Would create the following node tree:\n\nParent: Parent\n\n- Project\n  - Task 1\n  - Task 2\n\nAPI calls that would be made:\n  3 POST requests to https://workflowy.com/api/v1/nodes/\n",
			);
			expect(fetchStub.mock.calls).toStrictEqual([]);
		});

		it("handles invalid JSON in --json flag", async () => {
			seedTestData(
				testDatabase,
				nodeFixtures([createTestNode({id: "parent-id", name: "Parent", parentId: null})]),
			);

			await expect(Create.run(["--parent-id", "parent-id", "--json", "not valid json"])).rejects.toThrow(
				"Invalid JSON",
			);
		});

		it("validates JSON structure", async () => {
			seedTestData(
				testDatabase,
				nodeFixtures([createTestNode({id: "parent-id", name: "Parent", parentId: null})]),
			);

			await expect(
				Create.run(["--parent-id", "parent-id", "--json", '{"invalid": "structure"}']),
			).rejects.toThrow("Invalid JSON structure");
		});
	});

	describe("JSON file mode", () => {
		it("creates nodes from JSON file", async () => {
			seedTestData(
				testDatabase,
				nodeFixtures([createTestNode({id: "parent-id", name: "Parent", parentId: null})]),
			);

			const jsonPath = path.join(tempDir, "nodes.json");
			fs.writeFileSync(jsonPath, JSON.stringify({name: "File Node"}));

			fakeCreates("new-id");

			const {stdout} = await captureOutput(async () => {
				await Create.run(["--parent-id", "parent-id", "--json-file", jsonPath]);
			});

			expect(stdout).toBe(
				'Creating node tree...\nParent: Parent\n\nSuccessfully created node tree:\n- File Node\n  ID: new-id\n  URL: https://workflowy.com/#/newid\n\nCreated node IDs (JSON):\n[\n  {\n    "id": "new-id",\n    "name": "File Node",\n    "parentId": null\n  }\n]\n',
			);
		});

		it("handles non-existent JSON file", async () => {
			seedTestData(
				testDatabase,
				nodeFixtures([createTestNode({id: "parent-id", name: "Parent", parentId: null})]),
			);

			await expect(
				Create.run(["--parent-id", "parent-id", "--json-file", "/nonexistent/file.json"]),
			).rejects.toThrow("File not found");
		});
	});

	describe("output", () => {
		it("displays node ID and URL after creation", async () => {
			const newNodeId = "created-node-id";

			seedTestData(
				testDatabase,
				nodeFixtures([createTestNode({id: "parent-id", name: "Parent", parentId: null})]),
			);

			fakeCreates(newNodeId);

			const {stdout} = await captureOutput(async () => {
				await Create.run(["--parent-id", "parent-id", "--name", "Test Node"]);
			});

			expect(stdout).toBe(
				"Creating node: Test Node\nParent: Parent\n\nSuccessfully created node\n  ID: created-node-id\n  Name: Test Node\n  Created: 2026-01-01T00:00:00.000Z\n  URL: https://workflowy.com/#/reatednodeid\n",
			);
		});

		it("displays parent path in output", async () => {
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode({id: "work-id", name: "Work", parentId: null}),
					createTestNode({id: "projects-id", name: "Projects", parentId: "work-id"}),
				]),
			);

			fakeCreates("new-id");

			const {stdout} = await captureOutput(async () => {
				await Create.run(["--parent-path", "Work,Projects", "--name", "Test"]);
			});

			expect(stdout).toBe(
				"Creating node: Test\nParent: Work > Projects\n\nSuccessfully created node\n  ID: new-id\n  Name: Test\n  Created: 2026-01-01T00:00:00.000Z\n  URL: https://workflowy.com/#/newid\n",
			);
		});
	});

	describe("command metadata", () => {
		it("has correct description", () => {
			expect(Create.description).toBe("Create a new Workflowy node or tree of nodes from JSON");
		});

		it("has examples", () => {
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
