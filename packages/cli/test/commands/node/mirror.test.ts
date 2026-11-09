import {it, vi, afterEach, expect, describe, beforeEach} from "vite-plus/test";
import {captureOutput} from "@oclif/test";
import {mirrors, nodeContent, nodeMetadata} from "@outlinedb/shared/db";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import {storeTreeTxId} from "@outlinedb/shared/cache";
import {and, eq} from "drizzle-orm";
import {z} from "zod";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {MockInstance} from "vite-plus/test";
import Mirror from "../../../src/commands/node/mirror.js";
import {cleanupTestDatabase, createTestDatabase, nodeFixtures, seedTestData} from "../../db/migration-helper.js";
import type {TestDatabase} from "../../db/migration-helper.js";
import {createTestNode} from "../../helpers/node-fixtures.js";
import {requestJson} from "../../helpers/request-body.js";

const ORIGIN_ID = "10e2d6c2-d165-b390-9484-d4fdbf4c4afa";
const PARENT_ID = "a71aed23-b0cc-4000-8000-000000000001";
const MIRROR_ID = "b82bfe34-c1dd-4000-8000-000000000002";

const NodeMirrorResultSchema = z.object({
	action: z.string(),
	mirrorId: z.string(),
	originId: z.string().nullable(),
	parentId: z.string().nullable(),
});

describe("node:mirror command", () => {
	let originalEnv: typeof process.env;
	let fetchStub: MockInstance;
	let tempDir: string;
	let testDatabase: TestDatabase;

	beforeEach(() => {
		originalEnv = {...process.env};

		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflowy-mirror-test-"));
		const testDbPath = path.join(tempDir, "test.sqlite");
		testDatabase = createTestDatabase(testDbPath);
		process.env.WORKFLOWY_DB_PATH = testDbPath;
		process.env.WORKFLOWY_API_KEY = "test-api-key";
		delete process.env.WORKFLOWY_API_URL;

		fetchStub = vi.spyOn(globalThis, "fetch");

		seedTestData(
			testDatabase,
			nodeFixtures([
				createTestNode({id: ORIGIN_ID, name: "Origin Task", parentId: null}),
				createTestNode({id: PARENT_ID, name: "Agendas", parentId: null}),
			]),
		);
	});

	afterEach(() => {
		process.env = originalEnv;
		fetchStub.mockRestore();
		cleanupTestDatabase(testDatabase);
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, {recursive: true, force: true});
		}
	});

	function stubCreateMirrorApi(): {method: string; url: string; body: unknown}[] {
		const calls: {method: string; url: string; body: unknown}[] = [];
		fetchStub.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
			const urlStr = url instanceof Request ? url.url : String(url);
			const method = init?.method ?? "GET";
			calls.push({method, url: urlStr, body: requestJson(init)});

			if (method === "POST" && urlStr.endsWith(`/nodes/${ORIGIN_ID}/mirror`)) {
				return Promise.resolve(Response.json({item_id: MIRROR_ID, origin_id: ORIGIN_ID}, {status: 200}));
			}
			if (method === "GET" && urlStr.endsWith(`/nodes/${MIRROR_ID}`)) {
				return Promise.resolve(
					Response.json(
						{
							node: {
								id: MIRROR_ID,
								name: "Origin Task",
								parent_id: PARENT_ID,
								priority: 3,
								completed: false,
								createdAt: 1_760_000_000,
								modifiedAt: 1_760_000_000,
								completedAt: null,
								data: {},
							},
						},
						{status: 200},
					),
				);
			}
			return Promise.resolve(new Response("unexpected", {status: 500}));
		});
		return calls;
	}

	function currentMirrorRows() {
		return testDatabase.db
			.select({originalId: mirrors.originalId, mirrorId: mirrors.mirrorId})
			.from(mirrors)
			.where(eq(mirrors.systemTo, FAR_FUTURE_DATE))
			.all();
	}

	function currentContent(id: string) {
		return testDatabase.db
			.select({
				id: nodeContent.id,
				name: nodeContent.name,
				note: nodeContent.note,
				parentId: nodeContent.parentId,
			})
			.from(nodeContent)
			.where(and(eq(nodeContent.id, id), eq(nodeContent.systemTo, FAR_FUTURE_DATE)))
			.all();
	}

	describe("flag validation", () => {
		it("requires an origin node", async () => {
			await expect(Mirror.run(["--parent-id", PARENT_ID])).rejects.toThrow(
				"Either --node-id or --node-path is required",
			);
		});

		it("requires a parent when creating", async () => {
			await expect(Mirror.run(["--node-id", ORIGIN_ID])).rejects.toThrow(
				"Either --parent-id or --parent-path is required",
			);
		});

		it("requires WORKFLOWY_API_KEY", async () => {
			delete process.env.WORKFLOWY_API_KEY;
			await expect(Mirror.run(["--node-id", ORIGIN_ID, "--parent-id", PARENT_ID])).rejects.toThrow(
				"WORKFLOWY_API_KEY environment variable is required",
			);
		});
	});

	describe("creating a mirror", () => {
		it("posts to the mirror endpoint with short IDs expanded and position top by default", async () => {
			const calls = stubCreateMirrorApi();

			const {stdout} = await captureOutput(async () => {
				await Mirror.run(["--node-id", "d4fdbf4c4afa", "--parent-id", "000000000001"]);
			});

			expect(calls[0]).toStrictEqual({
				method: "POST",
				url: `https://workflowy.com/api/v1/nodes/${ORIGIN_ID}/mirror`,
				body: {parent_id: PARENT_ID, position: "top"},
			});
			expect(stdout).toBe(
				`Mirroring:\n  Origin: Origin Task\n  Into:   Agendas\nSuccessfully created mirror\n  ID: ${MIRROR_ID}\n  Origin: ${ORIGIN_ID}\n`,
			);
		});

		it("passes --position bottom through", async () => {
			const calls = stubCreateMirrorApi();

			await captureOutput(async () => {
				await Mirror.run(["--node-id", ORIGIN_ID, "--parent-id", PARENT_ID, "--position", "bottom"]);
			});

			expect(calls[0]?.body).toStrictEqual({parent_id: PARENT_ID, position: "bottom"});
		});

		it("writes the empty mirror node and mirror relationship through to the cache", async () => {
			stubCreateMirrorApi();

			await captureOutput(async () => {
				await Mirror.run(["--node-id", ORIGIN_ID, "--parent-id", PARENT_ID]);
			});

			expect(currentContent(MIRROR_ID)).toStrictEqual([
				{id: MIRROR_ID, name: "", note: null, parentId: PARENT_ID},
			]);
			const metadata = testDatabase.db
				.select({priority: nodeMetadata.priority})
				.from(nodeMetadata)
				.where(and(eq(nodeMetadata.nodeId, MIRROR_ID), eq(nodeMetadata.systemTo, FAR_FUTURE_DATE)))
				.all();
			expect(metadata).toStrictEqual([{priority: 3}]);
			expect(currentMirrorRows()).toStrictEqual([{originalId: ORIGIN_ID, mirrorId: MIRROR_ID}]);
		});

		it("emits JSON with --json", async () => {
			stubCreateMirrorApi();

			const {stdout} = await captureOutput(async () => {
				await Mirror.run(["--node-id", ORIGIN_ID, "--parent-id", PARENT_ID, "--json"]);
			});

			expect(JSON.parse(stdout)).toStrictEqual({
				action: "created",
				mirrorId: MIRROR_ID,
				originId: ORIGIN_ID,
				parentId: PARENT_ID,
			});
		});
	});

	describe("mirroring to home (top level)", () => {
		const INIT_BODY = {
			projectTreeData: {
				mainProjectTreeInfo: {
					dateJoinedTimestampInSeconds: 1_300_000_000,
					initialMostRecentOperationTransactionId: "1234567",
					ownerId: 42,
				},
				rootProjectMetadata: {},
			},
			settings: {},
			user: {id: 42},
			globals: [["CLIENT_VERSION", 25]],
		};
		const PushSchema = z.array(
			z.object({
				operations: z
					.array(z.object({type: z.string(), data: z.record(z.string(), z.unknown())}).loose())
					.default([]),
			}),
		);
		const TreesSchema = z.array(z.object({id: z.string()}).loose());

		function publicNode(id: string, name: string, priority: number) {
			return {
				id,
				name,
				note: null,
				parent_id: null,
				priority,
				completed: false,
				createdAt: 1_760_000_000,
				modifiedAt: 1_760_000_000,
				completedAt: null,
				data: {},
			};
		}

		/** The internal API (login, init, catch-up poll, push) and the public Home listing, which shows a pushed mirror on top. */
		function stubInternalApi(): {paths: string[]; ops: {type: string; data: Record<string, unknown>}[]} {
			const recorded: {paths: string[]; ops: {type: string; data: Record<string, unknown>}[]} = {
				paths: [],
				ops: [],
			};
			let mirrorId: string | undefined;
			fetchStub.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = new URL(input instanceof Request ? input.url : String(input));
				const method = init?.method ?? "GET";
				recorded.paths.push(`${method} ${url.pathname}`);
				if (url.pathname === "/ajax_login") {
					return Promise.resolve(
						new Response("", {status: 200, headers: {"set-cookie": "sessionid=abc123; Path=/"}}),
					);
				}
				if (url.pathname === "/get_initialization_data") {
					return Promise.resolve(
						Response.json(INIT_BODY, {headers: {wfclientid: "2026-10-18 12:00:00.123456"}}),
					);
				}
				if (url.pathname === "/push_and_poll") {
					const form = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
					const ops = PushSchema.parse(JSON.parse(form.get("push_poll_data") ?? "[]")).flatMap(
						(tree) => tree.operations,
					);
					recorded.ops.push(...ops);
					const create = ops.find((op) => op.type === "bulk_create");
					mirrorId ??= TreesSchema.parse(JSON.parse(z.string().parse(create?.data.project_trees ?? "[]")))[0]
						?.id;
					return Promise.resolve(
						Response.json({
							results: [
								{
									new_most_recent_operation_transaction_id: "1234568",
									server_run_operation_transaction_json: JSON.stringify({
										ops: [],
										client_timestamp: 492_324_800,
									}),
									concurrent_remote_operation_transactions: [],
									error_encountered_in_remote_operations: false,
								},
							],
						}),
					);
				}
				if (method === "GET" && url.pathname === "/api/v1/nodes") {
					const home = [publicNode(ORIGIN_ID, "Origin Task", 100), publicNode(PARENT_ID, "Agendas", 200)];
					return Promise.resolve(
						Response.json({nodes: mirrorId === undefined ? home : [publicNode(mirrorId, "", 0), ...home]}),
					);
				}
				return Promise.resolve(new Response("unexpected", {status: 500}));
			});
			return recorded;
		}

		beforeEach(() => {
			process.env.WORKFLOWY_USERNAME = "alice@example.com";
			process.env.WORKFLOWY_PASSWORD = "hunter2";
			process.env.WORKFLOWY_SESSION_FILE = path.join(tempDir, "workflowy-session");
			vi.useFakeTimers({toFake: ["Date"]});
			// A whole-tree import seeded the transaction-log position, a millisecond before the frozen test time.
			vi.setSystemTime(new Date("2026-10-18T11:59:59.999Z"));
			storeTreeTxId(testDatabase.db, "1234567");
			vi.setSystemTime(new Date("2026-10-18T12:00:00.000Z"));
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it("creates the mirror at the top of Home through the internal API and caches it", async () => {
			const recorded = stubInternalApi();

			const {stdout} = await captureOutput(async () => {
				await Mirror.run(["--node-id", ORIGIN_ID, "--parent-id", "home", "--json"]);
			});

			const result = NodeMirrorResultSchema.parse(JSON.parse(stdout));
			const mirrorId = result.mirrorId;
			expect({
				result,
				paths: recorded.paths.filter((entry) => !entry.startsWith("GET /api/v1/nodes")),
				ops: recorded.ops.map((op) => [op.type, op.data]),
				content: currentContent(mirrorId),
				mirrors: currentMirrorRows(),
			}).toStrictEqual({
				result: {action: "created", mirrorId, originId: ORIGIN_ID, parentId: null},
				paths: [
					"POST /ajax_login",
					"GET /get_initialization_data",
					"POST /push_and_poll",
					"POST /push_and_poll",
				],
				ops: [
					[
						"bulk_create",
						{
							parentid: "None",
							starting_priority: 0,
							project_trees: JSON.stringify([
								{
									id: mirrorId,
									nm: "",
									metadata: {mirror: {originalId: ORIGIN_ID, isMirrorRoot: true}},
									ct: 492_324_800,
									cb: 42,
									ch: [],
								},
							]),
							isForSearch: false,
						},
					],
					[
						"edit",
						{
							projectid: ORIGIN_ID,
							metadataPatches: [
								{op: "add", path: ["mirror"], value: {mirrorRootIds: {[mirrorId]: true}}},
							],
							metadataInversePatches: [{op: "remove", path: ["mirror"]}],
						},
					],
				],
				content: [{id: mirrorId, name: "", note: null, parentId: null}],
				mirrors: [{originalId: ORIGIN_ID, mirrorId}],
			});
		});

		it("places the mirror at the bottom of Home with --position bottom", async () => {
			const recorded = stubInternalApi();

			await captureOutput(async () => {
				await Mirror.run(["--node-id", ORIGIN_ID, "--parent-id", "home", "--position", "bottom"]);
			});

			expect(recorded.ops.find((op) => op.type === "bulk_create")?.data.starting_priority).toBe(2);
		});

		it("requires internal-API credentials before calling any API", async () => {
			delete process.env.WORKFLOWY_USERNAME;
			delete process.env.WORKFLOWY_PASSWORD;

			await expect(Mirror.run(["--node-id", ORIGIN_ID, "--parent-id", "home"])).rejects.toThrow(
				"Mirroring to Home needs the internal API: set WORKFLOWY_USERNAME and WORKFLOWY_PASSWORD in the environment (e.g. from .envrc)",
			);
			expect(fetchStub.mock.calls).toStrictEqual([]);
		});
	});

	describe("deleting a mirror", () => {
		beforeEach(() => {
			seedTestData(testDatabase, {
				...nodeFixtures([
					createTestNode({id: ORIGIN_ID, name: "Origin Task", parentId: null}),
					createTestNode({id: PARENT_ID, name: "Agendas", parentId: null}),
					createTestNode({id: MIRROR_ID, name: "", parentId: PARENT_ID}),
				]),
				mirrors: [
					{originalId: ORIGIN_ID, mirrorId: MIRROR_ID, systemFrom: "2026-01-01", systemTo: FAR_FUTURE_DATE},
				],
			});
		});

		it("sends DELETE to the mirror endpoint and removes the mirror from the cache", async () => {
			const calls: {method: string; url: string}[] = [];
			fetchStub.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
				calls.push({method: init?.method ?? "GET", url: url instanceof Request ? url.url : String(url)});
				return Promise.resolve(Response.json({status: "ok"}, {status: 200}));
			});

			const {stdout} = await captureOutput(async () => {
				await Mirror.run(["--node-id", "000000000002", "--delete"]);
			});

			expect(calls).toStrictEqual([
				{method: "DELETE", url: `https://workflowy.com/api/v1/nodes/${MIRROR_ID}/mirror`},
			]);
			expect(stdout).toBe(`Successfully deleted mirror ${MIRROR_ID}\n`);
			expect(currentContent(MIRROR_ID)).toStrictEqual([]);
			expect(currentMirrorRows()).toStrictEqual([]);
			expect(currentContent(ORIGIN_ID)).toStrictEqual([
				{id: ORIGIN_ID, name: "Origin Task", note: null, parentId: null},
			]);
		});

		it("rejects --delete combined with a parent", async () => {
			await expect(Mirror.run(["--node-id", MIRROR_ID, "--delete", "--parent-id", PARENT_ID])).rejects.toThrow(
				"--delete=true cannot also be provided when using --parent-id",
			);
		});
	});
});
