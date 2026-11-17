import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import path, {join} from "node:path";
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {WorkflowyInternalClient, SessionRejectedError} from "../src/api/workflowy-internal-client.js";
import {storeTreeTxId, readTreeTxId} from "../src/cache/tree-transaction.js";
import {AccountOutboxRecorder, readPendingAccountOutbox} from "../src/cache/account-outbox.js";
import {readAccountRows, readImportTime} from "../src/cache/account-store.js";
import {LocalAccount} from "../src/cache/local-account.js";
import {LocalTreeWriter} from "../src/cache/local-tree-writer.js";
import {OutboxRecorder} from "../src/cache/outbox.js";
import {ACCOUNT_COMPOSITE_TABLES, runUnitOfWork} from "../src/cache/node-composite.js";
import * as schema from "../src/db/schema.js";
import {WorkflowyInternalAdapter} from "../src/internal/adapter.js";
import
{
	OperationRejected,
	ExpansionNotSeeded,
	TreeResyncRequired,
	TreeNotSeeded,
	TreeRefreshRequired,
	UnreplayableTransaction,
	InternalApiError,
} from "../src/internal/errors.js";
import
{
	createFakeInternalApi,
	FAKE_CLIENT_ID,
	initializationData,
	json,
	forbidTreeData,
	treeDataReads,
	FAKE_SESSION_ID,
} from "./helpers/fake-internal-api.js";
import type {RecordedRequest} from "./helpers/fake-internal-api.js";
import {z} from "zod";
import {WorkflowyApiClient} from "../src/api/workflowy-client.js";
import {CacheService} from "../src/cache/cache-service.js";
import {collectItemRelationships, emptyItemRelationships} from "../src/cache/item-relationships.js";
import {WorkflowyWriteThroughClient} from "../src/cache/workflowy-write-through-client.js";
import {applyMetadataPatches, buildMetadataPatches} from "../src/internal/metadata-patch.js";
import type {MetadataPatch} from "../src/internal/metadata-patch.js";
import {hasInternalLink, internalLinkShortIds} from "../src/workflowy/internal-links.js";
import {importInternalMetadata, readInternalMetadata, storeInternalMetadata} from "../src/cache/internal-metadata.js";
import type {MoveToInput} from "../src/internal/adapter.js";
import {calendarLayoutWrites, layoutWriteParents} from "../src/internal/calendar-layout-apply.js";
import type {InternalSession, SessionCookieStore} from "../src/api/workflowy-internal-client.js";
import
{
	CalendarRootMissing,
	calendarDateId,
	calendarLevelMetadata,
	calendarLevelName,
	parseDateId,
} from "../src/internal/calendar-day.js";
import {calendarNodeId} from "../src/internal/calendar-ids.js";
import {PushAndPoll} from "../src/internal/push-and-poll.js";
import {FAR_FUTURE_DATE, systemTimeAt} from "../src/temporal/constants.js";
import {expansionVersion, replaceExpansion} from "../src/cache/expansion-store.js";
import type {WorkflowyNode} from "../src/types/index.js";
import {eq} from "drizzle-orm";
import fs from "node:fs";
import os from "node:os";
import {DEFAULT_SESSION_FILE, fileSessionStore, readInternalAuth} from "../src/node/session-store.js";
import
{
	bulkCreateOp,
	bulkMoveOp,
	clientTimestamp,
	completeOp,
	deleteOp,
	editOp,
	moveOp,
	ROOT_PROJECT_ID,
	uncompleteOp,
	undeleteOp,
} from "../src/internal/ops.js";

describe("internal adapter account", () =>
{
	const migrationsFolder = join(import.meta.dirname, "../src/db/migrations");
	const START_MS = 1_800_000_000_000;

	const SERVER_RUN = JSON.stringify(
		{
			ops: [
				{
					type: "edit",
					data:
					{
						projectid: "None",
					},
				},
			],
			client_timestamp: 300_000_000,
		},
	);

	function pushOk()
	{
		return json(
			{
				results: [
					{
						new_most_recent_operation_transaction_id: "4568",
						server_run_operation_transaction_json: SERVER_RUN,
						concurrent_remote_operation_transactions: [],
					},
				],
			},
		);
	}

	function setup()
	{
		const sqlite = new DatabaseConstructor(":memory:");
		const db = drizzle(
			sqlite,
			{
				schema,
			},
		);
		migrate(
			db,
			{
				migrationsFolder,
			},
		);
		// A whole-tree import seeded the transaction-log position at the fake init's id.
		storeTreeTxId(db, "4567");
		const api = createFakeInternalApi();
		const client = new WorkflowyInternalClient(
			{
				credentials:
				{
					username: "alice@example.com",
					password: "hunter2",
				},
				fetch: api.fetch,
				baseUrl: "https://workflowy.test",
				transientId: "6f1c1d1e-0000-4000-8000-000000000001",
			},
		);
		const clock =
		{
			ms: START_MS,
		};
		const adapter = new WorkflowyInternalAdapter(
			{
				client,
				db,
				now: () => clock.ms,
				pushAndPoll:
				{
					randomId: () => "pollid01",
					timezone: "America/New_York",
				},
			},
		);
		return {
			sqlite,
			db,
			api,
			adapter,
			clock,
		};
	}

	/** Every version of every account table and of the import times: a write that changes nothing leaves this equal. */
	function accountHistory(db: ReturnType<typeof setup>["db"])
	{
		return [...ACCOUNT_COMPOSITE_TABLES, schema.apiImportTimestamp].map((table) => db.select().from(table).all());
	}

	function network(requests: RecordedRequest[])
	{
		return requests.map((r) => [r.method, r.path]);
	}

	function pushedTrees(request: RecordedRequest | undefined): unknown
	{
		const fields = new URLSearchParams(request?.body ?? "");
		return JSON.parse(fields.get("push_poll_data") ?? "null");
	}

	describe("WorkflowyInternalAdapter account state", () =>
	{
		let open: DatabaseConstructor.Database[] = [];
		afterEach(() =>
		{
			for (const sqlite of open)
			{
				sqlite.close();
			}
			open = [];
		});
		function tracked()
		{
			const result = setup();
			open.push(result.sqlite);
			return result;
		}

		it("returns the account's user id and join date from the initialization data", async () =>
		{
			const {adapter} = tracked();

			await expect(adapter.getAccount()).resolves.toStrictEqual(
				{
					userId: "123",
					joinedAt: new Date(1_500_000_000_000),
					fullName: null,
				},
			);
		});

		it("returns the account's full name when the server sends one", async () =>
		{
			const {adapter, api} = tracked();
			const data = initializationData();
			data.user =
			{
				id: 123,
				email: "alice@example.com",
				fullName: "Alice Smith",
			};
			api.respond("/get_initialization_data", () =>
				json(
					data,
					{
						headers:
						{
							wfclientid: FAKE_CLIENT_ID,
						},
					},
				),
			);

			await expect(adapter.getAccount()).resolves.toStrictEqual(
				{
					userId: "123",
					joinedAt: new Date(1_500_000_000_000),
					fullName: "Alice Smith",
				},
			);
		});

		it("sets a root metadata path with one edit on None built against the fresh metadata, then reads it from the cache", async () =>
		{
			const {api, adapter} = tracked();
			api.respond("/push_and_poll", pushOk);

			await adapter.setRootMeta(["color", "tags", "alice"], 3);

			expect(network(api.requests)).toStrictEqual([
				["POST", "/ajax_login"],
				["GET", "/get_initialization_data"],
				["POST", "/push_and_poll"],
			]);
			expect(pushedTrees(api.requests[2])).toStrictEqual([
				{
					most_recent_operation_transaction_id: "4567",
					operations: [
						{
							type: "edit",
							data:
							{
								projectid: "None",
								metadataPatches: [
									{
										op: "add",
										path: ["color"],
										value:
										{
											tags:
											{
												alice: 3,
											},
										},
									},
								],
								metadataInversePatches: [
									{
										op: "remove",
										path: ["color"],
									},
								],
							},
							client_timestamp: 300_000_000,
							undo_data:
							{
								previous_last_modified: null,
								previous_last_modified_by: null,
								metadataPatches: [
									{
										op: "remove",
										path: ["color"],
									},
								],
							},
						},
					],
				},
			]);

			const requestsBefore = api.requests.length;
			await expect(adapter.getRootMeta(["color", "tags"])).resolves.toStrictEqual(
				{
					alice: 3,
				},
			);
			await expect(adapter.getRootMeta(["starring", "locations"])).resolves.toStrictEqual(
				{
					abc: "None",
				},
			);
			expect(api.requests).toHaveLength(requestsBefore);
		});

		it("leaves the account tables unchanged when the push is rejected", async () =>
		{
			const {api, adapter, db, clock} = tracked();
			await adapter.getRootMeta([]);
			const before = accountHistory(db);
			clock.ms += 31_000;
			api.respond("/push_and_poll", () =>
				json(
					{
						results: [
							{
								new_most_recent_operation_transaction_id: "4568",
								error: "bad op",
							},
						],
					},
				),
			);

			await expect(adapter.setRootMeta(["color", "tags", "alice"], 3)).rejects.toBeInstanceOf(OperationRejected);

			expect(accountHistory(db)).toStrictEqual(before);
		});

		it("serves reads from the cache for 30s, then answers from the cache while one initialization GET refreshes it in the background", async () =>
		{
			const {api, adapter, clock} = tracked();
			await expect(adapter.getSetting("theme")).resolves.toBe("dark");
			api.respond("/get_initialization_data", () =>
				json(
					{
						...initializationData(),
						settings:
						{
							theme: "light",
							show_completed: true,
						},
					},
					{
						headers:
						{
							wfclientid: FAKE_CLIENT_ID,
						},
					},
				),
			);

			clock.ms += 30_000;
			const fresh = await adapter.getSetting("theme");
			const requestsBefore = api.requests.length;

			clock.ms += 1000;
			const stale = await adapter.getSetting("theme");
			const staleAgain = await adapter.getSetting("theme");
			await adapter.accountRefreshed();
			const refreshed = await adapter.getSetting("theme");

			expect(
				{
					fresh,
					stale,
					staleAgain,
					refreshed,
					network: network(api.requests.slice(requestsBefore)),
				},
			).toStrictEqual(
				{
					fresh: "dark",
					stale: "dark",
					staleAgain: "dark",
					refreshed: "light",
					network: [["GET", "/get_initialization_data"]],
				},
			);
		});

		it("keeps a root metadata write made during a background refresh over the refresh's older snapshot", async () =>
		{
			const {api, adapter, clock} = tracked();
			await adapter.getRootMeta([]);
			clock.ms += 31_000;
			api.respond("/push_and_poll", pushOk);
			let releaseRefresh = () =>
			{
			};
			const refreshReleased = new Promise<void>((resolve) =>
			{
				releaseRefresh = resolve;
			});
			api.respondOnce("/get_initialization_data", async () =>
			{
				await refreshReleased;
				return json(
					initializationData(),
					{
						headers:
						{
							wfclientid: FAKE_CLIENT_ID,
						},
					},
				);
			});

			await adapter.getRootMeta([]);
			await adapter.setRootMeta(["color", "tags", "alice"], 3);
			releaseRefresh();
			await adapter.accountRefreshed();

			await expect(adapter.getRootMeta(["color", "tags"])).resolves.toStrictEqual(
				{
					alice: 3,
				},
			);
		});

		it("reads the entropy key from the initialization data once, then serves it from the account row", async () =>
		{
			const {api, adapter, db, clock} = tracked();
			api.respond("/get_initialization_data", () =>
				json(
					{
						...initializationData(),
						user:
						{
							id: 123,
							email: "alice@example.com",
							entropyKey: "k".repeat(64),
						},
					},
					{
						headers:
						{
							wfclientid: FAKE_CLIENT_ID,
						},
					},
				),
			);

			await expect(adapter.getEntropyKey()).resolves.toBe("k".repeat(64));
			const requestsBefore = api.requests.length;
			clock.ms += 365 * 24 * 60 * 60 * 1000;
			const fresh = new WorkflowyInternalAdapter(
				{
					client: new WorkflowyInternalClient(
						{
							credentials:
							{
								username: "a",
								password: "b",
							},
							fetch: api.fetch,
							baseUrl: "https://workflowy.test",
						},
					),
					db,
					now: () => clock.ms,
				},
			);

			await expect(fresh.getEntropyKey()).resolves.toBe("k".repeat(64));
			expect(api.requests.slice(requestsBefore)).toStrictEqual([]);
		});

		it("refreshes every account table with one initialization GET, even when the cache is fresh", async () =>
		{
			const {api, adapter, db, clock} = tracked();
			await adapter.getSetting("theme");
			api.respond("/get_initialization_data", () =>
				json(
					{
						...initializationData(),
						settings:
						{
							theme: "light",
						},
						user:
						{
							id: 123,
							email: "alice@example.com",
							entropyKey: "k".repeat(64),
						},
					},
					{
						headers:
						{
							wfclientid: FAKE_CLIENT_ID,
						},
					},
				),
			);
			const requestsBefore = api.requests.length;
			clock.ms += 1000;

			const counts = await adapter.refreshAccountState();

			const {account, rootPreferences, accountSettings, stars} = readAccountRows(db);
			expect(
				{
					counts,
					account,
					rootPreferences: rootPreferences.map((row) =>
						Object.entries(row).filter(([, value]) => value !== null),
					),
					theme: accountSettings.map((row) => row.theme),
					stars,
					fetchedAt: readImportTime(db, "account"),
					network: network(api.requests.slice(requestsBefore)),
				},
			).toStrictEqual(
				{
					counts:
					{
						account: 1,
						root_preferences: 1,
						account_settings: 1,
						tag_colors: 0,
						stars: 1,
						star_order: 0,
						location_renames: 0,
						enabled_features: 0,
						visible_features: 0,
						changelog_reads: 0,
						surveys: 0,
						saved_views: 0,
						ai_assistants: 0,
						ai_prompt_buttons: 0,
					},
					account: [
						{
							userId: "123",
							fullName: null,
							dateJoinedSec: 1_500_000_000,
							entropyKey: "k".repeat(64),
							username: null,
							email: null,
						},
					],
					rootPreferences: [[["userId", "123"]]],
					theme: ["light"],
					stars: [
						{
							locationKey: "abc",
							treeRoot: "None",
						},
					],
					fetchedAt: START_MS + 1000,
					network: [["GET", "/get_initialization_data"]],
				},
			);
		});

		it("keeps the account's history: an import, a local write and a re-import each add a version", async () =>
		{
			const {api, adapter, db, clock} = tracked();
			await adapter.getSetting("theme");
			clock.ms += 1000;
			await adapter.setSetting("theme", "light");
			api.respond("/get_initialization_data", () =>
				json(
					{
						...initializationData(),
						settings:
						{
							theme: "solarized",
						},
					},
					{
						headers:
						{
							wfclientid: FAKE_CLIENT_ID,
						},
					},
				),
			);
			clock.ms += 1000;
			await adapter.refreshAccountState();

			const versions = db
				.select(
					{
						theme: schema.accountSettings.theme,
						systemTo: schema.accountSettings.systemTo,
					},
				)
				.from(schema.accountSettings)
				.orderBy(schema.accountSettings.systemFrom)
				.all();
			expect(versions.map((row) => [row.theme, row.systemTo === FAR_FUTURE_DATE])).toStrictEqual([
				["dark", false],
				["light", false],
				["solarized", true],
			]);
		});

		it("answers undefined for the entropy key when the account data has none", async () =>
		{
			const {adapter} = tracked();

			await expect(adapter.getEntropyKey()).resolves.toBeUndefined();
		});

		it("posts a setting change with yes/no flags and the client id, then caches the new value", async () =>
		{
			const {api, adapter} = tracked();

			await adapter.setSetting("show_completed", false);

			const post = api.requests.find((r) => r.path === "/change_settings");
			expect(Object.fromEntries(new URLSearchParams(post?.body ?? ""))).toStrictEqual(
				{
					show_completed: "no",
					clientId: FAKE_CLIENT_ID,
					crosscheck_user_id: "123",
				},
			);
			const requestsBefore = api.requests.length;
			await expect(adapter.getSetting("show_completed")).resolves.toBe(false);
			expect(api.requests).toHaveLength(requestsBefore);
		});

		it("posts the Dropbox backup flag as yes and caches it as a boolean", async () =>
		{
			const {api, adapter} = tracked();

			await adapter.setSetting("backup_to_dropbox", true);

			const post = api.requests.find((r) => r.path === "/change_settings");
			expect(
				{
					body: Object.fromEntries(new URLSearchParams(post?.body ?? "")),
					cached: await adapter.getSetting("backup_to_dropbox"),
				},
			).toStrictEqual(
				{
					body:
					{
						backup_to_dropbox: "yes",
						clientId: FAKE_CLIENT_ID,
						crosscheck_user_id: "123",
					},
					cached: true,
				},
			);
		});

		it("leaves the cached setting unchanged when the settings POST fails", async () =>
		{
			const {api, adapter, db} = tracked();
			await adapter.getSetting("theme");
			const before = accountHistory(db);
			api.respond(
				"/change_settings",
				() =>
					new Response(
						"boom",
						{
							status: 500,
						},
					),
			);

			await expect(adapter.setSetting("theme", "light")).rejects.toThrow("/change_settings returned 500");

			expect(accountHistory(db)).toStrictEqual(before);
		});
		it("serves the visible feature list from the account cache, with no network for a second adapter", async () =>
		{
			const {api, adapter, db, clock} = tracked();
			const list = [
				{
					codename: "bdl",
					name: "Backlinks",
					label: null,
					description: "d",
				},
				{
					codename: "dashboards",
					name: "Dashboard layout",
					label: "LABS",
					description: "x",
				},
			];
			api.respond("/get_initialization_data", () =>
				json(
					{
						...initializationData(),
						features: list,
					},
					{
						headers:
						{
							wfclientid: FAKE_CLIENT_ID,
						},
					},
				),
			);

			await expect(adapter.visibleFeatures()).resolves.toStrictEqual(list);

			const requestsBefore = api.requests.length;
			const second = new WorkflowyInternalAdapter(
				{
					client: new WorkflowyInternalClient(
						{
							credentials:
							{
								username: "alice@example.com",
								password: "hunter2",
							},
							fetch: api.fetch,
							baseUrl: "https://workflowy.test",
						},
					),
					db,
					now: () => clock.ms,
				},
			);
			await expect(second.visibleFeatures()).resolves.toStrictEqual(list);
			expect(api.requests).toHaveLength(requestsBefore);
		});

		it("reads the enabled feature dict, keeping only true or yes entries", async () =>
		{
			const {api, adapter} = tracked();
			api.respond("/get_initialization_data", () =>
				json(
					{
						...initializationData(),
						settings:
						{
							features:
							{
								bdl: true,
								a: "yes",
								x: false,
								y: null,
								z: "no",
							},
						},
					},
					{
						headers:
						{
							wfclientid: FAKE_CLIENT_ID,
						},
					},
				),
			);

			await expect(adapter.enabledFeatures()).resolves.toStrictEqual(
				{
					bdl: true,
					a: true,
				},
			);
		});

		it("drains a locally toggled feature as upstream's enable or disable POST with the client id, then closes its row", async () =>
		{
			const {api, adapter, db} = tracked();
			api.respond("/get_initialization_data", () =>
				json(
					{
						...initializationData(),
						settings:
						{
							features:
							{
								dates: true,
							},
						},
					},
					{
						headers:
						{
							wfclientid: FAKE_CLIENT_ID,
						},
					},
				),
			);
			await adapter.loadAccountState();
			const account = new LocalAccount(
				db,
				{
					outbox: new AccountOutboxRecorder(),
				},
			);
			account.setFeature("dashboards", true);
			account.setFeature("dates", false);

			await adapter.drainOutbox();

			const posts = api.requests.filter((r) => r.path.startsWith("/features/"));
			expect(
				{
					posts: posts.map((r) => [r.method, r.path, Object.fromEntries(new URLSearchParams(r.body ?? ""))]),
					enabled: await adapter.enabledFeatures(),
					pending: readPendingAccountOutbox(db),
				},
			).toStrictEqual(
				{
					posts: [
						[
							"POST",
							"/features/enable/dashboards",
							{
								clientId: FAKE_CLIENT_ID,
								crosscheck_user_id: "123",
							},
						],
						[
							"POST",
							"/features/disable/dates",
							{
								clientId: FAKE_CLIENT_ID,
								crosscheck_user_id: "123",
							},
						],
					],
					enabled:
					{
						dashboards: true,
					},
					pending: [],
				},
			);
		});

		it("keeps every written setting as a version a later server refresh supersedes but never erases", async () =>
		{
			const {api, adapter, db, clock} = tracked();
			await adapter.setSetting("theme", "light");
			await adapter.setSetting("ignore_loom", true);
			api.respond("/get_initialization_data", () =>
				json(
					{
						...initializationData(),
						settings:
						{
							theme: "solarized",
						},
					},
					{
						headers:
						{
							wfclientid: FAKE_CLIENT_ID,
						},
					},
				),
			);
			clock.ms += 31_000;
			await adapter.getSetting("theme");
			await adapter.accountRefreshed();

			expect(
				{
					cached: await adapter.getSetting("theme"),
					versions: db
						.select(
							{
								theme: schema.accountSettings.theme,
								ignoreLoom: schema.accountSettings.ignoreLoom,
							},
						)
						.from(schema.accountSettings)
						.orderBy(schema.accountSettings.systemFrom)
						.all(),
				},
			).toStrictEqual(
				{
					cached: "solarized",
					versions: [
						{
							theme: "light",
							ignoreLoom: null,
						},
						{
							theme: "light",
							ignoreLoom: 1,
						},
						{
							theme: "solarized",
							ignoreLoom: null,
						},
					],
				},
			);
		});

		it("writes no account row when the settings POST fails on an empty cache", async () =>
		{
			const {api, adapter, db} = tracked();
			api.respond(
				"/change_settings",
				() =>
					new Response(
						"boom",
						{
							status: 500,
						},
					),
			);

			await expect(adapter.setSetting("theme", "light")).rejects.toThrow("/change_settings returned 500");

			expect(accountHistory(db).flat()).toStrictEqual([]);
		});
	});
});

describe("internal adapter backlinks", () =>
{
	/** The current backlink items, derived as the app derives them: live mirrors under a live references root. */
	const BACKLINKS = `(SELECT m.mirror_id AS node_id, m.original_id AS source_id, p.parent_id AS target_id, m.system_to
	FROM mirrors m
	JOIN node_content c ON c.id = m.mirror_id AND c.system_to = ${FAR_FUTURE_DATE}
	JOIN references_roots r ON r.node_id = c.parent_id AND r.system_to = ${FAR_FUTURE_DATE}
	JOIN node_content p ON p.id = c.parent_id AND p.system_to = ${FAR_FUTURE_DATE}
	WHERE m.system_to = ${FAR_FUTURE_DATE})`;

	const migrationsFolder = join(import.meta.dirname, "../src/db/migrations");
	const START_MS = 1_800_000_000_000;
	const ROOT = "None";
	const SEEDED = systemTimeAt("2026-01-01 00:00:00");

	const SOURCE = "11111111-1111-4111-8111-111111111111";
	const TARGET = "22222222-2222-4222-8222-222222222222";
	const OTHER = "33333333-3333-4333-8333-333333333333";
	const OLD_ROOT = "44444444-4444-4444-8444-444444444444";
	const OLD_ITEM = "55555555-5555-4555-8555-555555555555";
	const OTHER_ROOT = "66666666-6666-4666-8666-666666666666";
	const CHILD = "77777777-7777-4777-8777-777777777777";

	const link = (id: string) => `<a href="https://workflowy.com/#/${id.replaceAll("-", "").slice(-12)}">x</a>`;

	const PushDataSchema = z.array(
		z.object(
			{
				operations: z
					.array(
						z
							.object(
								{
									type: z.string(),
									data: z.record(z.string(), z.unknown()),
								},
							)
							.loose(),
					)
					.optional(),
			},
		),
	);
	const OpDataSchema = z.object(
		{
			projectid: z.string().optional(),
			parentid: z.string().optional(),
			starting_priority: z.number().optional(),
			project_trees: z.string().optional(),
			metadataPatches: z.array(z.custom<MetadataPatch>()).optional(),
		},
	);
	const TreesSchema = z.array(
		z
			.object(
				{
					id: z.string(),
					nm: z.string(),
					no: z.string().optional(),
					metadata: z.record(z.string(), z.unknown()).optional(),
				},
			)
			.loose(),
	);

	interface ServerNode
	{
		name: string;
		note: string | null;
		parent: string;
		metadata: Record<string, unknown>;
	}

	/** One server state behind both fakes: `/push_and_poll` applies ops, `/get_tree_data/` and `/api/v1/nodes*` read it. */
	function createServer(initial: [string, ServerNode][], trashed: [string, ServerNode][] = [])
	{
		const nodes = new Map(initial);
		const trash = new Map(trashed);
		const order = new Map<string, string[]>();
		for (const [id, node] of initial)
		{
			order.set(node.parent, [...(order.get(node.parent) ?? []), id]);
		}
		const children = (parent: string) => order.get(parent) ?? [];

		function apply(type: string, rawData: Record<string, unknown>): void
		{
			const data = OpDataSchema.parse(rawData);
			if (type === "bulk_create")
			{
				const parent = data.parentid ?? ROOT;
				const trees = TreesSchema.parse(JSON.parse(data.project_trees ?? "[]"));
				for (const tree of trees)
				{
					nodes.set(
						tree.id,
						{
							name: tree.nm,
							note: tree.no ?? null,
							parent,
							metadata: tree.metadata ?? {},
						},
					);
				}
				const list = [...children(parent)];
				list.splice(data.starting_priority ?? 0, 0, ...trees.map((tree) => tree.id));
				order.set(parent, list);
			}
			else if (type === "undelete" && data.projectid !== undefined)
			{
				const parent = data.parentid ?? ROOT;
				const restored = trash.get(data.projectid);
				if (restored)
				{
					nodes.set(
						data.projectid,
						{
							...restored,
							parent,
						},
					);
					order.set(parent, [...children(parent), data.projectid]);
				}
			}
			else if (type === "delete" && data.projectid !== undefined)
			{
				const node = nodes.get(data.projectid);
				if (node)
				{
					order.set(
						node.parent,
						children(node.parent).filter((id) => id !== data.projectid),
					);
					nodes.delete(data.projectid);
				}
			}
			else if (type === "edit" && data.projectid !== undefined)
			{
				const node = nodes.get(data.projectid);
				if (node)
				{
					node.metadata = applyMetadataPatches(node.metadata, data.metadataPatches ?? []);
				}
			}
		}

		function toApi(id: string)
		{
			const node = nodes.get(id);
			if (!node)
			{
				throw new Error(`no node ${id}`);
			}
			return {
				id,
				name: node.name,
				note: node.note,
				parent_id: node.parent === ROOT ? null : node.parent,
				priority: children(node.parent).indexOf(id) * 100,
				completed: false,
				createdAt: 0,
				modifiedAt: 0,
				completedAt: null,
			};
		}

		function publicFetch(url: string): Response
		{
			const apiPath = url.replace("https://workflowy.test/api/v1", "");
			if (apiPath === "/nodes" || apiPath.startsWith("/nodes?"))
			{
				const parent = new URLSearchParams(apiPath.split("?")[1] ?? "").get("parent_id") ?? ROOT;
				return Response.json(
					{
						nodes: children(parent).map(toApi),
					},
				);
			}
			const id = apiPath.split("/")[2] ?? "";
			if (!nodes.has(id))
			{
				return Response.json(
					{
						error: "not found",
					},
					{
						status: 404,
					},
				);
			}
			return Response.json(
				{
					node: toApi(id),
				},
			);
		}

		return {
			apply,
			publicFetch,
			children,
		};
	}

	function pushedOps(request: RecordedRequest):
	{
		type: string;
		data: Record<string, unknown>;
	}[]
	{
		const fields = new URLSearchParams(request.body ?? "");
		const trees = PushDataSchema.parse(JSON.parse(fields.get("push_poll_data") ?? "[]"));
		return trees.flatMap((tree) => tree.operations ?? []);
	}

	const node = (name: string, parent: string, metadata: Record<string, unknown> = {}, note: string | null = null) => (
	{
		name,
		note,
		parent,
		metadata,
	});

	/**
	 * Every read of `/get_tree_data/` fails, and the cache is seeded the way a whole-tree import would have: each
	 * node cached, plus the edge rows of its `mirror`/`backlink`/`isReferencesRoot` metadata.
	 */
	async function setup(initial: [string, ServerNode][], trashed: [string, ServerNode][] = [])
	{
		const sqlite = new DatabaseConstructor(":memory:");
		const db = drizzle(
			sqlite,
			{
				schema,
			},
		);
		migrate(
			db,
			{
				migrationsFolder,
			},
		);
		// A whole-tree import seeded the transaction-log position at the fake init's id.
		storeTreeTxId(db, "4567");
		const server = createServer(initial, trashed);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => Promise.resolve(server.publicFetch(url))),
		);
		const api = createFakeInternalApi();
		const pushes:
		{
			type: string;
			data: Record<string, unknown>;
		}[][] = [];
		api.respond("/push_and_poll", (request) =>
		{
			const ops = pushedOps(request);
			if (ops.length > 0)
			{
				pushes.push(ops);
			}
			for (const op of ops)
			{
				server.apply(op.type, op.data);
			}
			return json(
				{
					results: [
						{
							new_most_recent_operation_transaction_id: "4568",
							// Workflowy echoes the pushed ops back as the server run.
							server_run_operation_transaction_json: JSON.stringify(
								{
									ops,
									client_timestamp: 300_000_000,
								},
							),
							concurrent_remote_operation_transactions: [],
						},
					],
				},
			);
		});
		const client = new WorkflowyInternalClient(
			{
				credentials:
				{
					username: "alice@example.com",
					password: "hunter2",
				},
				fetch: api.fetch,
				baseUrl: "https://workflowy.test",
				transientId: "6f1c1d1e-0000-4000-8000-000000000001",
			},
		);
		const apiClient = new WorkflowyApiClient("test-key", undefined, "https://workflowy.test");
		const cacheService = new CacheService(db);
		const writeThrough = new WorkflowyWriteThroughClient(apiClient, cacheService);
		let next = 0;
		const adapter = new WorkflowyInternalAdapter(
			{
				client,
				db,
				writeThrough,
				now: () => START_MS,
				generateId: () => `00000000-0000-4000-8000-00000000000${++next}`,
				pushAndPoll:
				{
					randomId: () => "pollid01",
					timezone: "America/New_York",
				},
			},
		);
		const parents = [...new Set(initial.map(([, value]) => value.parent))];
		await writeThrough.refreshChildren(parents.map((parent) => (parent === ROOT ? null : parent)));
		const imported = emptyItemRelationships();
		for (const [id, value] of initial)
		{
			collectItemRelationships(imported, id, value.metadata);
		}
		cacheService.recordRelationships(imported);
		forbidTreeData(api);
		const rows = (sql: string) => sqlite.prepare(sql).all();
		return {
			sqlite,
			db,
			api,
			adapter,
			pushes,
			server,
			cacheService,
			rows,
		};
	}

	const ID1 = "00000000-0000-4000-8000-000000000001";
	const ID2 = "00000000-0000-4000-8000-000000000002";

	describe("internal links", () =>
	{
		it("finds short-id and full-id links on any host, deduplicated, ignoring bare urls", () =>
		{
			const text = `${link(TARGET)} <a href="https://beta.workflowy.com/#/${OTHER}">y</a> ${link(TARGET)} <a href="https://example.com/#/333333333333">z</a> https://workflowy.com/#/444444444444`;

			expect(
				{
					ids: internalLinkShortIds(text),
					has: hasInternalLink(text),
					none: hasInternalLink("plain"),
				},
			).toStrictEqual(
				{
					ids: ["222222222222", "333333333333"],
					has: true,
					none: false,
				},
			);
		});
	});

	describe("WorkflowyInternalAdapter.syncBacklinks", () =>
	{
		let open: DatabaseConstructor.Database[] = [];
		afterEach(() =>
		{
			for (const sqlite of open)
			{
				sqlite.close();
			}
			open = [];
			vi.unstubAllGlobals();
		});
		async function tracked(initial: [string, ServerNode][], trashed: [string, ServerNode][] = [])
		{
			const result = await setup(initial, trashed);
			open.push(result.sqlite);
			return result;
		}

		it("creates the target's references root and a backlink mirror under it in one push, whose echoed replay records their edge rows before the read-back caches the nodes", async () =>
		{
			const {adapter, pushes, cacheService, rows} = await tracked([
				[SOURCE, node(`see ${link(TARGET)}`, ROOT)],
				[TARGET, node("target", ROOT)],
			]);

			const result = await adapter.syncBacklinks([SOURCE]);

			const current = `system_to = ${FAR_FUTURE_DATE}`;
			expect(
				{
					result,
					pushes: pushes.map((ops) => ops.map((op) => [op.type, op.data])),
					targetChildren: cacheService.getChildren(TARGET).map((child) => child.id),
					rootChildren: cacheService.getChildren(ID1).map((child) => child.id),
					relations: rows(
						`SELECT 'root' AS kind, node_id AS id FROM references_roots WHERE ${current} UNION ALL SELECT 'backlink', node_id || '>' || source_id || '>' || target_id FROM ${BACKLINKS} WHERE ${current} UNION ALL SELECT 'mirror', mirror_id || '>' || original_id FROM mirrors WHERE ${current}`,
					),
					systemTimes: rows(
						`SELECT COUNT(DISTINCT system_from) AS n FROM (SELECT system_from FROM references_roots UNION ALL SELECT system_from FROM mirrors UNION ALL SELECT system_from FROM node_content WHERE id IN ('${ID1}', '${ID2}'))`,
					),
				},
			).toStrictEqual(
				{
					result:
					{
						created: [
							{
								id: ID2,
								sourceId: SOURCE,
								targetId: TARGET,
							},
						],
						referencesRoots: [ID1],
						deleted: [],
					},
					pushes: [
						[
							[
								"bulk_create",
								{
									parentid: TARGET,
									starting_priority: 0,
									project_trees: JSON.stringify([
										{
											id: ID1,
											nm: "",
											metadata:
											{
												isReferencesRoot: true,
											},
											ct: 300_000_000,
											cb: 123,
											ch: [],
										},
									]),
									isForSearch: false,
								},
							],
							[
								"bulk_create",
								{
									parentid: ID1,
									starting_priority: 0,
									project_trees: JSON.stringify([
										{
											id: ID2,
											nm: "",
											metadata:
											{
												mirror:
												{
													originalId: SOURCE,
													isMirrorRoot: true,
												},
												backlink:
												{
													sourceID: SOURCE,
													targetID: TARGET,
												},
											},
											ct: 300_000_000,
											cb: 123,
											ch: [],
										},
									]),
									isForSearch: false,
								},
							],
							[
								"edit",
								{
									projectid: SOURCE,
									metadataPatches: [
										{
											op: "add",
											path: ["mirror"],
											value:
											{
												backlinkMirrorRootIds:
												{
													[ID2]: true,
												},
											},
										},
									],
									metadataInversePatches: [
										{
											op: "remove",
											path: ["mirror"],
										},
									],
								},
							],
						],
					],
					targetChildren: [ID1],
					rootChildren: [ID2],
					relations: [
						{
							kind: "root",
							id: ID1,
						},
						{
							kind: "backlink",
							id: `${ID2}>${SOURCE}>${TARGET}`,
						},
						{
							kind: "mirror",
							id: `${ID2}>${SOURCE}`,
						},
					],
					systemTimes: [
						{
							n: 2,
						},
					],
				},
			);
		});

		it("reuses an existing references root and deletes a backlink whose link is gone, ending its composite", async () =>
		{
			const {api, adapter, pushes, rows} = await tracked([
				[
					SOURCE,
					node(
						`now ${link(OTHER)}`,
						ROOT,
						{
							mirror:
							{
								backlinkMirrorRootIds:
								{
									[OLD_ITEM]: true,
								},
							},
						},
					),
				],
				[TARGET, node("target", ROOT)],
				[OTHER, node("other", ROOT)],
				[
					OLD_ROOT,
					node(
						"",
						TARGET,
						{
							isReferencesRoot: true,
						},
					),
				],
				[
					OLD_ITEM,
					node(
						"",
						OLD_ROOT,
						{
							mirror:
							{
								originalId: SOURCE,
								isMirrorRoot: true,
							},
							backlink:
							{
								sourceID: SOURCE,
								targetID: TARGET,
							},
						},
					),
				],
				[
					OTHER_ROOT,
					node(
						"",
						OTHER,
						{
							isReferencesRoot: true,
						},
					),
				],
			]);

			const result = await adapter.syncBacklinks([SOURCE]);

			expect(
				{
					result,
					pushes: pushes.map((ops) => ops.map((op) => [op.type, op.data.projectid ?? op.data.parentid])),
					edit: pushes.flat().find((op) => op.type === "edit")?.data.metadataPatches,
					current: rows(`SELECT node_id, source_id, target_id FROM ${BACKLINKS} ORDER BY node_id`),
					oldItemCurrent: rows(
						`SELECT id FROM node_content WHERE id = '${OLD_ITEM}' AND system_to = ${FAR_FUTURE_DATE} UNION ALL SELECT mirror_id FROM mirrors WHERE mirror_id = '${OLD_ITEM}' AND system_to = ${FAR_FUTURE_DATE}`,
					),
					reads: treeDataReads(api),
				},
			).toStrictEqual(
				{
					result:
					{
						created: [
							{
								id: ID1,
								sourceId: SOURCE,
								targetId: OTHER,
							},
						],
						referencesRoots: [],
						deleted: [OLD_ITEM],
					},
					pushes: [
						[
							["delete", OLD_ITEM],
							["bulk_create", OTHER_ROOT],
							["edit", SOURCE],
						],
					],
					edit: [
						{
							op: "remove",
							path: ["mirror", "backlinkMirrorRootIds", OLD_ITEM],
						},
						{
							op: "add",
							path: ["mirror", "backlinkMirrorRootIds", ID1],
							value: true,
						},
					],
					current: [
						{
							node_id: ID1,
							source_id: SOURCE,
							target_id: OTHER,
						},
					],
					oldItemCurrent: [],
					reads: 0,
				},
			);
		});

		it("drops a backlinkMirrorRootIds entry whose item no longer exists, without a delete op", async () =>
		{
			const {adapter, pushes, sqlite} = await tracked([
				[
					SOURCE,
					node(
						"plain",
						ROOT,
						{
							mirror:
							{
								backlinkMirrorRootIds:
								{
									[OLD_ITEM]: true,
								},
							},
						},
					),
				],
			]);
			// An earlier import cached the item, under the target's references root, while it still existed.
			sqlite.exec(`
			INSERT INTO node_content (id, name, parent_id, system_from, system_to) VALUES
				('${TARGET}', 'target', NULL, ${SEEDED}, ${FAR_FUTURE_DATE}),
				('${OLD_ROOT}', '', '${TARGET}', ${SEEDED}, ${FAR_FUTURE_DATE}),
				('${OLD_ITEM}', '', '${OLD_ROOT}', ${SEEDED}, ${FAR_FUTURE_DATE});
			INSERT INTO references_roots VALUES ('${OLD_ROOT}', ${SEEDED}, ${FAR_FUTURE_DATE});
		`);

			const result = await adapter.syncBacklinks([SOURCE]);

			expect(
				{
					result,
					ops: pushes.flat().map((op) => [op.type, op.data.projectid]),
					edit: pushes.flat().find((op) => op.type === "edit")?.data.metadataPatches,
				},
			).toStrictEqual(
				{
					result:
					{
						created: [],
						referencesRoots: [],
						deleted: [],
					},
					ops: [["edit", SOURCE]],
					edit: [
						{
							op: "remove",
							path: ["mirror", "backlinkMirrorRootIds", OLD_ITEM],
						},
					],
				},
			);
		});

		it("pushes nothing when every link already has its backlink, or the source is a mirror", async () =>
		{
			const {adapter, pushes} = await tracked([
				[
					SOURCE,
					node(
						link(TARGET),
						ROOT,
						{
							mirror:
							{
								backlinkMirrorRootIds:
								{
									[OLD_ITEM]: true,
								},
							},
						},
					),
				],
				[TARGET, node("target", ROOT)],
				[
					OTHER,
					node(
						link(TARGET),
						ROOT,
						{
							mirror:
							{
								originalId: SOURCE,
								isMirrorRoot: true,
							},
						},
					),
				],
				[
					OLD_ROOT,
					node(
						"",
						TARGET,
						{
							isReferencesRoot: true,
						},
					),
				],
				[
					OLD_ITEM,
					node(
						"",
						OLD_ROOT,
						{
							mirror:
							{
								originalId: SOURCE,
								isMirrorRoot: true,
							},
							backlink:
							{
								sourceID: SOURCE,
								targetID: TARGET,
							},
						},
					),
				],
			]);

			const result = await adapter.syncBacklinks([SOURCE, OTHER]);

			expect(
				{
					result,
					pushes,
				},
			).toStrictEqual(
				{
					result:
					{
						created: [],
						referencesRoots: [],
						deleted: [],
					},
					pushes: [],
				},
			);
		});

		it("reuses a references root created upstream after the import, learned from the transaction log", async () =>
		{
			const {api, adapter, pushes, server} = await tracked([
				[SOURCE, node(`see ${link(TARGET)}`, ROOT)],
				[TARGET, node("target", ROOT)],
			]);
			const rootOp =
			{
				type: "bulk_create",
				data:
				{
					parentid: TARGET,
					starting_priority: 0,
					project_trees: JSON.stringify([
						{
							id: OTHER_ROOT,
							nm: "",
							metadata:
							{
								isReferencesRoot: true,
							},
						},
					]),
				},
			};
			server.apply(rootOp.type, rootOp.data);
			api.respondOnce("/push_and_poll", () =>
				json(
					{
						results: [
							{
								new_most_recent_operation_transaction_id: "4568",
								concurrent_remote_operation_transactions: [
									JSON.stringify(
										{
											id: 4568,
											client_timestamp: 300_000_000,
											ops: [rootOp],
										},
									),
								],
							},
						],
					},
				),
			);

			const result = await adapter.syncBacklinks([SOURCE]);

			expect(
				{
					result,
					pushes: pushes.map((ops) => ops.map((op) => [op.type, op.data.projectid ?? op.data.parentid])),
					targetChildren: server.children(TARGET),
					reads: treeDataReads(api),
				},
			).toStrictEqual(
				{
					result:
					{
						created: [
							{
								id: ID1,
								sourceId: SOURCE,
								targetId: TARGET,
							},
						],
						referencesRoots: [],
						deleted: [],
					},
					pushes: [
						[
							["bulk_create", OTHER_ROOT],
							["edit", SOURCE],
						],
					],
					targetChildren: [OTHER_ROOT],
					reads: 0,
				},
			);
		});

		it("points a link to a mirror at the mirror's original", async () =>
		{
			const {api, adapter, pushes} = await tracked([
				[SOURCE, node(`see ${link(CHILD)}`, ROOT)],
				[
					TARGET,
					node(
						"target",
						ROOT,
						{
							mirror:
							{
								mirrorRootIds:
								{
									[CHILD]: true,
								},
							},
						},
					),
				],
				[
					CHILD,
					node(
						"",
						ROOT,
						{
							mirror:
							{
								originalId: TARGET,
								isMirrorRoot: true,
							},
						},
					),
				],
			]);

			const result = await adapter.syncBacklinks([SOURCE]);

			expect(
				{
					result,
					pushes: pushes.map((ops) => ops.map((op) => [op.type, op.data.projectid ?? op.data.parentid])),
					reads: treeDataReads(api),
				},
			).toStrictEqual(
				{
					result:
					{
						created: [
							{
								id: ID2,
								sourceId: SOURCE,
								targetId: TARGET,
							},
						],
						referencesRoots: [ID1],
						deleted: [],
					},
					pushes: [
						[
							["bulk_create", TARGET],
							["bulk_create", ID1],
							["edit", SOURCE],
						],
					],
					reads: 0,
				},
			);
		});

		it("creates backlinks for a node created with a link in its note", async () =>
		{
			const {adapter, pushes, server} = await tracked([[TARGET, node("target", ROOT)]]);

			const {id} = await adapter.createAt(
				{
					parentId: "home",
					index: 0,
					name: "new",
					note: `see ${link(TARGET)}`,
				},
			);

			expect(
				{
					id,
					pushTypes: pushes.map((ops) => ops.map((op) => op.type)),
					targetChildren: server.children(TARGET),
				},
			).toStrictEqual(
				{
					id: ID1,
					pushTypes: [["bulk_create"], ["bulk_create", "bulk_create", "edit"]],
					targetChildren: [ID2],
				},
			);
		});

		it("creates backlinks for a restored node that links to a target", async () =>
		{
			const {adapter, pushes, server} = await tracked(
				[[TARGET, node("target", ROOT)]],
				[[SOURCE, node(`see ${link(TARGET)}`, ROOT)]],
			);

			await adapter.restore(
				{
					id: SOURCE,
					parentId: "home",
					index: 1,
				},
			);

			expect(
				{
					pushTypes: pushes.map((ops) => ops.map((op) => op.type)),
					targetChildren: server.children(TARGET),
				},
			).toStrictEqual(
				{
					pushTypes: [["undelete"], ["bulk_create", "bulk_create", "edit"]],
					targetChildren: [ID1],
				},
			);
		});

		it("writes no references root, backlink or mirror row when the push is rejected", async () =>
		{
			const {api, adapter, rows} = await tracked([
				[SOURCE, node(`see ${link(TARGET)}`, ROOT)],
				[TARGET, node("target", ROOT)],
			]);
			api.respond("/push_and_poll", () =>
				json(
					{
						results: [
							{
								new_most_recent_operation_transaction_id: "4568",
								error: "bad op",
							},
						],
					},
				),
			);

			await expect(adapter.syncBacklinks([SOURCE])).rejects.toBeInstanceOf(OperationRejected);

			expect(
				rows("SELECT node_id AS id FROM references_roots UNION ALL SELECT mirror_id FROM mirrors"),
			).toStrictEqual([]);
		});

		it("reads the whole account tree zero times for syncBacklinks", async () =>
		{
			const {api, adapter} = await tracked([
				[SOURCE, node(`see ${link(TARGET)}`, ROOT)],
				[TARGET, node("target", ROOT)],
			]);

			await adapter.syncBacklinks([SOURCE]);

			expect(treeDataReads(api)).toBe(0);
		});
	});
});

describe("internal adapter calendar layout", () =>
{
	describe("calendarLayoutWrites", () =>
	{
		it("patches metadata against fresh metadata and inverts every write, last first", () =>
		{
			const {writes, undo, touchedParents} = calendarLayoutWrites(
				[
					{
						op: "set-calendar",
						id: "n",
						calendar: null,
					},
					{
						op: "move",
						id: "a",
						parentId: "p",
						index: 3,
						from:
						{
							parentId: "p",
							index: 0,
						},
					},
					{
						op: "move",
						id: "b",
						parentId: "q",
						index: 0,
						from:
						{
							parentId: "p",
							index: 1,
						},
					},
					{
						op: "delete",
						id: "m",
						from:
						{
							parentId: "y",
							index: 2,
						},
					},
					{
						op: "set-levels",
						id: "cal",
						levels:
						{
							year: true,
							day: true,
						},
					},
				],
				new Map([
					[
						"n",
						{
							calendar:
							{
								level: "day",
								dateId: 1,
							},
							other: 1,
						},
					],
					[
						"cal",
						{
							calendar:
							{
								root: true,
								levels:
								{
									year: true,
									month: true,
									day: true,
								},
							},
						},
					],
				]),
			);
			expect(
				{
					writes,
					undo,
					touchedParents,
				},
			).toStrictEqual(
				{
					writes: [
						{
							op: "edit",
							id: "n",
							patches: [
								{
									op: "remove",
									path: ["calendar"],
								},
							],
							inverse: [
								{
									op: "add",
									path: ["calendar"],
									value:
									{
										level: "day",
										dateId: 1,
									},
								},
							],
						},
						{
							op: "move",
							id: "a",
							parentId: "p",
							index: 3,
							from:
							{
								parentId: "p",
								index: 0,
							},
						},
						{
							op: "move",
							id: "b",
							parentId: "q",
							index: 0,
							from:
							{
								parentId: "p",
								index: 1,
							},
						},
						{
							op: "delete",
							id: "m",
							from:
							{
								parentId: "y",
								index: 2,
							},
						},
						{
							op: "edit",
							id: "cal",
							patches: [
								{
									op: "replace",
									path: ["calendar", "levels"],
									value:
									{
										year: true,
										day: true,
									},
								},
							],
							inverse: [
								{
									op: "replace",
									path: ["calendar", "levels"],
									value:
									{
										year: true,
										month: true,
										day: true,
									},
								},
							],
						},
					],
					undo: [
						{
							op: "edit",
							id: "cal",
							patches: [
								{
									op: "replace",
									path: ["calendar", "levels"],
									value:
									{
										year: true,
										month: true,
										day: true,
									},
								},
							],
							inverse: [
								{
									op: "replace",
									path: ["calendar", "levels"],
									value:
									{
										year: true,
										day: true,
									},
								},
							],
						},
						{
							op: "undelete",
							id: "m",
							parentId: "y",
							index: 2,
						},
						{
							op: "move",
							id: "b",
							parentId: "p",
							index: 1,
							from:
							{
								parentId: "q",
								index: 0,
							},
						},
						{
							op: "move",
							id: "a",
							parentId: "p",
							index: 0,
							from:
							{
								parentId: "p",
								index: 2,
							},
						},
						{
							op: "edit",
							id: "n",
							patches: [
								{
									op: "add",
									path: ["calendar"],
									value:
									{
										level: "day",
										dateId: 1,
									},
								},
							],
							inverse: [
								{
									op: "remove",
									path: ["calendar"],
								},
							],
						},
					],
					touchedParents: ["p", "q", "y"],
				},
			);
		});
	});

	describe("layoutWriteParents", () =>
	{
		it("leaves out parents the writes delete, unless a later write brings them back", () =>
		{
			expect([
				layoutWriteParents([
					{
						op: "move",
						id: "d",
						parentId: "y",
						index: 0,
						from:
						{
							parentId: "m",
							index: 0,
						},
					},
					{
						op: "delete",
						id: "m",
						from:
						{
							parentId: "y",
							index: 1,
						},
					},
				]),
				layoutWriteParents([
					{
						op: "undelete",
						id: "m",
						parentId: "y",
						index: 1,
					},
					{
						op: "move",
						id: "d",
						parentId: "m",
						index: 0,
						from:
						{
							parentId: "y",
							index: 0,
						},
					},
				]),
			]).toStrictEqual([["y"], ["y", "m"]]);
		});
	});
});

describe("internal adapter calendar", () =>
{
	const migrationsFolder = join(import.meta.dirname, "../src/db/migrations");
	const ENTROPY = "e".repeat(64);
	const CAL = "cal-root";
	const Y2026 = calendarNodeId(ENTROPY, "year", 20_260_000);
	const M09 = calendarNodeId(ENTROPY, "month", 20_260_900);
	const M10 = calendarNodeId(ENTROPY, "month", 20_261_000);
	const D1017 = calendarNodeId(ENTROPY, "day", 20_261_017);

	const SESSION: InternalSession =
	{
		clientId: "client",
		clientVersion: "21",
		userId: 123,
		ownerId: 123,
		dateJoinedSec: 1_500_000_000,
		txId: "1",
		rootMetadata:
		{
			dateFormat: "YYYY-MM-DD ddd",
		},
		settings: {},
		visibleFeatures: [],
		expandedKeys: [],
		entropyKey: ENTROPY,
	};

	/** A pushed `bulk_create` tree, without its clock fields. */
	interface PushedTree
	{
		id: string;
		nm: string;
		metadata?: unknown;
		ch: PushedTree[];
	}

	function pushedTrees(body: string): PushedTree[]
	{
		const strip = ({id, nm, metadata, ch}: PushedTree): PushedTree => (
		{
			id,
			nm,
			...(metadata === undefined
				? {}
				:
					{
						metadata,
					}),
			ch: ch.map(strip),
		});
		return (JSON.parse(body) as PushedTree[]).map(strip);
	}

	/**
	 * A fake adapter world: `children` is the live tree the public API would
	 * return, `cached` (default `children`) the cache's copy, and
	 * the typed metadata tables hold cached calendar metadata. Live reads, pushes
	 * (applied to the live tree), cache refreshes and `moveTo` are recorded in
	 * `calls`.
	 */
	function setup(options: {
		children: Record<string, string[]>;
		cached?: Record<string, string[]>;
		metadata: Record<string, unknown>;
		session?: InternalSession;
		/** What every bootstrap after the first returns; defaults to `session`. */
		freshSession?: InternalSession;
	})
	{
		const sqlite = new DatabaseConstructor(":memory:");
		const db = drizzle(
			sqlite,
			{
				schema,
			},
		);
		migrate(
			db,
			{
				migrationsFolder,
			},
		);
		// A whole-tree import seeded the transaction-log position at the fake init's id.
		storeTreeTxId(db, "4567");
		const children = new Map(Object.entries(options.children).map(([parent, ids]) => [parent, [...ids]]));
		const parentOf = (id: string) => [...children].find(([, ids]) => ids.includes(id))?.[0];
		for (const [parent, ids] of children)
		{
			for (const id of ids)
			{
				db.insert(schema.nodeContent)
					.values(
						{
							id,
							name: id,
							parentId: parent === "home" ? null : parent,
							systemFrom: systemTimeAt("2026-01-01 00:00:00.000"),
							systemTo: FAR_FUTURE_DATE,
						},
					)
					.run();
			}
		}
		storeInternalMetadata(
			db,
			new Map(
				Object.entries(options.metadata).map(([nodeId, metadata]) => [
					nodeId,
					z.record(z.string(), z.unknown()).parse(metadata),
				]),
			),
		);
		const cached = new Map(
			Object.entries(options.cached ?? options.children).map(([parent, ids]) => [parent, [...ids]]),
		);
		const session = options.session ?? SESSION;
		const freshSession = options.freshSession ?? session;
		let bootstraps = 0;
		const client =
		{
			session,
			bootstrap: async () => Promise.resolve(++bootstraps === 1 ? session : freshSession),
		} as unknown as WorkflowyInternalClient;
		const calls: unknown[] = [];
		const writeThrough =
		{
			liveChildren: async (parent: string | null) =>
			{
				calls.push(["live", parent]);
				return Promise.resolve(
					(children.get(parent ?? "home") ?? []).map((id) => (
					{
						id,
					})),
				);
			},
			cachedChildIds: (parent: string | null) => cached.get(parent ?? "home") ?? [],
			findLiveNode: async (id: string) =>
			{
				calls.push(["findLive", id]);
				const parent = parentOf(id);
				return Promise.resolve(
					parent === undefined
						? null
						:
							{
								id,
								parent_id: parent === "home" ? null : parent,
							},
				);
			},
			refreshChildren: async (parentIds: (string | null)[]) =>
			{
				calls.push(["refreshChildren", parentIds]);
				for (const parent of parentIds)
				{
					cached.set(parent ?? "home", [...(children.get(parent ?? "home") ?? [])]);
				}
				return Promise.resolve();
			},
			refreshChain: async (parentIds: string[]) =>
			{
				calls.push(["refresh", parentIds]);
				for (const parent of parentIds)
				{
					cached.set(parent, [...(children.get(parent) ?? [])]);
				}
				return Promise.resolve();
			},
		} as unknown as WorkflowyWriteThroughClient;
		let generated = 0;
		const adapter = new WorkflowyInternalAdapter(
			{
				client,
				db,
				writeThrough,
				now: () => 1_800_000_000_000,
				generateId: () => `random-${++generated}`,
			},
		);
		const insert = (parentId: string, index: number, trees: PushedTree[]) =>
		{
			const list = children.get(parentId) ?? [];
			list.splice(index, 0, ...trees.map((tree) => tree.id));
			children.set(parentId, list);
			for (const tree of trees)
			{
				insert(tree.id, 0, tree.ch);
			}
		};
		vi.spyOn(PushAndPoll.prototype, "pushAndPoll").mockImplementation(async ({ops = []} = {}) =>
		{
			for (const op of ops)
			{
				if (op.type === "edit")
				{
					const {projectid, metadataPatches} = op.data as
					{
						projectid: string;
						metadataPatches: unknown;
					};
					calls.push([
						"edit",
						{
							id: projectid,
							metadataPatches,
						},
					]);
					continue;
				}
				const data = op.data as
				{
					parentid: string;
					starting_priority: number;
					project_trees: string;
				};
				const trees = pushedTrees(data.project_trees);
				calls.push([
					op.type,
					{
						parentId: data.parentid,
						index: data.starting_priority,
						trees,
					},
				]);
				insert(data.parentid === "None" ? "home" : data.parentid, data.starting_priority, trees);
			}
			return Promise.resolve(
				{
					txId: "2",
					serverRun: [],
					remote: [],
					needsRefresh: false,
				},
			);
		});
		vi.spyOn(adapter, "moveTo").mockImplementation(async (input: MoveToInput) =>
		{
			calls.push(["moveTo", input]);
			for (const id of input.ids)
			{
				const from = parentOf(id);
				if (from !== undefined)
				{
					children.set(
						from,
						(children.get(from) ?? []).filter((child) => child !== id),
					);
				}
			}
			const list = children.get(input.parentId) ?? [];
			list.splice(input.index ?? list.length, 0, ...input.ids);
			children.set(input.parentId, list);
			for (const [parent, ids] of children)
			{
				cached.set(parent, [...ids]);
			}
			return Promise.resolve();
		});
		const cachedMetadata = (nodeId: string): unknown => readInternalMetadata(db, [nodeId]).get(nodeId);
		return {
			sqlite,
			adapter,
			calls,
			children,
			cachedMetadata,
		};
	}

	const ROOT_META =
	{
		calendar:
		{
			root: true,
			levels:
			{
				day: true,
				year: true,
				month: true,
			},
			day_prefix: true,
			found_dates: true,
		},
	};
	const yearMeta =
	{
		calendar:
		{
			level: "year",
			value: "2026",
			timestamp: new Date(2026, 0, 1).getTime(),
			dateId: 20_260_000,
		},
	};
	const sepMeta =
	{
		calendar:
		{
			level: "month",
			value: "9",
			timestamp: new Date(2026, 8, 1).getTime(),
			dateId: 20_260_900,
		},
	};
	const novMeta =
	{
		calendar:
		{
			level: "month",
			value: "11",
			timestamp: new Date(2026, 10, 1).getTime(),
			dateId: 20_261_100,
		},
	};

	describe("calendar day helpers", () =>
	{
		it("parses a YYYYMMDD dateId and rejects impossible dates", () =>
		{
			expect([
				parseDateId(20_261_017),
				parseDateId(20_260_230),
				parseDateId(2_026_101),
				parseDateId(20_261_300),
			]).toStrictEqual([
				{
					year: 2026,
					month: 10,
					day: 17,
				},
				undefined,
				undefined,
				undefined,
			]);
		});

		it("names levels from the account date format like upstream", () =>
		{
			const date =
			{
				year: 2026,
				month: 9,
				day: 8,
			};
			expect([
				calendarLevelName("year", date, "YYYY-MM-DD ddd"),
				calendarLevelName("month", date, "YYYY-MM-DD ddd"),
				calendarLevelName("month", date, ""),
				calendarLevelName("month", date, "[MM] MMMM"),
				calendarLevelName("year", date, "MM/DD/YY"),
				calendarLevelName("day", date, "YYYY-MM-DD ddd"),
			]).toStrictEqual([
				"2026",
				"09",
				"9",
				"September",
				"26",
				'<time startYear="2026" startMonth="9" startDay="8">Tue, Sep 8, 2026</time>',
			]);
		});

		it("gives a week (upstream DC1) its first day as dateId and timestamp (midnight in the account timezone when given) and its week number as value", () =>
		{
			const thursday =
			{
				year: 2026,
				month: 10,
				day: 15,
			};
			const newYear =
			{
				year: 2027,
				month: 1,
				day: 1,
			};
			expect([
				calendarDateId("week", thursday),
				calendarDateId("week", thursday, 1),
				calendarDateId("week", newYear),
				calendarLevelMetadata("week", thursday),
				calendarLevelMetadata("week", thursday, 1),
				calendarLevelMetadata("week", newYear),
				calendarLevelMetadata("week", newYear, 1),
				calendarLevelMetadata("week", thursday, 0, "America/New_York"),
			]).toStrictEqual([
				20_261_011,
				20_261_012,
				20_261_227,
				{
					level: "week",
					value: "42",
					timestamp: new Date(2026, 9, 11).getTime(),
					dateId: 20_261_011,
				},
				{
					level: "week",
					value: "42",
					timestamp: new Date(2026, 9, 12).getTime(),
					dateId: 20_261_012,
				},
				{
					level: "week",
					value: "1",
					timestamp: new Date(2026, 11, 27).getTime(),
					dateId: 20_261_227,
				},
				{
					level: "week",
					value: "53",
					timestamp: new Date(2026, 11, 28).getTime(),
					dateId: 20_261_228,
				},
				// EDT midnight, whatever the host's zone.
				{
					level: "week",
					value: "42",
					timestamp: 1_791_691_200_000,
					dateId: 20_261_011,
				},
			]);
		});

		it("names a week from the date format's week token like upstream, else `Week N`", () =>
		{
			const january =
			{
				year: 2026,
				month: 1,
				day: 7,
			};
			expect([
				calendarLevelName("week", january, "YYYY-MM-DD ddd"),
				calendarLevelName("week", january, "[Week] ww"),
				calendarLevelName("week", january, "wo"),
				calendarLevelName(
					"week",
					{
						year: 2026,
						month: 1,
						day: 1,
					},
					"wo",
				),
				calendarLevelName(
					"week",
					{
						year: 2026,
						month: 3,
						day: 10,
					},
					"wo",
				),
				calendarLevelName("week", january, "W", 1),
			]).toStrictEqual(["Week 2", "02", "2nd", "1st", "11th", "2"]);
		});
	});

	describe("WorkflowyInternalAdapter.ensureCalendarDay", () =>
	{
		let open: DatabaseConstructor.Database[] = [];
		afterEach(() =>
		{
			vi.restoreAllMocks();
			for (const sqlite of open)
			{
				sqlite.close();
			}
			open = [];
		});
		function tracked(options: Parameters<typeof setup>[0])
		{
			const result = setup(options);
			open.push(result.sqlite);
			return result;
		}

		const octMetadata =
		{
			restorableUniqueNode: true,
			calendar:
			{
				level: "month",
				value: "10",
				timestamp: new Date(2026, 9, 1).getTime(),
				dateId: 20_261_000,
			},
		};
		const d1017Metadata =
		{
			restorableUniqueNode: true,
			calendar:
			{
				level: "day",
				value: "17",
				timestamp: new Date(2026, 9, 17).getTime(),
				dateId: 20_261_017,
			},
		};
		const D1017_NAME = '<time startYear="2026" startMonth="10" startDay="17">Sat, Oct 17, 2026</time>';

		it("walks the cache, confirms the miss with one live read, then creates the month, day and empty child in one push", async () =>
		{
			const {adapter, calls, children, cachedMetadata} = tracked(
				{
					children:
					{
						home: [CAL],
						[CAL]: ["note", Y2026],
						[Y2026]: [M09, "loose", "nov"],
					},
					metadata:
					{
						[CAL]: ROOT_META,
						[Y2026]: yearMeta,
						[M09]: sepMeta,
						nov: novMeta,
					},
				},
			);

			const result = await adapter.ensureCalendarDay(20_261_017);

			expect(
				{
					result,
					calls,
					months: children.get(Y2026),
					cachedDay: cachedMetadata(D1017),
				},
			).toStrictEqual(
				{
					result:
					{
						dayId: D1017,
						firstChildId: "random-1",
						created: [M10, D1017, "random-1"],
					},
					calls: [
						["live", Y2026],
						[
							"bulk_create",
							{
								parentId: Y2026,
								index: 2,
								trees: [
									{
										id: M10,
										nm: "10",
										metadata: octMetadata,
										ch: [
											{
												id: D1017,
												nm: D1017_NAME,
												metadata: d1017Metadata,
												ch: [
													{
														id: "random-1",
														nm: "",
														ch: [],
													},
												],
											},
										],
									},
								],
							},
						],
						["refresh", [Y2026, M10, D1017]],
					],
					months: [M09, "loose", M10, "nov"],
					cachedDay:
					{
						calendar: d1017Metadata.calendar,
						restorableUniqueNode: true,
					},
				},
			);
		});

		it("creates a v5 day beside a name-only day for the same date and leaves the name-only node alone, as upstream does", async () =>
		{
			const octMeta =
			{
				calendar:
				{
					level: "month",
					value: "10",
					timestamp: 0,
					dateId: 20_261_000,
				},
			};
			const {adapter, calls, children} = tracked(
				{
					children:
					{
						home: [CAL],
						[CAL]: [Y2026],
						[Y2026]: ["oct"],
						oct: ["name-only"],
					},
					metadata:
					{
						[CAL]: ROOT_META,
						[Y2026]: yearMeta,
						oct: octMeta,
					},
				},
			);

			const result = await adapter.ensureCalendarDay(
				20_261_017,
				{
					createChild: false,
				},
			);

			expect(
				{
					result,
					month: children.get("oct"),
					bulk: calls.filter((call) => Array.isArray(call) && call[0] === "bulk_create"),
				},
			).toStrictEqual(
				{
					result:
					{
						dayId: D1017,
						firstChildId: null,
						created: [D1017],
					},
					month: ["name-only", D1017],
					bulk: [
						[
							"bulk_create",
							{
								parentId: "oct",
								index: 1,
								trees: [
									{
										id: D1017,
										nm: D1017_NAME,
										metadata: d1017Metadata,
										ch: [],
									},
								],
							},
						],
					],
				},
			);
		});

		it("reads nothing live and creates nothing when the cached day already has children", async () =>
		{
			const dayMeta =
			{
				calendar:
				{
					level: "day",
					value: "17",
					timestamp: 0,
					dateId: 20_261_017,
				},
			};
			const octMeta =
			{
				calendar:
				{
					level: "month",
					value: "10",
					timestamp: 0,
					dateId: 20_261_000,
				},
			};
			const {adapter, calls} = tracked(
				{
					children:
					{
						home: [CAL],
						[CAL]: [Y2026],
						[Y2026]: [M09, "oct"],
						oct: ["legacy-day"],
						"legacy-day": ["entry", "other"],
					},
					metadata:
					{
						[CAL]: ROOT_META,
						[Y2026]: yearMeta,
						[M09]: sepMeta,
						oct: octMeta,
						"legacy-day": dayMeta,
					},
				},
			);

			const result = await adapter.ensureCalendarDay(20_261_017);

			expect(
				{
					result,
					calls,
				},
			).toStrictEqual(
				{
					result:
					{
						dayId: "legacy-day",
						firstChildId: "entry",
						created: [],
					},
					calls: [],
				},
			);
		});

		it("reuses a day the stale cache misses once the live read shows it", async () =>
		{
			const {adapter, calls} = tracked(
				{
					children:
					{
						home: [CAL],
						[CAL]: [Y2026],
						[Y2026]: [M10],
						[M10]: [D1017],
						[D1017]: ["entry"],
					},
					cached:
					{
						home: [CAL],
						[CAL]: [Y2026],
						[Y2026]: [M10],
					},
					metadata:
					{
						[CAL]: ROOT_META,
						[Y2026]: yearMeta,
					},
				},
			);

			const result = await adapter.ensureCalendarDay(20_261_017);

			expect(
				{
					result,
					calls,
				},
			).toStrictEqual(
				{
					result:
					{
						dayId: D1017,
						firstChildId: "entry",
						created: [],
					},
					calls: [
						["live", M10],
						["live", D1017],
						["refresh", [M10, D1017]],
					],
				},
			);
		});

		it("moves a deterministic node that exists elsewhere back under its parent instead of creating it", async () =>
		{
			const {adapter, calls} = tracked(
				{
					children:
					{
						home: [CAL, M10],
						[CAL]: [Y2026],
						[Y2026]: [M09],
						[M10]: [D1017],
						[D1017]: ["entry"],
					},
					metadata:
					{
						[CAL]: ROOT_META,
						[Y2026]: yearMeta,
						[M09]: sepMeta,
					},
				},
			);

			const result = await adapter.ensureCalendarDay(20_261_017);

			expect(
				{
					result,
					calls,
				},
			).toStrictEqual(
				{
					result:
					{
						dayId: D1017,
						firstChildId: "entry",
						created: [],
					},
					calls: [
						["live", Y2026],
						[
							"moveTo",
							{
								ids: [M10],
								parentId: Y2026,
								index: 1,
							},
						],
						["live", M10],
						["live", D1017],
						["refresh", [Y2026, M10, D1017]],
					],
				},
			);
		});

		it("stops at the month level when asked, creating the missing month without a day or a child", async () =>
		{
			const {adapter, calls} = tracked(
				{
					children:
					{
						home: [CAL],
						[CAL]: [Y2026],
						[Y2026]: [M09],
					},
					metadata:
					{
						[CAL]: ROOT_META,
						[Y2026]: yearMeta,
						[M09]: sepMeta,
					},
				},
			);

			const result = await adapter.ensureCalendarDay(
				20_261_001,
				{
					stopAt: "month",
					createChild: false,
				},
			);

			expect(
				{
					result,
					calls,
				},
			).toStrictEqual(
				{
					result:
					{
						dayId: M10,
						firstChildId: null,
						created: [M10],
					},
					calls: [
						["live", Y2026],
						[
							"bulk_create",
							{
								parentId: Y2026,
								index: 1,
								trees: [
									{
										id: M10,
										nm: "10",
										metadata: octMetadata,
										ch: [],
									},
								],
							},
						],
						["refresh", [Y2026]],
					],
				},
			);
		});

		it("adds one empty child to an empty month when stopping there with createChild", async () =>
		{
			const octMeta =
			{
				calendar:
				{
					level: "month",
					value: "10",
					timestamp: 0,
					dateId: 20_261_000,
				},
			};
			const {adapter, calls} = tracked(
				{
					children:
					{
						home: [CAL],
						[CAL]: [Y2026],
						[Y2026]: ["oct"],
					},
					metadata:
					{
						[CAL]: ROOT_META,
						[Y2026]: yearMeta,
						oct: octMeta,
					},
				},
			);

			const result = await adapter.ensureCalendarDay(
				20_261_001,
				{
					stopAt: "month",
				},
			);

			expect(
				{
					result,
					calls,
				},
			).toStrictEqual(
				{
					result:
					{
						dayId: "oct",
						firstChildId: "random-1",
						created: ["random-1"],
					},
					calls: [
						["live", "oct"],
						[
							"bulk_create",
							{
								parentId: "oct",
								index: 0,
								trees: [
									{
										id: "random-1",
										nm: "",
										ch: [],
									},
								],
							},
						],
						["refresh", ["oct"]],
					],
				},
			);
		});

		it("walks a week level between year and day when the root shows weeks, starting weeks per weekStartDay", async () =>
		{
			const weekRoot =
			{
				calendar:
				{
					root: true,
					levels:
					{
						year: true,
						week: true,
						day: true,
					},
				},
			};
			const w1012 = calendarNodeId(ENTROPY, "week", 20_261_012, 2026);
			const d1015 = calendarNodeId(ENTROPY, "day", 20_261_015);
			const {adapter, calls} = tracked(
				{
					children:
					{
						home: [CAL],
						[CAL]: [Y2026],
						[Y2026]: [],
					},
					metadata:
					{
						[CAL]: weekRoot,
						[Y2026]: yearMeta,
					},
					session:
					{
						...SESSION,
						rootMetadata:
						{
							dateFormat: "YYYY-MM-DD ddd",
							weekStartDay: 1,
						},
					},
				},
			);

			const week = await adapter.ensureCalendarDay(
				20_261_015,
				{
					stopAt: "week",
					createChild: false,
				},
			);
			const day = await adapter.ensureCalendarDay(
				20_261_015,
				{
					createChild: false,
				},
			);

			expect(
				{
					week,
					day,
					calls,
				},
			).toStrictEqual(
				{
					week:
					{
						dayId: w1012,
						firstChildId: null,
						created: [w1012],
					},
					day:
					{
						dayId: d1015,
						firstChildId: null,
						created: [d1015],
					},
					calls: [
						["live", Y2026],
						[
							"bulk_create",
							{
								parentId: Y2026,
								index: 0,
								trees: [
									{
										id: w1012,
										nm: "Week 42",
										metadata:
										{
											restorableUniqueNode: true,
											calendar:
											{
												level: "week",
												value: "42",
												timestamp: new Date(2026, 9, 12).getTime(),
												dateId: 20_261_012,
											},
										},
										ch: [],
									},
								],
							},
						],
						["refresh", [Y2026]],
						["live", w1012],
						[
							"bulk_create",
							{
								parentId: w1012,
								index: 0,
								trees: [
									{
										id: d1015,
										nm: '<time startYear="2026" startMonth="10" startDay="15">Thu, Oct 15, 2026</time>',
										metadata:
										{
											restorableUniqueNode: true,
											calendar:
											{
												level: "day",
												value: "15",
												timestamp: new Date(2026, 9, 15).getTime(),
												dateId: 20_261_015,
											},
										},
										ch: [],
									},
								],
							},
						],
						["refresh", [w1012]],
					],
				},
			);
		});

		const yearCreate = (parentId: string) => [
			"bulk_create",
			{
				parentId,
				index: 0,
				trees: [
					{
						id: Y2026,
						nm: "2026",
						metadata:
						{
							restorableUniqueNode: true,
							...yearMeta,
						},
						ch: [],
					},
				],
			},
		];

		it("walks from the root that root metadata calendar.rootId names, like upstream's Calendar.find", async () =>
		{
			const {adapter, calls} = tracked(
				{
					children:
					{
						home: [CAL, "alt"],
						[CAL]: [],
						alt: [],
					},
					metadata:
					{
						[CAL]: ROOT_META,
					},
					session:
					{
						...SESSION,
						rootMetadata:
						{
							...SESSION.rootMetadata,
							calendar:
							{
								rootId: "alt",
							},
						},
					},
				},
			);

			const result = await adapter.ensureCalendarDay(
				20_261_017,
				{
					stopAt: "year",
					createChild: false,
				},
			);

			expect(
				{
					result,
					calls,
				},
			).toStrictEqual(
				{
					result:
					{
						dayId: Y2026,
						firstChildId: null,
						created: [Y2026],
					},
					calls: [["live", "alt"], yearCreate("alt"), ["refresh", ["alt"]]],
				},
			);
		});

		it("falls back to the calendar.root-tagged node when calendar.rootId names no cached node", async () =>
		{
			const {adapter, calls} = tracked(
				{
					children:
					{
						home: [CAL],
						[CAL]: [],
					},
					metadata:
					{
						[CAL]: ROOT_META,
					},
					session:
					{
						...SESSION,
						rootMetadata:
						{
							...SESSION.rootMetadata,
							calendar:
							{
								rootId: "gone",
							},
						},
					},
				},
			);

			await adapter.ensureCalendarDay(
				20_261_017,
				{
					stopAt: "year",
					createChild: false,
				},
			);

			expect(calls).toStrictEqual([["live", CAL], yearCreate(CAL), ["refresh", [CAL]]]);
		});

		it("re-syncs calendar.rootId from workflowy.com and walks from that live root when the cache misses it while connected", async () =>
		{
			const {adapter, calls} = tracked(
				{
					children:
					{
						home: ["a", "live-cal"],
						"live-cal": [],
					},
					cached:
					{
						home: ["a"],
					},
					metadata: {},
					freshSession:
					{
						...SESSION,
						rootMetadata:
						{
							...SESSION.rootMetadata,
							calendar:
							{
								rootId: "live-cal",
							},
						},
					},
				},
			);

			const result = await adapter.ensureCalendarDay(
				20_261_017,
				{
					stopAt: "year",
					createChild: false,
				},
			);

			expect(
				{
					result,
					calls,
				},
			).toStrictEqual(
				{
					result:
					{
						dayId: Y2026,
						firstChildId: null,
						created: [Y2026],
					},
					calls: [
						["findLive", "live-cal"],
						["refreshChildren", [null]],
						["live", "live-cal"],
						yearCreate("live-cal"),
						["refresh", ["live-cal"]],
					],
				},
			);
		});

		it("fails loudly instead of creating a duplicate root when workflowy.com names no calendar root while connected", async () =>
		{
			const error = vi.spyOn(console, "error").mockImplementation(() => {});
			const {adapter, calls, children} = tracked(
				{
					children:
					{
						home: ["a"],
					},
					metadata: {},
				},
			);

			await expect(
				adapter.ensureCalendarDay(
					20_261_017,
					{
						stopAt: "year",
						createChild: false,
					},
				),
			).rejects.toStrictEqual(new CalendarRootMissing());
			expect(
				{
					calls,
					home: children.get("home"),
					logged: error.mock.calls,
				},
			).toStrictEqual(
				{
					calls: [],
					home: ["a"],
					logged: [[new CalendarRootMissing()]],
				},
			);
		});
	});
});

describe("internal adapter expansion", () =>
{
	const migrationsFolder = join(import.meta.dirname, "../src/db/migrations");
	const START_MS = 1_800_000_000_000;

	const ALPHA = "1a2b3c4d-0000-4000-8000-000000000001";
	const BRAVO = "5e6f7a8b-0000-4000-8000-000000000002";
	/** Shares ALPHA's first 8 chars, so the server's key expands both, as upstream. */
	const ALPHA_TWIN = "1a2b3c4d-0000-4000-8000-000000000003";
	const CHARLIE = "9c9c9c9c-0000-4000-8000-000000000004";

	function cachedNode(id: string): WorkflowyNode
	{
		return {
			id,
			name: id,
			note: null,
			parent_id: null,
			priority: 0,
			createdAt: 0,
			modifiedAt: 0,
		};
	}

	function setup()
	{
		const sqlite = new DatabaseConstructor(":memory:");
		const db = drizzle(
			sqlite,
			{
				schema,
			},
		);
		migrate(
			db,
			{
				migrationsFolder,
			},
		);
		// A whole-tree import seeded the transaction-log position at the fake init's id.
		storeTreeTxId(db, "4567");
		const cacheService = new CacheService(db);
		for (const id of [ALPHA, BRAVO, ALPHA_TWIN, CHARLIE])
		{
			cacheService.insertNode(cachedNode(id), null);
		}
		const api = createFakeInternalApi();
		const clock =
		{
			ms: START_MS,
		};
		const newAdapter = () =>
			new WorkflowyInternalAdapter(
				{
					client: new WorkflowyInternalClient(
						{
							credentials:
							{
								username: "alice@example.com",
								password: "hunter2",
							},
							fetch: api.fetch,
							baseUrl: "https://workflowy.test",
							transientId: "6f1c1d1e-0000-4000-8000-000000000001",
						},
					),
					db,
					now: () => clock.ms,
					pushAndPoll:
					{
						randomId: () => "pollid01",
						timezone: "America/New_York",
					},
				},
			);
		const forbidden = forbidTreeData(api);
		/** Seed the expanded keys as a whole-tree import does. */
		const seed = (keys: string[]) =>
		{
			runUnitOfWork(db, (unitOfWork) =>
			{
				replaceExpansion(unitOfWork, keys, clock.ms);
			});
		};
		return {
			sqlite,
			db,
			api,
			adapter: newAdapter(),
			newAdapter,
			clock,
			forbidden,
			seed,
		};
	}

	describe("WorkflowyInternalAdapter expansion", () =>
	{
		let open: DatabaseConstructor.Database[] = [];
		afterEach(() =>
		{
			for (const sqlite of open)
			{
				sqlite.close();
			}
			open = [];
			vi.restoreAllMocks();
		});
		function tracked()
		{
			const result = setup();
			open.push(result.sqlite);
			return result;
		}

		it("resolves each stored key to every cached id it prefixes, with no request", () =>
		{
			const {api, adapter, seed} = tracked();
			seed(["1a2b3c4d", "5e6f7a8b", "ffffffff"]);

			expect(adapter.getExpandedIds()).toStrictEqual([ALPHA, ALPHA_TWIN, BRAVO]);
			expect(api.requests).toStrictEqual([]);
		});

		it("tests ids against the same stored keys", () =>
		{
			const {api, adapter, seed} = tracked();
			seed(["1a2b3c4d"]);

			const isExpanded = adapter.expansionTest();

			expect(
				{
					tested: [ALPHA, ALPHA_TWIN, BRAVO, "1a2b3c4d-not-cached"].map((id) => isExpanded(id)),
					requests: api.requests,
				},
			).toStrictEqual(
				{
					tested: [true, true, false, true],
					requests: [],
				},
			);
		});

		it("reads a mirror instance's v_ key back as the virtual ids it expands, directed by the key's path", () =>
		{
			const {adapter, sqlite, seed} = tracked();
			const cache = new CacheService(
				drizzle(
					sqlite,
					{
						schema,
					},
				),
			);
			const ORIGINAL = "0a0a0a0a-0000-4000-8000-000000000010";
			const CHILD = "c0c0c0c0-0000-4000-8000-000000000011";
			const GRANDCHILD = "d1d1d1d1-0000-4000-8000-000000000012";
			const MIRROR = "bbbb0000-0000-4000-8000-000000000013";
			cache.insertNode(cachedNode(ORIGINAL), null);
			cache.insertNode(
				{
					...cachedNode(CHILD),
					parent_id: ORIGINAL,
				},
				ORIGINAL,
			);
			cache.insertNode(
				{
					...cachedNode(GRANDCHILD),
					parent_id: CHILD,
				},
				CHILD,
			);
			cache.insertNode(cachedNode(MIRROR), null);
			cache.insertMirror(ORIGINAL, MIRROR);
			seed(["v_c0c0bbbbbbbb", "v_d1d1bbbbbbbbc0c0", "v_d1d1bbbbbbbb", "5e6f7a8b"]);

			expect(adapter.getExpandedIds()).toStrictEqual([
				BRAVO,
				`virtual_${CHILD}_${MIRROR}_bbbb`,
				`virtual_${GRANDCHILD}_${MIRROR}_bbbbc0c0`,
			]);
		});

		it("answers keys of any age from the store, never reading the whole account tree", () =>
		{
			const {api, adapter, clock, forbidden, seed} = tracked();
			seed(["1a2b3c4d"]);
			clock.ms += 24 * 60 * 60 * 1000;

			const ids = adapter.getExpandedIds();
			const changes = adapter.getExpansionChanges(undefined);
			const isExpanded = adapter.expansionTest();
			const leftBar = adapter.getLeftBarExpansionKeys();

			expect(
				{
					ids,
					changes,
					alpha: isExpanded(ALPHA),
					leftBar,
					treeDataReads: treeDataReads(api),
					forbidden,
				},
			).toStrictEqual(
				{
					ids: [ALPHA, ALPHA_TWIN],
					changes:
					{
						version: expansionVersion(new Set(["1a2b3c4d"])),
						expandedIds: [ALPHA, ALPHA_TWIN],
					},
					alpha: true,
					leftBar: [],
					treeDataReads: 0,
					forbidden: [],
				},
			);
		});

		it("answers a change-feed read with no ids while the keys still match the caller's version", () =>
		{
			const {api, adapter, seed} = tracked();
			seed(["1a2b3c4d"]);
			const {version} = adapter.getExpansionChanges(undefined);

			expect(adapter.getExpansionChanges(version)).toStrictEqual(
				{
					version,
					expandedIds: null,
				},
			);
			expect(api.requests).toStrictEqual([]);
		});

		it("answers keys a whole-tree import seeded, with no request", () =>
		{
			const {api, db, adapter} = tracked();
			importInternalMetadata(
				db,
				{
					items: [],
					txId: "9999",
					expandedKeys: ["5e6f7a8b"],
				},
				START_MS,
			);

			expect(adapter.getExpandedIds()).toStrictEqual([BRAVO]);
			expect(api.requests).toStrictEqual([]);
		});

		it("fails loudly with no seeded keys, naming the reseed command, and never reads the whole account tree", () =>
		{
			const {api, adapter} = tracked();
			const logged = vi.spyOn(console, "error").mockImplementation(() => {});

			const reads: (() => unknown)[] = [
				() => adapter.getExpandedIds(),
				() => adapter.getExpansionChanges(undefined),
				() => adapter.expansionTest(),
				() => adapter.getLeftBarExpansionKeys(),
			];
			const failures = reads.map((read) =>
			{
				let failure: unknown;
				try
				{
					read();
				}
				catch (error)
				{
					failure = error;
				}
				return failure;
			});

			expect(
				{
					failures: failures.map((error) => [
						error instanceof ExpansionNotSeeded,
						error instanceof TreeResyncRequired,
						(error as Error).message,
					]),
					logged: logged.mock.calls.length,
					requests: api.requests,
				},
			).toStrictEqual(
				{
					failures: Array.from(
						{
							length: 4,
						},
						() => [
							true,
							true,
							"The local cache has no expanded keys; run './bin/run.js cache import-api' to seed them",
						],
					),
					logged: 4,
					requests: [],
				},
			);
		});

		it("lists only the leftbar__ keys, unresolved", () =>
		{
			const {adapter, seed} = tracked();
			seed(["1a2b3c4d", "leftbar__home__None/x/__abcdefgh", "leftbar__starred__None/None/__None"]);

			expect(adapter.getLeftBarExpansionKeys()).toStrictEqual([
				"leftbar__home__None/x/__abcdefgh",
				"leftbar__starred__None/None/__None",
			]);
		});
	});
});

describe("internal adapter transaction log", () =>
{
	const migrationsFolder = join(import.meta.dirname, "../src/db/migrations");
	const START_MS = 1_800_000_000_000;

	function setup()
	{
		const sqlite = new DatabaseConstructor(":memory:");
		const db = drizzle(
			sqlite,
			{
				schema,
			},
		);
		migrate(
			db,
			{
				migrationsFolder,
			},
		);
		const api = createFakeInternalApi();
		const adapter = new WorkflowyInternalAdapter(
			{
				client: new WorkflowyInternalClient(
					{
						credentials:
						{
							username: "alice@example.com",
							password: "hunter2",
						},
						fetch: api.fetch,
						baseUrl: "https://workflowy.test",
						transientId: "6f1c1d1e-0000-4000-8000-000000000001",
					},
				),
				db,
				now: () => START_MS,
				pushAndPoll:
				{
					randomId: () => "pollid01",
					timezone: "America/New_York",
				},
			},
		);
		const cache = new CacheService(db);
		const edges = () => (
		{
			mirrors: db
				.select(
					{
						mirrorId: schema.mirrors.mirrorId,
						originalId: schema.mirrors.originalId,
					},
				)
				.from(schema.mirrors)
				.where(eq(schema.mirrors.systemTo, FAR_FUTURE_DATE))
				.all()
				.toSorted((a, b) => a.mirrorId.localeCompare(b.mirrorId)),
			referencesRoots: db
				.select(
					{
						nodeId: schema.referencesRoots.nodeId,
					},
				)
				.from(schema.referencesRoots)
				.where(eq(schema.referencesRoots.systemTo, FAR_FUTURE_DATE))
				.all(),
		});
		return {
			sqlite,
			db,
			api,
			adapter,
			cache,
			edges,
		};
	}

	/** A logged transaction as `/push_and_poll` sends it: a JSON string. */
	function transaction(
		id: number,
		ops:
		{
			type: string;
			data: Record<string, unknown>;
		}[],
	): string
	{
		return JSON.stringify(
			{
				id,
				client_timestamp: 300_000_000,
				ops,
			},
		);
	}

	function poll(txId: string, remote: string[], extra: Record<string, unknown> = {})
	{
		return () =>
			json(
				{
					results: [
						{
							new_most_recent_operation_transaction_id: txId,
							concurrent_remote_operation_transactions: remote,
							...extra,
						},
					],
				},
			);
	}

	function leafAdd(projectid: string, field: string, mirrorId: string)
	{
		return {
			type: "edit",
			data:
			{
				projectid,
				metadataPatches: [
					{
						op: "add",
						path: ["mirror", field, mirrorId],
						value: true,
					},
				],
			},
		};
	}

	const PushDataSchema = z.array(
		z
			.object(
				{
					most_recent_operation_transaction_id: z.string(),
				},
			)
			.loose(),
	);

	/** The transaction id each push or poll started from. */
	function startIds(requests: RecordedRequest[]): string[]
	{
		return requests
			.filter((request) => request.path === "/push_and_poll")
			.flatMap((request) =>
				PushDataSchema.parse(
					JSON.parse(new URLSearchParams(request.body ?? "").get("push_poll_data") ?? "[]"),
				).map((tree) => tree.most_recent_operation_transaction_id),
			);
	}

	/** What `promise` rejects with, or undefined when it resolves. */
	async function caughtBy(promise: Promise<unknown>): Promise<unknown>
	{
		try
		{
			await promise;
			return undefined;
		}
		catch (error)
		{
			return error;
		}
	}

	describe("WorkflowyInternalAdapter transaction log", () =>
	{
		let open: DatabaseConstructor.Database[] = [];
		afterEach(() =>
		{
			for (const sqlite of open)
			{
				sqlite.close();
			}
			open = [];
			vi.restoreAllMocks();
		});
		function tracked()
		{
			const context = setup();
			open.push(context.sqlite);
			return context;
		}

		it("catches up from the stored id: a remote leaf add becomes a mirror row and the id advances, with no tree read", async () =>
		{
			const {db, api, adapter, edges} = tracked();
			storeTreeTxId(db, "100");
			api.respondOnce(
				"/push_and_poll",
				poll("105", [transaction(103, [leafAdd("orig", "mirrorRootIds", "m1")])]),
			);

			await adapter.catchUp();

			expect(
				{
					starts: startIds(api.requests),
					edges: edges(),
					txId: readTreeTxId(db),
					reads: treeDataReads(api),
				},
			).toStrictEqual(
				{
					starts: ["100"],
					edges:
					{
						mirrors: [
							{
								mirrorId: "m1",
								originalId: "orig",
							},
						],
						referencesRoots: [],
					},
					txId: "105",
					reads: 0,
				},
			);
		});

		it("records bulk_create metadata in the REST log format: mirror roots, references roots and backlink items", async () =>
		{
			const {db, api, adapter, edges} = tracked();
			storeTreeTxId(db, "100");
			const restTrees = `[{"id": "m3", "nm": "", "no": null, "ct": 1, "metadata": {"mirror": {"originalId": "o3", "isMirrorRoot": true}}}]`;
			api.respondOnce(
				"/push_and_poll",
				poll("110", [
					transaction(101, [
						{
							type: "bulk_create",
							data:
							{
								parentid: "box",
								starting_priority: 1_000_000,
								project_trees: restTrees,
							},
						},
					]),
					transaction(102, [
						{
							type: "bulk_create",
							data:
							{
								parentid: "t2",
								starting_priority: 0,
								project_trees: JSON.stringify([
									{
										id: "rr2",
										nm: "",
										metadata:
										{
											isReferencesRoot: true,
										},
										ch: [
											{
												id: "bl2",
												nm: "",
												metadata:
												{
													mirror:
													{
														originalId: "s2",
														isMirrorRoot: true,
													},
													backlink:
													{
														sourceID: "s2",
														targetID: "t2",
													},
												},
											},
										],
									},
								]),
							},
						},
					]),
				]),
			);

			await adapter.catchUp();

			expect(edges()).toStrictEqual(
				{
					mirrors: [
						{
							mirrorId: "bl2",
							originalId: "s2",
						},
						{
							mirrorId: "m3",
							originalId: "o3",
						},
					],
					referencesRoots: [
						{
							nodeId: "rr2",
						},
					],
				},
			);
		});

		it("records the file attachments a remote transaction creates, adds, edits and removes as s3_files rows", async () =>
		{
			const {db, api, adapter} = tracked();
			storeTreeTxId(db, "100");
			const photo =
			{
				isFile: true,
				fileName: "example-photo.jpg",
				fileType: "image/jpeg",
				imageOriginalWidth: 800,
			};
			storeInternalMetadata(
				db,
				new Map([
					[
						"edited",
						{
							s3File:
							{
								isFile: true,
								fileName: "old.png",
								fileType: "image/png",
							},
						},
					],
					[
						"removed",
						{
							s3File:
							{
								isFile: true,
								fileName: "gone.png",
								fileType: "image/png",
							},
						},
					],
				]),
			);
			api.respondOnce(
				"/push_and_poll",
				poll("150", [
					transaction(141, [
						{
							type: "bulk_create",
							data:
							{
								parentid: "box",
								starting_priority: 0,
								project_trees: JSON.stringify([
									{
										id: "created",
										nm: "",
										metadata:
										{
											s3File: photo,
										},
									},
								]),
							},
						},
						{
							type: "edit",
							data:
							{
								projectid: "attached",
								metadataPatches: [
									{
										op: "add",
										path: ["s3File"],
										value: photo,
									},
								],
							},
						},
						{
							type: "edit",
							data:
							{
								projectid: "edited",
								metadataPatches: [
									{
										op: "add",
										path: ["s3File", "isDeleted"],
										value: true,
									},
								],
							},
						},
						{
							type: "edit",
							data:
							{
								projectid: "removed",
								metadataPatches: [
									{
										op: "remove",
										path: ["s3File"],
									},
								],
							},
						},
					]),
				]),
			);

			await adapter.catchUp();

			expect(
				db
					.select(
						{
							nodeId: schema.s3Files.nodeId,
							fileName: schema.s3Files.fileName,
							isDeleted: schema.s3Files.isDeleted,
						},
					)
					.from(schema.s3Files)
					.where(eq(schema.s3Files.systemTo, FAR_FUTURE_DATE))
					.all()
					.toSorted((a, b) => a.nodeId.localeCompare(b.nodeId)),
			).toStrictEqual([
				{
					nodeId: "attached",
					fileName: "example-photo.jpg",
					isDeleted: 0,
				},
				{
					nodeId: "created",
					fileName: "example-photo.jpg",
					isDeleted: 0,
				},
				{
					nodeId: "edited",
					fileName: "old.png",
					isDeleted: 1,
				},
			]);
		});

		it("merges a whole-map REST add instead of replacing it, then applies the leaf remove", async () =>
		{
			const {db, api, adapter, cache, edges} = tracked();
			storeTreeTxId(db, "100");
			cache.recordRelationships(
				{
					mirrors: [
						{
							mirrorId: "m2",
							originalId: "o2",
						},
					],
					referencesRoots: [],
					aiMetadata: [],
				},
			);
			api.respondOnce(
				"/push_and_poll",
				poll("120", [
					transaction(111, [
						{
							type: "edit",
							data:
							{
								projectid: "o2",
								metadataPatches: [
									{
										op: "add",
										path: ["mirror", "mirrorRootIds"],
										value:
										{
											m4: true,
										},
									},
								],
							},
						},
					]),
					transaction(112, [
						{
							type: "edit",
							data:
							{
								projectid: "o2",
								metadataPatches: [
									{
										op: "remove",
										path: ["mirror", "mirrorRootIds", "m4"],
									},
								],
							},
						},
						{
							type: "delete",
							data:
							{
								projectid: "m4",
							},
						},
					]),
				]),
			);

			await adapter.catchUp();

			expect(edges().mirrors).toStrictEqual([
				{
					mirrorId: "m2",
					originalId: "o2",
				},
			]);
		});

		it("ends every mirror row of a node on remove [mirror] and a references-root row on its remove, keeping a backlink item's mirror on remove [backlink]", async () =>
		{
			const {db, api, adapter, cache, edges} = tracked();
			storeTreeTxId(db, "100");
			cache.recordRelationships(
				{
					mirrors: [
						{
							mirrorId: "m3",
							originalId: "o3",
						},
						{
							mirrorId: "bl",
							originalId: "src",
						},
					],
					referencesRoots: [
						{
							nodeId: "rr",
						},
					],
					aiMetadata: [],
				},
			);
			api.respondOnce(
				"/push_and_poll",
				poll("130", [
					transaction(121, [
						{
							type: "edit",
							data:
							{
								projectid: "o3",
								metadataPatches: [
									{
										op: "remove",
										path: ["mirror"],
									},
								],
							},
						},
						{
							type: "edit",
							data:
							{
								projectid: "bl",
								metadataPatches: [
									{
										op: "remove",
										path: ["backlink"],
									},
								],
							},
						},
						{
							type: "edit",
							data:
							{
								projectid: "rr",
								metadataPatches: [
									{
										op: "remove",
										path: ["isReferencesRoot"],
									},
								],
							},
						},
					]),
				]),
			);

			await adapter.catchUp();

			expect(edges()).toStrictEqual(
				{
					mirrors: [
						{
							mirrorId: "bl",
							originalId: "src",
						},
					],
					referencesRoots: [],
				},
			);
		});

		it("ends the mirror and references-root rows a deleted node and its subtree own, including nodes created earlier in the batch", async () =>
		{
			const {db, api, adapter, cache, edges} = tracked();
			storeTreeTxId(db, "100");
			for (const [id, parentId] of [
				["p", null],
				["c", "p"],
				["gc", "c"],
				["o1", null],
				["m9", null],
			] as const)
			{
				db.insert(schema.nodeContent)
					.values(
						{
							id,
							name: id,
							parentId,
							systemFrom: systemTimeAt("2026-01-01 00:00:00.000"),
							systemTo: FAR_FUTURE_DATE,
						},
					)
					.run();
			}
			cache.recordRelationships(
				{
					mirrors: [
						{
							mirrorId: "c",
							originalId: "o1",
						},
						{
							mirrorId: "gc",
							originalId: "src",
						},
						{
							mirrorId: "m9",
							originalId: "o9",
						},
					],
					referencesRoots: [
						{
							nodeId: "p",
						},
					],
					aiMetadata: [],
				},
			);
			api.respondOnce(
				"/push_and_poll",
				poll("135", [
					transaction(131, [
						{
							type: "bulk_create",
							data:
							{
								parentid: "gc",
								starting_priority: 0,
								project_trees: JSON.stringify([
									{
										id: "n1",
										nm: "",
										ch: [
											{
												id: "n2",
												nm: "",
												metadata:
												{
													mirror:
													{
														originalId: "o5",
														isMirrorRoot: true,
													},
												},
											},
										],
									},
								]),
							},
						},
					]),
					transaction(132, [
						{
							type: "delete",
							data:
							{
								projectid: "p",
							},
						},
					]),
				]),
			);

			await adapter.catchUp();

			expect(edges()).toStrictEqual(
				{
					mirrors: [
						{
							mirrorId: "m9",
							originalId: "o9",
						},
					],
					referencesRoots: [],
				},
			);
		});

		it("applies a transaction the poll repeats from our own push only once", async () =>
		{
			const {db, api, adapter, edges} = tracked();
			storeTreeTxId(db, "100");
			const own = [leafAdd("orig", "mirrorRootIds", "m1")];
			api.respondOnce(
				"/push_and_poll",
				poll(
					"141",
					[
						transaction(140, own),
						transaction(141, [
							{
								type: "edit",
								data:
								{
									projectid: "orig",
									metadataPatches: [
										{
											op: "remove",
											path: ["mirror", "mirrorRootIds", "m1"],
										},
									],
								},
							},
						]),
					],
					{
						server_run_operation_transaction_json: transaction(140, own),
					},
				),
			);

			await adapter.catchUp();

			expect(edges().mirrors).toStrictEqual([]);
		});

		it("fails loudly without pushing when the cache was never seeded", async () =>
		{
			const {api, adapter} = tracked();
			const logged = vi.spyOn(console, "error").mockImplementation(() => {});

			const error = await caughtBy(adapter.catchUp());

			expect(
				{
					error,
					message: error instanceof Error ? error.message : undefined,
					pushes: startIds(api.requests),
					logged: logged.mock.calls,
				},
			).toStrictEqual(
				{
					error: expect.any(TreeNotSeeded),
					message:
						"The local cache has no Workflowy transaction id to sync from; run './bin/run.js cache import-api' to seed it",
					pushes: [],
					logged: [[error]],
				},
			);
		});

		it("fails loudly on need_refreshed_project_tree, applying nothing and keeping the stored id", async () =>
		{
			const {db, api, adapter, edges} = tracked();
			storeTreeTxId(db, "100");
			const logged = vi.spyOn(console, "error").mockImplementation(() => {});
			api.respondOnce(
				"/push_and_poll",
				poll(
					"160",
					[transaction(155, [leafAdd("orig", "mirrorRootIds", "m1")])],
					{
						need_refreshed_project_tree: true,
					},
				),
			);

			const error = await caughtBy(adapter.catchUp());

			expect(
				{
					error,
					message: error instanceof Error ? error.message : undefined,
					txId: readTreeTxId(db),
					mirrors: edges().mirrors,
					pushes: startIds(api.requests),
					logged: logged.mock.calls,
				},
			).toStrictEqual(
				{
					error: expect.any(TreeRefreshRequired),
					message:
						"Workflowy answered need_refreshed_project_tree: the cache's transaction id 100 is no longer in the tree's log; run './bin/run.js cache import-api' to reseed it",
					txId: "100",
					mirrors: [],
					pushes: ["100"],
					logged: [[error]],
				},
			);
		});

		it("closes the outbox rows of a drain whose ops workflowy.com ran before answering need_refreshed_project_tree, still failing loudly", async () =>
		{
			const {db, api, adapter} = tracked();
			storeTreeTxId(db, "100");
			vi.spyOn(console, "error").mockImplementation(() => {});
			new LocalTreeWriter(
				db,
				{
					outbox: new OutboxRecorder(),
				},
			).createAt(
				{
					parentId: null,
					index: 0,
					id: "n",
					name: "n",
				},
			);
			api.respondOnce(
				"/push_and_poll",
				poll(
					"160",
					[],
					{
						need_refreshed_project_tree: true,
						server_run_operation_transaction_json: transaction(160, [
							{
								type: "bulk_create",
								data:
								{
									parentid: "None",
									starting_priority: 0,
									project_trees: JSON.stringify([
										{
											id: "n",
											nm: "n",
										},
									]),
								},
							},
						]),
					},
				),
			);

			const error = await caughtBy(adapter.drainOutbox());

			expect(
				{
					error,
					txId: readTreeTxId(db),
					pending: db
						.select(
							{
								nodeId: schema.outbox.nodeId,
								aspect: schema.outbox.aspect,
							},
						)
						.from(schema.outbox)
						.where(eq(schema.outbox.systemTo, FAR_FUTURE_DATE))
						.all(),
				},
			).toStrictEqual(
				{
					error: expect.any(TreeRefreshRequired),
					txId: "100",
					pending: [],
				},
			);
		});
		it.each([
			{
				name: "an edit whose metadata patches do not parse",
				op:
				{
					type: "edit",
					data:
					{
						projectid: "orig",
						metadataPatches: [
							{
								op: "add",
								path: "mirror",
							},
						],
					},
				},
			},
			{
				name: "a bulk_create whose project_trees is not JSON",
				op:
				{
					type: "bulk_create",
					data:
					{
						parentid: "None",
						project_trees: "[{not json",
					},
				},
			},
			{
				name: "a delete with no projectid",
				op:
				{
					type: "delete",
					data: {},
				},
			},
			{
				name: "a bulk_create whose trees have no id",
				op:
				{
					type: "bulk_create",
					data:
					{
						parentid: "None",
						project_trees: JSON.stringify([
							{
								nm: "x",
							},
						]),
					},
				},
			},
		])("fails loudly on $name, naming the transaction, applying nothing and keeping the stored id", async ({op}) =>
		{
			const {db, api, adapter, edges} = tracked();
			storeTreeTxId(db, "100");
			const logged = vi.spyOn(console, "error").mockImplementation(() => {});
			api.respondOnce(
				"/push_and_poll",
				poll("160", [transaction(155, [leafAdd("orig", "mirrorRootIds", "m1")]), transaction(156, [op])]),
			);

			const error = await caughtBy(adapter.catchUp());

			expect(
				{
					error,
					resync: error instanceof TreeResyncRequired,
					message: error instanceof Error ? error.message : undefined,
					txId: readTreeTxId(db),
					mirrors: edges().mirrors,
					pushes: startIds(api.requests),
					logged: logged.mock.calls,
				},
			).toStrictEqual(
				{
					error: expect.any(UnreplayableTransaction),
					resync: true,
					message: `Workflowy transaction 156 has a ${op.type} op the cache cannot parse, so the cache would diverge from the tree; run './bin/run.js cache import-api' to reseed it`,
					txId: "100",
					mirrors: [],
					pushes: ["100"],
					logged: [[error]],
				},
			);
		});
	});
});

describe("internal adapter tree", () =>
{
	const migrationsFolder = join(import.meta.dirname, "../src/db/migrations");
	const START_MS = 1_800_000_000_000;
	/** The fake server's key for Home's children, matching upstream's root project id. */
	const ROOT = "None";

	const PushDataSchema = z.array(
		z.object(
			{
				operations: z
					.array(
						z
							.object(
								{
									type: z.string(),
									data: z.record(z.string(), z.unknown()),
								},
							)
							.loose(),
					)
					.optional(),
			},
		),
	);
	const OpDataSchema = z.object(
		{
			projectid: z.string().optional(),
			parentid: z.string().optional(),
			priority: z.number().optional(),
			starting_priority: z.number().optional(),
			project_trees: z.string().optional(),
			projectids_json: z.string().optional(),
		},
	);
	interface PushedTree
	{
		id: string;
		nm: string;
		ch?: PushedTree[] | undefined;
	}
	const TreeSchema: z.ZodType<PushedTree> = z.lazy(() =>
		z
			.object(
				{
					id: z.string(),
					nm: z.string(),
					ch: z.array(TreeSchema).optional(),
				},
			)
			.loose(),
	);
	const TreesSchema = z.array(TreeSchema);
	const IdsSchema = z.array(z.string());

	interface ServerNode
	{
		name: string;
		parent: string;
	}

	/**
	 * One server state behind both fakes: the internal `/push_and_poll` applies
	 * ops to it, and the public `/api/v1/nodes*` reads it. Home holds `a,b,c`;
	 * `a` holds `x`; `gone` was deleted from slot 1 of Home with its child `kid`
	 * and grandchild `grandkid`, which come back with it.
	 */
	function createServer()
	{
		const nodes = new Map<string, ServerNode>([
			[
				"a",
				{
					name: "a",
					parent: ROOT,
				},
			],
			[
				"b",
				{
					name: "b",
					parent: ROOT,
				},
			],
			[
				"c",
				{
					name: "c",
					parent: ROOT,
				},
			],
			[
				"x",
				{
					name: "x",
					parent: "a",
				},
			],
		]);
		const order = new Map<string, string[]>([
			[ROOT, ["a", "b", "c"]],
			["a", ["x"]],
		]);
		const trash = new Map<
			string,
			{
				node: ServerNode;
				index: number;
				descendants: [string, ServerNode][];
			}
		>([
			[
				"gone",
				{
					node:
					{
						name: "gone",
						parent: ROOT,
					},
					index: 1,
					descendants: [
						[
							"kid",
							{
								name: "kid",
								parent: "gone",
							},
						],
						[
							"grandkid",
							{
								name: "grandkid",
								parent: "kid",
							},
						],
					],
				},
			],
		]);
		const bringBackDescendants = (
			deleted:
				|
				  {
						descendants: [string, ServerNode][];
				  }
				| undefined,
		) =>
		{
			for (const [id, node] of deleted?.descendants ?? [])
			{
				nodes.set(id, node);
				order.set(node.parent, [...children(node.parent), id]);
			}
		};
		const children = (parent: string) => order.get(parent) ?? [];
		const insert = (parent: string, index: number, ids: string[]) =>
		{
			const list = [...children(parent)];
			list.splice(Math.min(index, list.length), 0, ...ids);
			order.set(parent, list);
		};
		const detach = (id: string) =>
		{
			const node = nodes.get(id);
			if (node)
			{
				order.set(
					node.parent,
					children(node.parent).filter((child) => child !== id),
				);
			}
		};
		const place = (id: string, parent: string) =>
		{
			const node = nodes.get(id) ??
			{
				name: id,
				parent,
			};
			nodes.set(
				id,
				{
					...node,
					parent,
				},
			);
		};

		function apply(type: string, rawData: Record<string, unknown>): void
		{
			const data = OpDataSchema.parse(rawData);
			const parent = data.parentid ?? ROOT;
			if (type === "bulk_create")
			{
				const trees = TreesSchema.parse(JSON.parse(data.project_trees ?? "[]"));
				const createUnder = (under: string, subtrees: PushedTree[]) =>
				{
					for (const tree of subtrees)
					{
						nodes.set(
							tree.id,
							{
								name: tree.nm,
								parent: under,
							},
						);
						createUnder(tree.id, tree.ch ?? []);
						order.set(
							tree.id,
							(tree.ch ?? []).map((child) => child.id),
						);
					}
				};
				createUnder(parent, trees);
				insert(
					parent,
					data.starting_priority ?? 0,
					trees.map((tree) => tree.id),
				);
			}
			else if (type === "move" && data.projectid !== undefined)
			{
				detach(data.projectid);
				place(data.projectid, parent);
				insert(parent, data.priority ?? 0, [data.projectid]);
			}
			else if (type === "bulk_move")
			{
				const ids = IdsSchema.parse(JSON.parse(data.projectids_json ?? "[]"));
				for (const id of ids)
				{
					detach(id);
					place(id, parent);
				}
				insert(parent, data.priority ?? 0, ids);
			}
			else if (type === "undelete" && data.projectid !== undefined)
			{
				const deleted = trash.get(data.projectid);
				trash.delete(data.projectid);
				nodes.set(
					data.projectid,
					{
						name: deleted?.node.name ?? data.projectid,
						parent,
					},
				);
				insert(parent, data.priority ?? 0, [data.projectid]);
				bringBackDescendants(deleted);
			}
		}

		function restoreFromTrash(id: string): boolean
		{
			const deleted = trash.get(id);
			if (!deleted)
			{
				return false;
			}
			trash.delete(id);
			nodes.set(id, deleted.node);
			insert(deleted.node.parent, deleted.index, [id]);
			bringBackDescendants(deleted);
			return true;
		}

		function toApi(id: string)
		{
			const node = nodes.get(id);
			if (!node)
			{
				throw new Error(`no node ${id}`);
			}
			return {
				id,
				name: node.name,
				note: null,
				parent_id: node.parent === ROOT ? null : node.parent,
				priority: children(node.parent).indexOf(id) * 100,
				completed: false,
				createdAt: 0,
				modifiedAt: 0,
				completedAt: null,
			};
		}

		function publicFetch(url: string): Response
		{
			const apiPath = url.replace("https://workflowy.test/api/v1", "");
			if (apiPath === "/nodes" || apiPath.startsWith("/nodes?"))
			{
				const parent = new URLSearchParams(apiPath.split("?")[1] ?? "").get("parent_id") ?? ROOT;
				return Response.json(
					{
						nodes: children(parent).map(toApi),
					},
				);
			}
			const id = apiPath.split("/")[2] ?? "";
			if (!nodes.has(id))
			{
				return Response.json(
					{
						error: "not found",
					},
					{
						status: 404,
					},
				);
			}
			return Response.json(
				{
					node: toApi(id),
				},
			);
		}

		return {
			apply,
			restoreFromTrash,
			publicFetch,
		};
	}

	const SERVER_RUN = JSON.stringify(
		{
			ops: [],
			client_timestamp: 300_000_000,
		},
	);

	function pushedOps(request: RecordedRequest):
	{
		type: string;
		data: Record<string, unknown>;
	}[]
	{
		const fields = new URLSearchParams(request.body ?? "");
		const trees = PushDataSchema.parse(JSON.parse(fields.get("push_poll_data") ?? "[]"));
		return trees.flatMap((tree) => tree.operations ?? []);
	}

	function setup(generateId: () => string = () => "new")
	{
		const sqlite = new DatabaseConstructor(":memory:");
		const db = drizzle(
			sqlite,
			{
				schema,
			},
		);
		migrate(
			db,
			{
				migrationsFolder,
			},
		);
		// A whole-tree import seeded the transaction-log position at the fake init's id.
		storeTreeTxId(db, "4567");
		const server = createServer();
		const publicCalls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) =>
			{
				publicCalls.push(`${init?.method ?? "GET"} ${url.replace("https://workflowy.test/api/v1", "")}`);
				return Promise.resolve(server.publicFetch(url));
			}),
		);
		const api = createFakeInternalApi();
		const pushes:
		{
			type: string;
			data: Record<string, unknown>;
		}[][] = [];
		api.respond("/push_and_poll", (request) =>
		{
			const ops = pushedOps(request);
			if (ops.length > 0)
			{
				pushes.push(ops);
			}
			for (const op of ops)
			{
				server.apply(op.type, op.data);
			}
			return json(
				{
					results: [
						{
							new_most_recent_operation_transaction_id: "4568",
							server_run_operation_transaction_json: SERVER_RUN,
							concurrent_remote_operation_transactions: [],
						},
					],
				},
			);
		});
		const restores: string[] = [];
		const internalFetch: typeof fetch = async (input, init) =>
		{
			const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
			const match = /^\/trash\/restore\/([^/]+)\/$/u.exec(url.pathname);
			if (match?.[1] !== undefined && init?.method === "POST")
			{
				restores.push(match[1]);
				return Promise.resolve(
					json(
						{
							succeeded: server.restoreFromTrash(match[1]),
						},
					),
				);
			}
			return api.fetch(input, init);
		};
		const client = new WorkflowyInternalClient(
			{
				credentials:
				{
					username: "alice@example.com",
					password: "hunter2",
				},
				fetch: internalFetch,
				baseUrl: "https://workflowy.test",
				transientId: "6f1c1d1e-0000-4000-8000-000000000001",
			},
		);
		const apiClient = new WorkflowyApiClient("test-key", undefined, "https://workflowy.test");
		const cacheService = new CacheService(db);
		const writeThrough = new WorkflowyWriteThroughClient(apiClient, cacheService);
		const adapter = new WorkflowyInternalAdapter(
			{
				client,
				db,
				writeThrough,
				now: () => START_MS,
				generateId,
				pushAndPoll:
				{
					randomId: () => "pollid01",
					timezone: "America/New_York",
				},
			},
		);
		const order = (parentId: string | null) => cacheService.getChildren(parentId).map((node) => node.id);
		return {
			sqlite,
			api,
			adapter,
			writeThrough,
			cacheService,
			pushes,
			restores,
			publicCalls,
			order,
		};
	}

	describe("WorkflowyInternalAdapter tree writes", () =>
	{
		let open: DatabaseConstructor.Database[] = [];
		afterEach(() =>
		{
			for (const sqlite of open)
			{
				sqlite.close();
			}
			open = [];
			vi.unstubAllGlobals();
		});
		async function tracked(generateId?: () => string)
		{
			const result = setup(generateId);
			open.push(result.sqlite);
			await result.writeThrough.refreshChildren([null, "a"]);
			return result;
		}

		it("creates at an exact index with one bulk_create carrying the client-chosen id, then refreshes Home's order", async () =>
		{
			const {adapter, pushes, order} = await tracked();

			await expect(
				adapter.createAt(
					{
						parentId: "home",
						index: 1,
						name: "",
					},
				),
			).resolves.toStrictEqual(
				{
					id: "new",
				},
			);

			expect(pushes).toStrictEqual([
				[
					{
						type: "bulk_create",
						data:
						{
							parentid: "None",
							starting_priority: 1,
							project_trees: JSON.stringify([
								{
									id: "new",
									nm: "",
									ct: 300_000_000,
									cb: 123,
									ch: [],
								},
							]),
							isForSearch: false,
						},
						client_timestamp: 300_000_000,
						undo_data: {},
					},
				],
			]);
			expect(order(null)).toStrictEqual(["a", "new", "b", "c"]);
		});

		it("creates an omitted index after the live last child, not the stale cached count", async () =>
		{
			const {adapter, pushes, cacheService} = await tracked();
			cacheService.deleteNode("c");

			await adapter.createAt(
				{
					parentId: "home",
					name: "x",
				},
			);

			expect(
				pushes.map((ops) => ops.map((op) => [op.type, OpDataSchema.parse(op.data).starting_priority])),
			).toStrictEqual([[["bulk_create", 3]]]);
		});

		it("moves an omitted index to the live bottom, not the stale cached count", async () =>
		{
			const {adapter, pushes, cacheService} = await tracked();
			cacheService.deleteNode("c");

			await adapter.moveTo(
				{
					ids: ["a"],
					parentId: "home",
				},
			);

			expect(pushes.map((ops) => ops.map((op) => [op.type, op.data]))).toStrictEqual([
				[
					[
						"move",
						{
							projectid: "a",
							parentid: "None",
							priority: 2,
						},
					],
				],
			]);
		});

		it.each([
			{
				afterId: "b",
				index: 0,
				expected: ["a", "b", "new", "c"],
			},
			{
				afterId: null,
				index: 2,
				expected: ["new", "a", "b", "c"],
			},
			{
				afterId: "gone",
				index: 1,
				expected: ["a", "new", "b", "c"],
			},
		])("creates below the live sibling $afterId over the stale index $index", async ({afterId, index, expected}) =>
		{
			const {adapter, order} = await tracked();

			await adapter.createAt(
				{
					parentId: "home",
					index,
					afterId,
					name: "",
				},
			);

			expect(order(null)).toStrictEqual(expected);
		});

		it("clamps a create index past the end to the fresh sibling count", async () =>
		{
			const {adapter, pushes, order} = await tracked();

			await adapter.createAt(
				{
					parentId: "a",
					index: 9,
					name: "y",
					note: "n",
					metadata:
					{
						layoutMode: "board",
					},
				},
			);

			expect(pushes.map((ops) => ops.map((op) => op.data))).toStrictEqual([
				[
					{
						parentid: "a",
						starting_priority: 1,
						project_trees: JSON.stringify([
							{
								id: "new",
								nm: "y",
								no: "n",
								metadata:
								{
									layoutMode: "board",
								},
								ct: 300_000_000,
								cb: 123,
								ch: [],
							},
						]),
						isForSearch: false,
					},
				],
			]);
			expect(order("a")).toStrictEqual(["x", "new"]);
		});

		it("creates with a caller-chosen id and caches the kept part of its metadata", async () =>
		{
			const {adapter, pushes, order, sqlite} = await tracked();
			const calendar =
			{
				level: "day",
				value: "17",
				timestamp: 1,
				dateId: 20_261_017,
			};

			await expect(
				adapter.createAt(
					{
						parentId: "a",
						index: 0,
						id: "day-id",
						name: "d",
						metadata:
						{
							restorableUniqueNode: true,
							calendar,
						},
					},
				),
			).resolves.toStrictEqual(
				{
					id: "day-id",
				},
			);

			expect(
				{
					trees: pushes.map((ops) => ops.map((op) => JSON.parse(String(op.data.project_trees)) as unknown)),
					order: order("a"),
					cached: cachedMetadata(sqlite, ["day-id"]),
				},
			).toStrictEqual(
				{
					trees: [
						[
							[
								{
									id: "day-id",
									nm: "d",
									metadata:
									{
										restorableUniqueNode: true,
										calendar,
									},
									ct: 300_000_000,
									cb: 123,
									ch: [],
								},
							],
						],
					],
					order: ["day-id", "x"],
					cached:
					{
						"day-id":
						{
							calendar,
							restorableUniqueNode: true,
						},
					},
				},
			);
		});

		it("moves one node to the top with one move at priority 0", async () =>
		{
			const {adapter, pushes, order} = await tracked();

			await adapter.moveTo(
				{
					ids: ["c"],
					parentId: "home",
					index: 0,
				},
			);

			expect(pushes.map((ops) => ops.map((op) => [op.type, op.data]))).toStrictEqual([
				[
					[
						"move",
						{
							projectid: "c",
							parentid: "None",
							priority: 0,
						},
					],
				],
			]);
			expect(order(null)).toStrictEqual(["c", "a", "b"]);
		});

		it("moves a node down within its parent with the post-removal priority", async () =>
		{
			const {adapter, pushes, order} = await tracked();

			await adapter.moveTo(
				{
					ids: ["a"],
					parentId: "home",
					index: 3,
				},
			);

			expect(pushes.map((ops) => ops.map((op) => [op.type, op.data]))).toStrictEqual([
				[
					[
						"move",
						{
							projectid: "a",
							parentid: "None",
							priority: 2,
						},
					],
				],
			]);
			expect(order(null)).toStrictEqual(["b", "c", "a"]);
		});

		it("moves several nodes with one bulk_move and refreshes both parents", async () =>
		{
			const {adapter, pushes, order} = await tracked();

			await adapter.moveTo(
				{
					ids: ["b", "c"],
					parentId: "x",
					index: 0,
				},
			);

			expect(pushes.map((ops) => ops.map((op) => [op.type, op.data]))).toStrictEqual([
				[
					[
						"bulk_move",
						{
							projectids_json: JSON.stringify(["b", "c"]),
							parentid: "x",
							priority: 0,
						},
					],
				],
			]);
			expect(
				{
					home: order(null),
					x: order("x"),
				},
			).toStrictEqual(
				{
					home: ["a"],
					x: ["b", "c"],
				},
			);
		});

		it("moves several blocks in one push, planning each against the outline the earlier ones leave", async () =>
		{
			const {adapter, pushes, order} = await tracked();

			await adapter.moveBlocks([
				{
					ids: ["c"],
					parentId: "home",
					index: 0,
				},
				{
					ids: ["a"],
					parentId: "home",
					index: 3,
				},
				{
					ids: ["b"],
					parentId: "x",
				},
			]);

			expect(pushes.map((ops) => ops.map((op) => [op.type, op.data]))).toStrictEqual([
				[
					[
						"move",
						{
							projectid: "c",
							parentid: "None",
							priority: 0,
						},
					],
					[
						"move",
						{
							projectid: "a",
							parentid: "None",
							priority: 2,
						},
					],
					[
						"move",
						{
							projectid: "b",
							parentid: "x",
							priority: 0,
						},
					],
				],
			]);
			expect(
				{
					home: order(null),
					x: order("x"),
				},
			).toStrictEqual(
				{
					home: ["c", "a"],
					x: ["b"],
				},
			);
		});

		it("restores into a given slot with one undelete", async () =>
		{
			const {adapter, pushes, restores, order} = await tracked();

			await adapter.restore(
				{
					id: "gone",
					parentId: "home",
					index: 0,
				},
			);

			expect(
				{
					restores,
					pushes: pushes.map((ops) => ops.map((op) => [op.type, op.data])),
				},
			).toStrictEqual(
				{
					restores: [],
					pushes: [
						[
							[
								"undelete",
								{
									projectid: "gone",
									parentid: "None",
									priority: 0,
								},
							],
						],
					],
				},
			);
			expect(
				{
					home: order(null),
					gone: order("gone"),
					kid: order("kid"),
				},
			).toStrictEqual(
				{
					home: ["gone", "a", "b", "c"],
					gone: ["kid"],
					kid: ["grandkid"],
				},
			);
		});

		it("restores to the original place through /trash/restore when no slot is given", async () =>
		{
			const {adapter, pushes, restores, order} = await tracked();

			await adapter.restore(
				{
					id: "gone",
				},
			);

			expect(
				{
					restores,
					pushes,
				},
			).toStrictEqual(
				{
					restores: ["gone"],
					pushes: [],
				},
			);
			expect(
				{
					home: order(null),
					gone: order("gone"),
					kid: order("kid"),
				},
			).toStrictEqual(
				{
					home: ["a", "gone", "b", "c"],
					gone: ["kid"],
					kid: ["grandkid"],
				},
			);
		});

		it("sets node metadata with one edit, and maps home to None", async () =>
		{
			const {adapter, pushes} = await tracked();

			await adapter.setNodeMeta("a", ["layoutMode"], "board");
			await adapter.setNodeMeta("home", ["layoutMode"], "board");

			expect(pushes.map((ops) => ops.map((op) => [op.type, op.data]))).toStrictEqual([
				[
					[
						"edit",
						{
							projectid: "a",
							metadataPatches: [
								{
									op: "add",
									path: ["layoutMode"],
									value: "board",
								},
							],
							metadataInversePatches: [
								{
									op: "remove",
									path: ["layoutMode"],
								},
							],
						},
					],
				],
				[
					[
						"edit",
						{
							projectid: "None",
							metadataPatches: [
								{
									op: "add",
									path: ["layoutMode"],
									value: "board",
								},
							],
							metadataInversePatches: [
								{
									op: "remove",
									path: ["layoutMode"],
								},
							],
						},
					],
				],
			]);
		});

		it("sets several node metadata values with one edit and caches the kept ones", async () =>
		{
			const {adapter, pushes, sqlite} = await tracked();

			await adapter.setNodeMetaValues("a", [
				{
					path: ["layoutMode"],
					value: "numbered",
				},
				{
					path: ["numbered_start"],
					value: 5,
				},
			]);

			expect(
				{
					pushes: pushes.map((ops) => ops.map((op) => [op.type, op.data])),
					cached: cachedMetadata(sqlite, ["a"]),
				},
			).toStrictEqual(
				{
					pushes: [
						[
							[
								"edit",
								{
									projectid: "a",
									metadataPatches: [
										{
											op: "add",
											path: ["layoutMode"],
											value: "numbered",
										},
										{
											op: "add",
											path: ["numbered_start"],
											value: 5,
										},
									],
									metadataInversePatches: [
										{
											op: "remove",
											path: ["numbered_start"],
										},
										{
											op: "remove",
											path: ["layoutMode"],
										},
									],
								},
							],
						],
					],
					cached:
					{
						a:
						{
							numbered_start: 5,
							layoutMode: "numbered",
						},
					},
				},
			);
		});

		it("sends home's metadata values to the root as one edit", async () =>
		{
			const {adapter, pushes} = await tracked();

			await adapter.setNodeMetaValues("home", [
				{
					path: ["layoutMode"],
					value: "board",
				},
			]);

			expect(pushes.map((ops) => ops.map((op) => [op.type, op.data]))).toStrictEqual([
				[
					[
						"edit",
						{
							projectid: "None",
							metadataPatches: [
								{
									op: "add",
									path: ["layoutMode"],
									value: "board",
								},
							],
							metadataInversePatches: [
								{
									op: "remove",
									path: ["layoutMode"],
								},
							],
						},
					],
				],
			]);
		});

		it("patches the cached internal metadata after each accepted node metadata edit", async () =>
		{
			const {adapter, sqlite} = await tracked();
			const display = () =>
				sqlite
					.prepare(
						"SELECT numbered_start, priority_default_to_bottom, system_to FROM node_display_metadata WHERE node_id = 'a' ORDER BY system_from",
					)
					.all()
					.map((row) => (
					{
						...z.record(z.string(), z.unknown()).parse(row),
						system_to: Reflect.get(Object(row), "system_to") === FAR_FUTURE_DATE ? "live" : "closed",
					}));

			await adapter.setNodeMeta("a", ["numbered_start"], 5);
			await adapter.setNodeMeta("a", ["priority", "defaultToBottom"], true);
			const afterSet = cachedMetadata(sqlite, ["a"]);
			await adapter.setNodeMeta("a", ["numbered_start"], undefined);
			await adapter.setNodeMeta("a", ["priority", "defaultToBottom"], undefined);

			expect(
				{
					afterSet,
					afterRemove: cachedMetadata(sqlite, ["a"]),
					versions: display(),
				},
			).toStrictEqual(
				{
					afterSet:
					{
						a:
						{
							numbered_start: 5,
							priority:
							{
								defaultToBottom: true,
							},
						},
					},
					afterRemove: {},
					versions: [
						{
							numbered_start: 5,
							priority_default_to_bottom: null,
							system_to: "closed",
						},
						{
							numbered_start: 5,
							priority_default_to_bottom: 1,
							system_to: "closed",
						},
						{
							numbered_start: null,
							priority_default_to_bottom: 1,
							system_to: "closed",
						},
					],
				},
			);
		});

		it("leaves the cache untouched and reads nothing back when the push is rejected", async () =>
		{
			const {api, adapter, order, publicCalls} = await tracked();
			api.respond("/push_and_poll", () =>
				json(
					{
						results: [
							{
								new_most_recent_operation_transaction_id: "4568",
								error: "bad op",
							},
						],
					},
				),
			);
			const callsBefore = publicCalls.length;

			await expect(
				adapter.moveTo(
					{
						ids: ["c"],
						parentId: "home",
						index: 0,
					},
				),
			).rejects.toBeInstanceOf(OperationRejected);

			expect(order(null)).toStrictEqual(["a", "b", "c"]);
			expect(publicCalls.slice(callsBefore)).toStrictEqual(["GET /nodes/c", "GET /nodes"]);
		});

		/** The kept metadata stored for `ids`, keyed by id; ids with none are absent. */
		function cachedMetadata(sqlite: DatabaseConstructor.Database, ids: string[]): Record<string, unknown>
		{
			return Object.fromEntries(
				readInternalMetadata(
					drizzle(
						sqlite,
						{
							schema,
						},
					),
					ids,
				),
			);
		}
	});
});

describe("internal client bootstrap", () =>
{
	const TRANSIENT_ID = "6f1c1d1e-0000-4000-8000-000000000001";
	const BASE_URL = "https://workflowy.test";

	function clientWith(api = createFakeInternalApi())
	{
		const client = new WorkflowyInternalClient(
			{
				credentials:
				{
					username: "alice@example.com",
					password: "hunter2",
				},
				fetch: api.fetch,
				baseUrl: BASE_URL,
				transientId: TRANSIENT_ID,
			},
		);
		return {
			api,
			client,
		};
	}

	const EXPECTED_SESSION =
	{
		clientId: FAKE_CLIENT_ID,
		clientVersion: "25",
		userId: 123,
		ownerId: 123,
		dateJoinedSec: 1_500_000_000,
		txId: "4567",
		rootMetadata:
		{
			starring:
			{
				locations:
				{
					abc: "None",
				},
			},
		},
		settings:
		{
			theme: "dark",
			show_completed: true,
		},
		expandedKeys: ["1a2b3c4d"],
		visibleFeatures: [],
	};

	const INIT_HEADERS =
	{
		cookie: `sessionid=${FAKE_SESSION_ID}`,
		accept: "application/json",
		"x-requested-with": "XMLHttpRequest",
		"wf-transient-id": TRANSIENT_ID,
	};

	describe("WorkflowyInternalClient.bootstrap", () =>
	{
		it("logs in, then fetches initialization data once and parses the session", async () =>
		{
			const {api, client} = clientWith();

			const session = await client.bootstrap();

			expect(session).toStrictEqual(EXPECTED_SESSION);
			expect(api.requests.map((r) => [r.method, r.path])).toStrictEqual([
				["POST", "/ajax_login"],
				["GET", "/get_initialization_data"],
			]);
			const init = api.requests[1];
			expect(init?.url).toBe(
				`${BASE_URL}/get_initialization_data?client_version=21&client_version_v2=28&no_root_children=1`,
			);
			expect(init?.headers).toStrictEqual(INIT_HEADERS);
		});

		it("fails loudly, without downloading the tree, when init has no transaction id", async () =>
		{
			const api = createFakeInternalApi();
			const data = initializationData();
			const tree = (
				data.projectTreeData as
				{
					mainProjectTreeInfo: Record<string, unknown>;
				}
			).mainProjectTreeInfo;
			delete tree.initialMostRecentOperationTransactionId;
			api.respond("/get_initialization_data", () =>
				json(
					data,
					{
						headers:
						{
							wfclientid: FAKE_CLIENT_ID,
						},
					},
				),
			);
			const {client} = clientWith(api);

			const error = await client.bootstrap().catch((thrown: unknown) => thrown);

			expect(error).toStrictEqual(
				new InternalApiError(
					"get_initialization_data omitted projectTreeData.mainProjectTreeInfo.initialMostRecentOperationTransactionId",
				),
			);
			expect(error).toBeInstanceOf(InternalApiError);
			expect(api.requests.map((r) => [r.method, r.path])).toStrictEqual([
				["POST", "/ajax_login"],
				["GET", "/get_initialization_data"],
			]);
		});

		it("reads user, settings, root metadata and globals from /get_user_data/ when init omits them (live shape)", async () =>
		{
			const api = createFakeInternalApi();
			const data = initializationData(
				{
					isReadOnly: null,
				},
			);
			const treeData = data.projectTreeData as Record<string, unknown>;
			delete treeData.rootProjectMetadata;
			delete data.settings;
			delete data.user;
			delete data.globals;
			delete data.features;
			api.respond("/get_initialization_data", () =>
				json(
					data,
					{
						headers:
						{
							wfclientid: FAKE_CLIENT_ID,
						},
					},
				),
			);
			api.respond("/get_user_data/", () =>
				json(
					{
						user:
						{
							id: 123,
							email: "alice@example.com",
						},
						globals: [["SHOW_COMPLETED_DEFAULT", true]],
						settings:
						{
							theme: "dark",
							show_completed: true,
						},
						features: [],
						rootProjectMetadata:
						{
							starring:
							{
								locations:
								{
									abc: "None",
								},
							},
						},
					},
				),
			);
			const {client} = clientWith(api);

			const session = await client.bootstrap();

			expect(session).toStrictEqual(
				{
					...EXPECTED_SESSION,
					clientVersion: "21",
				},
			);
			expect(api.requests.map((r) => [r.method, r.path])).toStrictEqual([
				["POST", "/ajax_login"],
				["GET", "/get_initialization_data"],
				["GET", "/get_user_data/"],
			]);
			expect(api.requests[2]?.headers).toStrictEqual(INIT_HEADERS);
		});

		it("parses the visible feature list from the init data, keeping only codename, name, label and description", async () =>
		{
			const api = createFakeInternalApi();
			const data = initializationData();
			data.features = [
				{
					codename: "bdl",
					name: "Backlinks",
					label: null,
					description: "d",
					beta: true,
					workflowy_dev: false,
				},
				{
					codename: "dashboards",
					name: "Dashboard layout",
					label: "LABS",
					description: "x",
				},
				{
					codename: "bare",
					name: "Bare",
				},
			];
			api.respond("/get_initialization_data", () =>
				json(
					data,
					{
						headers:
						{
							wfclientid: FAKE_CLIENT_ID,
						},
					},
				),
			);
			const {client} = clientWith(api);

			const session = await client.bootstrap();

			expect(session.visibleFeatures).toStrictEqual([
				{
					codename: "bdl",
					name: "Backlinks",
					label: null,
					description: "d",
				},
				{
					codename: "dashboards",
					name: "Dashboard layout",
					label: "LABS",
					description: "x",
				},
				{
					codename: "bare",
					name: "Bare",
					label: null,
					description: null,
				},
			]);
		});

		it("parses the visible feature list from /get_user_data/ on the live shape, and gives [] without one", async () =>
		{
			const api = createFakeInternalApi();
			const data = initializationData();
			delete data.user;
			api.respond("/get_initialization_data", () =>
				json(
					data,
					{
						headers:
						{
							wfclientid: FAKE_CLIENT_ID,
						},
					},
				),
			);
			api.respond("/get_user_data/", () =>
				json(
					{
						user:
						{
							id: 123,
						},
						features: [
							{
								codename: "dates",
								name: "Dates",
								label: null,
								description: "d",
							},
						],
					},
				),
			);
			const {client} = clientWith(api);

			const session = await client.bootstrap();

			expect(session.visibleFeatures).toStrictEqual([
				{
					codename: "dates",
					name: "Dates",
					label: null,
					description: "d",
				},
			]);
			const bare = createFakeInternalApi();
			const noFeatures = initializationData();
			delete noFeatures.features;
			bare.respond("/get_initialization_data", () =>
				json(
					noFeatures,
					{
						headers:
						{
							wfclientid: FAKE_CLIENT_ID,
						},
					},
				),
			);
			await expect(clientWith(bare).client.bootstrap()).resolves.toMatchObject(
				{
					visibleFeatures: [],
				},
			);
		});

		it("carries the user's entropyKey (salt of upstream's deterministic ids) when the server sends one", async () =>
		{
			const api = createFakeInternalApi();
			const data = initializationData();
			data.user =
			{
				id: 123,
				email: "alice@example.com",
				entropyKey: "k".repeat(64),
			};
			api.respond("/get_initialization_data", () =>
				json(
					data,
					{
						headers:
						{
							wfclientid: FAKE_CLIENT_ID,
						},
					},
				),
			);
			const {client} = clientWith(api);

			const session = await client.bootstrap();

			expect(session).toStrictEqual(
				{
					...EXPECTED_SESSION,
					entropyKey: "k".repeat(64),
				},
			);
		});

		it("carries the user's fullName, and parses a null one", async () =>
		{
			const named = createFakeInternalApi();
			const data = initializationData();
			data.user =
			{
				id: 123,
				email: "alice@example.com",
				fullName: "Alice Smith",
			};
			named.respond("/get_initialization_data", () =>
				json(
					data,
					{
						headers:
						{
							wfclientid: FAKE_CLIENT_ID,
						},
					},
				),
			);
			const unnamed = createFakeInternalApi();
			const nullData = initializationData();
			nullData.user =
			{
				id: 123,
				email: "alice@example.com",
				fullName: null,
			};
			unnamed.respond("/get_initialization_data", () =>
				json(
					nullData,
					{
						headers:
						{
							wfclientid: FAKE_CLIENT_ID,
						},
					},
				),
			);

			await expect(clientWith(named).client.bootstrap()).resolves.toStrictEqual(
				{
					...EXPECTED_SESSION,
					fullName: "Alice Smith",
				},
			);
			await expect(clientWith(unnamed).client.bootstrap()).resolves.toStrictEqual(EXPECTED_SESSION);
		});

		it("accepts a null isReadOnly (sent live) and a null ownerId", async () =>
		{
			const api = createFakeInternalApi();
			const data = initializationData();
			const tree = (
				data.projectTreeData as
				{
					mainProjectTreeInfo: Record<string, unknown>;
				}
			).mainProjectTreeInfo;
			tree.isReadOnly = null;
			tree.ownerId = null;
			api.respond("/get_initialization_data", () =>
				json(
					data,
					{
						headers:
						{
							wfclientid: FAKE_CLIENT_ID,
						},
					},
				),
			);
			const {client} = clientWith(api);

			const session = await client.bootstrap();

			expect(session).toStrictEqual(EXPECTED_SESSION);
		});

		it("reuses the session cookie on a second bootstrap and sends the learned client version", async () =>
		{
			const {api, client} = clientWith();

			await client.bootstrap();
			const second = await client.bootstrap();

			expect(second).toStrictEqual(EXPECTED_SESSION);
			expect(api.requests.map((r) => [r.method, r.path])).toStrictEqual([
				["POST", "/ajax_login"],
				["GET", "/get_initialization_data"],
				["GET", "/get_initialization_data"],
			]);
			expect(api.requests[2]?.url).toBe(
				`${BASE_URL}/get_initialization_data?client_version=25&client_version_v2=28&no_root_children=1`,
			);
			expect(client.session).toStrictEqual(EXPECTED_SESSION);
		});

		it("re-logs in exactly once when init redirects to the login page", async () =>
		{
			const {api, client} = clientWith();
			api.respondOnce(
				"/get_initialization_data",
				() =>
					new Response(
						"",
						{
							status: 302,
							headers:
							{
								location: "/login/",
							},
						},
					),
			);

			const session = await client.bootstrap();

			expect(session).toStrictEqual(EXPECTED_SESSION);
			expect(api.requests.map((r) => [r.method, r.path])).toStrictEqual([
				["POST", "/ajax_login"],
				["GET", "/get_initialization_data"],
				["POST", "/ajax_login"],
				["GET", "/get_initialization_data"],
			]);
		});

		it("re-logs in exactly once when init reports logged_out", async () =>
		{
			const {api, client} = clientWith();
			api.respondOnce("/get_initialization_data", () =>
				json(
					{
						logged_out: true,
					},
				),
			);

			const session = await client.bootstrap();

			expect(session).toStrictEqual(EXPECTED_SESSION);
			expect(api.requests.map((r) => [r.method, r.path])).toStrictEqual([
				["POST", "/ajax_login"],
				["GET", "/get_initialization_data"],
				["POST", "/ajax_login"],
				["GET", "/get_initialization_data"],
			]);
		});

		it("gives up after one re-login when the session keeps being rejected", async () =>
		{
			const {api, client} = clientWith();
			api.respond("/get_initialization_data", () =>
				json(
					{
						logged_out: true,
					},
				),
			);

			await expect(client.bootstrap()).rejects.toThrow(new SessionRejectedError("logged_out"));
			expect(api.requests.map((r) => [r.method, r.path])).toStrictEqual([
				["POST", "/ajax_login"],
				["GET", "/get_initialization_data"],
				["POST", "/ajax_login"],
				["GET", "/get_initialization_data"],
			]);
		});
	});
});

describe("internal client session store", () =>
{
	const BASE_URL = "https://workflowy.test";
	const CREDENTIALS =
	{
		username: "alice@example.com",
		password: "hunter2",
	};
	const SAVED_COOKIE = "sessionid=saved-session-0";

	function memoryStore(initial?: string): SessionCookieStore &
	{
		writes: string[];
	}
	{
		let value = initial;
		const writes: string[] = [];
		return {
			writes,
			read: () => value,
			write: (cookie) =>
			{
				value = cookie;
				writes.push(cookie);
			},
			clear: () =>
			{
				value = undefined;
			},
		};
	}

	const tempDirs: string[] = [];
	function tempFile(): string
	{
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-session-"));
		tempDirs.push(dir);
		return path.join(dir, "workflowy-session");
	}

	afterEach(() =>
	{
		for (const dir of tempDirs.splice(0))
		{
			fs.rmSync(
				dir,
				{
					recursive: true,
					force: true,
				},
			);
		}
	});

	describe("WorkflowyInternalClient with a session store", () =>
	{
		it("reuses a stored cookie without logging in", async () =>
		{
			const api = createFakeInternalApi();
			const store = memoryStore(SAVED_COOKIE);
			const client = new WorkflowyInternalClient(
				{
					sessionStore: store,
					fetch: api.fetch,
					baseUrl: BASE_URL,
				},
			);

			await client.bootstrap();

			expect(api.requests.map((r) => [r.method, r.path, r.headers.cookie])).toStrictEqual([
				["GET", "/get_initialization_data", SAVED_COOKIE],
			]);
			expect(store.writes).toStrictEqual([]);
		});

		it("logs in once with the password on an expired cookie and rewrites the store", async () =>
		{
			const api = createFakeInternalApi();
			api.respondOnce(
				"/get_initialization_data",
				() =>
					new Response(
						"",
						{
							status: 302,
							headers:
							{
								location: "/login/",
							},
						},
					),
			);
			const store = memoryStore(SAVED_COOKIE);
			const client = new WorkflowyInternalClient(
				{
					credentials: CREDENTIALS,
					sessionStore: store,
					fetch: api.fetch,
					baseUrl: BASE_URL,
				},
			);

			await client.bootstrap();

			expect(api.requests.map((r) => [r.method, r.path, r.headers.cookie])).toStrictEqual([
				["GET", "/get_initialization_data", SAVED_COOKIE],
				["POST", "/ajax_login", undefined],
				["GET", "/get_initialization_data", `sessionid=${FAKE_SESSION_ID}`],
			]);
			expect(store.writes).toStrictEqual([`sessionid=${FAKE_SESSION_ID}`]);
		});

		it("re-logs in for getTreeSnapshot too when the stored cookie is logged out", async () =>
		{
			const api = createFakeInternalApi();
			api.respondOnce("/get_tree_data/", () =>
				json(
					{
						logged_out: true,
					},
				),
			);
			const store = memoryStore(SAVED_COOKIE);
			const client = new WorkflowyInternalClient(
				{
					credentials: CREDENTIALS,
					sessionStore: store,
					fetch: api.fetch,
					baseUrl: BASE_URL,
				},
			);

			const result = await client.getTreeSnapshot();

			expect(result).toStrictEqual(
				{
					items: [],
					txId: "9999",
					expandedKeys: [],
				},
			);
			expect(api.requests.map((r) => [r.method, r.path])).toStrictEqual([
				["GET", "/get_tree_data/"],
				["POST", "/ajax_login"],
				["GET", "/get_tree_data/"],
			]);
			expect(store.writes).toStrictEqual([`sessionid=${FAKE_SESSION_ID}`]);
		});

		it("fails clearly when the cookie expired and no credentials are available", async () =>
		{
			const api = createFakeInternalApi();
			api.respond("/get_initialization_data", () =>
				json(
					{
						logged_out: true,
					},
				),
			);
			const client = new WorkflowyInternalClient(
				{
					sessionStore: memoryStore(SAVED_COOKIE),
					fetch: api.fetch,
					baseUrl: BASE_URL,
				},
			);

			await expect(client.bootstrap()).rejects.toThrow(
				new Error(
					"Workflowy session cookie is missing or expired and WORKFLOWY_USERNAME/WORKFLOWY_PASSWORD are not set; set them in the environment (e.g. from .envrc), or run './bin/run.js internal login' with them set",
				),
			);
			expect(api.requests.map((r) => [r.method, r.path])).toStrictEqual([["GET", "/get_initialization_data"]]);
		});

		it("fails clearly with neither a cookie nor credentials", async () =>
		{
			const api = createFakeInternalApi();
			const client = new WorkflowyInternalClient(
				{
					sessionStore: memoryStore(),
					fetch: api.fetch,
					baseUrl: BASE_URL,
				},
			);

			await expect(client.bootstrap()).rejects.toThrow(
				new Error(
					"Workflowy session cookie is missing or expired and WORKFLOWY_USERNAME/WORKFLOWY_PASSWORD are not set; set them in the environment (e.g. from .envrc), or run './bin/run.js internal login' with them set",
				),
			);
			expect(api.requests).toStrictEqual([]);
		});
	});

	describe("fileSessionStore", () =>
	{
		it("reads nothing when the file is missing, then round-trips a cookie with mode 0600", () =>
		{
			const file = tempFile();
			const store = fileSessionStore(file);

			expect(store.read()).toBeUndefined();
			store.write(SAVED_COOKIE);

			expect(store.read()).toBe(SAVED_COOKIE);
			expect(fs.statSync(file).mode & 0o777).toBe(0o600);
		});

		it("tightens an existing file to 0600 on rewrite and deletes it on clear", () =>
		{
			const file = tempFile();
			fs.writeFileSync(
				file,
				"sessionid=old\n",
				{
					mode: 0o644,
				},
			);
			const store = fileSessionStore(file);

			store.write(SAVED_COOKIE);
			expect(fs.statSync(file).mode & 0o777).toBe(0o600);
			expect(store.read()).toBe(SAVED_COOKIE);

			store.clear();
			expect(fs.existsSync(file)).toBe(false);
			expect(store.read()).toBeUndefined();
		});
	});

	describe("readInternalAuth", () =>
	{
		it("defaults the session file to .llm/workflowy-session at the repository root", () =>
		{
			expect(DEFAULT_SESSION_FILE).toBe(path.resolve(import.meta.dirname, "../../../.llm/workflowy-session"));
		});

		it("is undefined with neither credentials nor a session file", () =>
		{
			expect(
				readInternalAuth(
					{
						OUTLINEDB_SESSION_FILE: tempFile(),
					},
				),
			).toBeUndefined();
		});

		it("is configured by a session file alone", () =>
		{
			const file = tempFile();
			fs.writeFileSync(file, SAVED_COOKIE);

			const auth = readInternalAuth(
				{
					OUTLINEDB_SESSION_FILE: file,
				},
			);

			expect(auth?.credentials).toBeUndefined();
			expect(auth?.sessionStore.read()).toBe(SAVED_COOKIE);
		});

		it("is configured by credentials alone", () =>
		{
			const auth = readInternalAuth(
				{
					OUTLINEDB_SESSION_FILE: tempFile(),
					WORKFLOWY_USERNAME: CREDENTIALS.username,
					WORKFLOWY_PASSWORD: CREDENTIALS.password,
				},
			);

			expect(auth?.credentials).toStrictEqual(CREDENTIALS);
			expect(auth?.sessionStore.read()).toBeUndefined();
		});
	});
});

describe("internal client signed file", () =>
{
	describe("WorkflowyInternalClient.signedFileUrl", () =>
	{
		it("GETs the file-proxy path with the session cookie and returns the signed url", async () =>
		{
			const seen:
			{
				url: string;
				cookie: string | undefined;
			}[] = [];
			const fetchStub: typeof fetch = async (input, init) =>
			{
				seen.push(
					{
						url: typeof input === "string" ? input : "",
						cookie: new Headers(init?.headers).get("cookie") ?? undefined,
					},
				);
				return Promise.resolve(
					Response.json(
						{
							url: "https://s3.example/signed",
						},
					),
				);
			};
			const client = new WorkflowyInternalClient(
				{
					sessionStore:
					{
						read: () => "sessionid=abc",
						write: () =>
						{
						},
						clear: () =>
						{
						},
					},
					fetch: fetchStub,
					baseUrl: "https://workflowy.test",
				},
			);

			const url = await client.signedFileUrl("/file-proxy/signed-original/7/n1/?attempt=1");

			expect(
				{
					url,
					seen,
				},
			).toStrictEqual(
				{
					url: "https://s3.example/signed",
					seen: [
						{
							url: "https://workflowy.test/file-proxy/signed-original/7/n1/?attempt=1",
							cookie: "sessionid=abc",
						},
					],
				},
			);
		});
	});
});

describe("internal links", () =>
{
	describe("internalLinkShortIds", () =>
	{
		it("reads a short id from a workflowy.com link", () =>
		{
			expect(internalLinkShortIds('<a href="https://workflowy.com/#/81df3e9581ea">a</a>')).toStrictEqual([
				"81df3e9581ea",
			]);
		});

		it("rejects a link whose hash carries a search", () =>
		{
			expect(internalLinkShortIds('<a href="https://workflowy.com/#/81df3e9581ea?q=x">a</a>')).toStrictEqual([]);
		});

		it("accepts any host", () =>
		{
			expect(internalLinkShortIds('<a href="https://example.com/#/81df3e9581ea">a</a>')).toStrictEqual([
				"81df3e9581ea",
			]);
		});

		it("rejects a relative href", () =>
		{
			expect(internalLinkShortIds('<a href="/#/81df3e9581ea">a</a>')).toStrictEqual([]);
		});

		it("deduplicates links to the same id", () =>
		{
			expect(
				internalLinkShortIds(
					'<a href="https://workflowy.com/#/81df3e9581ea">a</a> <a href="https://workflowy.com/#/81df3e9581ea">b</a>',
				),
			).toStrictEqual(["81df3e9581ea"]);
		});

		it("reduces a full uuid hash to its last 12 hex", () =>
		{
			expect(
				internalLinkShortIds('<a href="https://workflowy.com/#/11111111-2222-3333-4444-81df3e9581ea">a</a>'),
			).toStrictEqual(["81df3e9581ea"]);
		});

		it("hasInternalLink follows the same rule", () =>
		{
			expect(hasInternalLink('<a href="https://workflowy.com/#/81df3e9581ea?q=x">a</a>')).toBe(false);
		});
	});
});

describe("internal ops", () =>
{
	const DATE_JOINED_SEC = 1_500_000_000;
	const NOW_MS = 1_800_000_000_500;
	const CLIENT_TS = 300_000_000;
	const CLOCK =
	{
		now: NOW_MS,
		dateJoinedSec: DATE_JOINED_SEC,
	};

	describe("buildMetadataPatches", () =>
	{
		it("adds the full nested object at the first missing level", () =>
		{
			expect(buildMetadataPatches({}, ["starring", "locations", "abc"], "None")).toStrictEqual(
				{
					patches: [
						{
							op: "add",
							path: ["starring"],
							value:
							{
								locations:
								{
									abc: "None",
								},
							},
						},
					],
					inverse: [
						{
							op: "remove",
							path: ["starring"],
						},
					],
				},
			);
		});

		it("adds a leaf under an existing parent", () =>
		{
			expect(
				buildMetadataPatches(
					{
						starring:
						{
							locations: {},
						},
					},
					["starring", "locations", "abc"],
					"None",
				),
			).toStrictEqual(
				{
					patches: [
						{
							op: "add",
							path: ["starring", "locations", "abc"],
							value: "None",
						},
					],
					inverse: [
						{
							op: "remove",
							path: ["starring", "locations", "abc"],
						},
					],
				},
			);
		});

		it("replaces an existing value with a replace inverse of the old value", () =>
		{
			expect(
				buildMetadataPatches(
					{
						color:
						{
							tags:
							{
								alice: 1,
							},
						},
					},
					["color", "tags", "alice"],
					3,
				),
			).toStrictEqual(
				{
					patches: [
						{
							op: "replace",
							path: ["color", "tags", "alice"],
							value: 3,
						},
					],
					inverse: [
						{
							op: "replace",
							path: ["color", "tags", "alice"],
							value: 1,
						},
					],
				},
			);
		});

		it("replaces a non-object intermediate with the nested object", () =>
		{
			expect(
				buildMetadataPatches(
					{
						priority: true,
					},
					["priority", "defaultToBottom"],
					true,
				),
			).toStrictEqual(
				{
					patches: [
						{
							op: "replace",
							path: ["priority"],
							value:
							{
								defaultToBottom: true,
							},
						},
					],
					inverse: [
						{
							op: "replace",
							path: ["priority"],
							value: true,
						},
					],
				},
			);
		});

		it("removes an existing value with an add inverse of the old value", () =>
		{
			expect(
				buildMetadataPatches(
					{
						layoutMode: "board",
					},
					["layoutMode"],
					undefined,
				),
			).toStrictEqual(
				{
					patches: [
						{
							op: "remove",
							path: ["layoutMode"],
						},
					],
					inverse: [
						{
							op: "add",
							path: ["layoutMode"],
							value: "board",
						},
					],
				},
			);
		});

		it("emits nothing when removing a missing value or setting an identical one", () =>
		{
			expect(buildMetadataPatches({}, ["color", "tags", "alice"], undefined)).toStrictEqual(
				{
					patches: [],
					inverse: [],
				},
			);
			expect(
				buildMetadataPatches(
					{
						layoutMode: "board",
					},
					["layoutMode"],
					"board",
				),
			).toStrictEqual(
				{
					patches: [],
					inverse: [],
				},
			);
		});

		it("rejects array values", () =>
		{
			expect(() => buildMetadataPatches({}, ["starring", "order"], ["a", "b"])).toThrow(
				new TypeError("array metadata is not supported"),
			);
		});

		it("rejects an empty path", () =>
		{
			expect(() => buildMetadataPatches({}, [], 1)).toThrow(new TypeError("metadata path must not be empty"));
		});
	});

	describe("applyMetadataPatches", () =>
	{
		it("applies patches without mutating the input", () =>
		{
			const metadata =
			{
				color:
				{
					tags:
					{
						alice: 1,
					},
				},
				layoutMode: "board",
			};
			const result = applyMetadataPatches(metadata, [
				{
					op: "replace",
					path: ["color", "tags", "alice"],
					value: 3,
				},
				{
					op: "add",
					path: ["starring"],
					value:
					{
						locations:
						{
							abc: "None",
						},
					},
				},
				{
					op: "remove",
					path: ["layoutMode"],
				},
			]);
			expect(result).toStrictEqual(
				{
					color:
					{
						tags:
						{
							alice: 3,
						},
					},
					starring:
					{
						locations:
						{
							abc: "None",
						},
					},
				},
			);
			expect(metadata).toStrictEqual(
				{
					color:
					{
						tags:
						{
							alice: 1,
						},
					},
					layoutMode: "board",
				},
			);
		});

		it("round-trips patches and their inverse", () =>
		{
			const metadata =
			{
				starring:
				{
					locations: {},
				},
			};
			const {patches, inverse} = buildMetadataPatches(metadata, ["starring", "locations", "abc"], "None");
			const patched = applyMetadataPatches(metadata, patches);
			expect(patched).toStrictEqual(
				{
					starring:
					{
						locations:
						{
							abc: "None",
						},
					},
				},
			);
			expect(applyMetadataPatches(patched, inverse)).toStrictEqual(metadata);
		});
	});

	describe("clientTimestamp", () =>
	{
		it("is whole seconds since the account join date", () =>
		{
			expect(clientTimestamp(CLOCK)).toBe(CLIENT_TS);
		});
	});

	describe("editOp", () =>
	{
		it("builds a rename with metadata patches and undo data", () =>
		{
			const {patches, inverse} = buildMetadataPatches({}, ["layoutMode"], "board");
			expect(
				editOp(
					{
						id: "c",
						name: "New",
						note: "Note",
						metadataPatches: patches,
						metadataInversePatches: inverse,
						previous:
						{
							name: "Old",
							note: "",
							lastModified: 299_000_000,
							lastModifiedBy: null,
						},
						...CLOCK,
					},
				),
			).toStrictEqual(
				{
					type: "edit",
					data:
					{
						projectid: "c",
						name: "New",
						description: "Note",
						metadataPatches: [
							{
								op: "add",
								path: ["layoutMode"],
								value: "board",
							},
						],
						metadataInversePatches: [
							{
								op: "remove",
								path: ["layoutMode"],
							},
						],
					},
					client_timestamp: CLIENT_TS,
					undo_data:
					{
						previous_last_modified: 299_000_000,
						previous_last_modified_by: null,
						previous_name: "Old",
						previous_description: "",
						metadataPatches: [
							{
								op: "remove",
								path: ["layoutMode"],
							},
						],
					},
				},
			);
		});

		it("builds a metadata-only edit on Home", () =>
		{
			const {patches, inverse} = buildMetadataPatches({}, ["color", "tags", "alice"], 3);
			expect(
				editOp(
					{
						id: ROOT_PROJECT_ID,
						metadataPatches: patches,
						metadataInversePatches: inverse,
						...CLOCK,
					},
				),
			).toStrictEqual(
				{
					type: "edit",
					data:
					{
						projectid: "None",
						metadataPatches: [
							{
								op: "add",
								path: ["color"],
								value:
								{
									tags:
									{
										alice: 3,
									},
								},
							},
						],
						metadataInversePatches: [
							{
								op: "remove",
								path: ["color"],
							},
						],
					},
					client_timestamp: CLIENT_TS,
					undo_data:
					{
						previous_last_modified: null,
						previous_last_modified_by: null,
						metadataPatches: [
							{
								op: "remove",
								path: ["color"],
							},
						],
					},
				},
			);
		});
	});

	describe("bulkCreateOp", () =>
	{
		it("puts client-generated ids into project_trees and returns them", () =>
		{
			const generated = ["id-1", "id-2"];
			const {op, ids} = bulkCreateOp(
				{
					parentId: "p",
					index: 2,
					trees: [
						{
							name: "First",
							note: "n",
							metadata:
							{
								layoutMode: "board",
							},
							children: [
								{
									name: "Child",
								},
							],
						},
					],
					userId: 42,
					generateId: () => generated.shift() ?? "unexpected",
					...CLOCK,
				},
			);
			expect(ids).toStrictEqual(["id-1"]);
			expect(op).toStrictEqual(
				{
					type: "bulk_create",
					data:
					{
						parentid: "p",
						starting_priority: 2,
						project_trees: JSON.stringify([
							{
								id: "id-1",
								nm: "First",
								no: "n",
								metadata:
								{
									layoutMode: "board",
								},
								ct: CLIENT_TS,
								cb: 42,
								ch: [
									{
										id: "id-2",
										nm: "Child",
										ct: CLIENT_TS,
										cb: 42,
										ch: [],
									},
								],
							},
						]),
						isForSearch: false,
					},
					client_timestamp: CLIENT_TS,
					undo_data: {},
				},
			);
		});

		it("emits cp for completed trees at every depth", () =>
		{
			const generated = ["id-1", "id-2"];
			const {op} = bulkCreateOp(
				{
					parentId: "p",
					index: 0,
					trees: [
						{
							name: "a",
							completed: true,
							children: [
								{
									name: "b",
									metadata:
									{
										layoutMode: "h1",
									},
								},
							],
						},
					],
					userId: 42,
					generateId: () => generated.shift() ?? "unexpected",
					...CLOCK,
				},
			);
			expect(op.data.project_trees).toBe(
				JSON.stringify([
					{
						id: "id-1",
						nm: "a",
						ct: CLIENT_TS,
						cb: 42,
						cp: CLIENT_TS,
						ch: [
							{
								id: "id-2",
								nm: "b",
								metadata:
								{
									layoutMode: "h1",
								},
								ct: CLIENT_TS,
								cb: 42,
								ch: [],
							},
						],
					},
				]),
			);
		});

		it("keeps caller-supplied ids", () =>
		{
			const {op, ids} = bulkCreateOp(
				{
					parentId: "p",
					index: 0,
					trees: [
						{
							id: "fixed",
							name: "Day",
						},
					],
					userId: 42,
					generateId: () => "unexpected",
					...CLOCK,
				},
			);
			expect(ids).toStrictEqual(["fixed"]);
			expect(op.data.project_trees).toBe(
				JSON.stringify([
					{
						id: "fixed",
						nm: "Day",
						ct: CLIENT_TS,
						cb: 42,
						ch: [],
					},
				]),
			);
		});
	});

	describe("moveOp", () =>
	{
		it("builds the full envelope for a same-parent move up", () =>
		{
			expect(
				moveOp(
					{
						id: "c",
						parentId: "p",
						index: 0,
						from:
						{
							parentId: "p",
							index: 2,
						},
						...CLOCK,
					},
				),
			).toStrictEqual(
				{
					type: "move",
					data:
					{
						projectid: "c",
						parentid: "p",
						priority: 0,
					},
					client_timestamp: CLIENT_TS,
					undo_data:
					{
						previous_parentid: "p",
						previous_priority: 2,
						previous_last_modified: null,
						previous_last_modified_by: null,
					},
				},
			);
		});

		it("uses the index after removal for a same-parent move down", () =>
		{
			expect(
				moveOp(
					{
						id: "c",
						parentId: "p",
						index: 3,
						from:
						{
							parentId: "p",
							index: 0,
						},
						...CLOCK,
					},
				).data,
			).toStrictEqual(
				{
					projectid: "c",
					parentid: "p",
					priority: 2,
				},
			);
		});

		it("keeps the slot index when moving to another parent", () =>
		{
			expect(
				moveOp(
					{
						id: "c",
						parentId: "q",
						index: 3,
						from:
						{
							parentId: "p",
							index: 0,
						},
						previous:
						{
							lastModified: 10,
							lastModifiedBy: 7,
						},
						...CLOCK,
					},
				),
			).toStrictEqual(
				{
					type: "move",
					data:
					{
						projectid: "c",
						parentid: "q",
						priority: 3,
					},
					client_timestamp: CLIENT_TS,
					undo_data:
					{
						previous_parentid: "p",
						previous_priority: 0,
						previous_last_modified: 10,
						previous_last_modified_by: 7,
					},
				},
			);
		});
	});

	describe("bulkMoveOp", () =>
	{
		it("uses the count of non-moved siblings before the block as priority", () =>
		{
			expect(
				bulkMoveOp(
					{
						items: [
							{
								id: "a",
								from:
								{
									parentId: "p",
									index: 0,
								},
							},
							{
								id: "c",
								from:
								{
									parentId: "p",
									index: 2,
								},
							},
						],
						parentId: "p",
						siblings: ["a", "b", "c", "d", "e"],
						index: 4,
						...CLOCK,
					},
				),
			).toStrictEqual(
				{
					type: "bulk_move",
					data:
					{
						projectids_json: JSON.stringify(["a", "c"]),
						parentid: "p",
						priority: 2,
					},
					client_timestamp: CLIENT_TS,
					undo_data:
					{
						move_undo_datas: [
							{
								previous_parentid: "p",
								previous_priority: 0,
								previous_last_modified: null,
								previous_last_modified_by: null,
								priority_used_for_move: 2,
							},
							{
								previous_parentid: "p",
								previous_priority: 2,
								previous_last_modified: null,
								previous_last_modified_by: null,
								priority_used_for_move: 3,
							},
						],
					},
				},
			);
		});
	});

	describe("delete, undelete, complete, uncomplete", () =>
	{
		it("builds delete with its location in undo data", () =>
		{
			expect(
				deleteOp(
					{
						id: "c",
						from:
						{
							parentId: "p",
							index: 1,
						},
						...CLOCK,
					},
				),
			).toStrictEqual(
				{
					type: "delete",
					data:
					{
						projectid: "c",
					},
					client_timestamp: CLIENT_TS,
					undo_data:
					{
						previous_last_modified: null,
						previous_last_modified_by: null,
						parentid: "p",
						priority: 1,
					},
				},
			);
		});

		it("builds undelete at an explicit location", () =>
		{
			expect(
				undeleteOp(
					{
						id: "c",
						parentId: "p",
						index: 1,
						...CLOCK,
					},
				),
			).toStrictEqual(
				{
					type: "undelete",
					data:
					{
						projectid: "c",
						parentid: "p",
						priority: 1,
					},
					client_timestamp: CLIENT_TS,
					undo_data:
					{
						previous_last_modified: null,
						previous_last_modified_by: null,
					},
				},
			);
		});

		it("builds complete and uncomplete with the previous completion state", () =>
		{
			expect(
				completeOp(
					{
						id: "c",
						previousCompleted: false,
						...CLOCK,
					},
				),
			).toStrictEqual(
				{
					type: "complete",
					data:
					{
						projectid: "c",
					},
					client_timestamp: CLIENT_TS,
					undo_data:
					{
						previous_last_modified: null,
						previous_last_modified_by: null,
						previous_completed: false,
					},
				},
			);
			expect(
				uncompleteOp(
					{
						id: "c",
						previousCompleted: 299_000_000,
						...CLOCK,
					},
				),
			).toStrictEqual(
				{
					type: "uncomplete",
					data:
					{
						projectid: "c",
					},
					client_timestamp: CLIENT_TS,
					undo_data:
					{
						previous_last_modified: null,
						previous_last_modified_by: null,
						previous_completed: 299_000_000,
					},
				},
			);
		});
	});
});
