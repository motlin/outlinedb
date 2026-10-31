import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {join} from "node:path";
import {afterEach, describe, expect, it} from "vite-plus/test";
import {WorkflowyInternalClient} from "../src/api/workflowy-internal-client.js";
import {storeTreeTxId} from "../src/cache/tree-transaction.js";
import {readAccountRows, readImportTime} from "../src/cache/account-store.js";
import {ACCOUNT_COMPOSITE_TABLES} from "../src/cache/node-composite.js";
import * as schema from "../src/db/schema.js";
import {WorkflowyInternalAdapter} from "../src/internal/adapter.js";
import {OperationRejected} from "../src/internal/errors.js";
import {createFakeInternalApi, FAKE_CLIENT_ID, initializationData, json} from "./helpers/fake-internal-api.js";
import type {RecordedRequest} from "./helpers/fake-internal-api.js";

const migrationsFolder = join(import.meta.dirname, "../src/db/migrations");
const START_MS = 1_800_000_000_000;

const SERVER_RUN = JSON.stringify({ops: [{type: "edit", data: {projectid: "None"}}], client_timestamp: 300_000_000});

function pushOk() {
	return json({
		results: [
			{
				new_most_recent_operation_transaction_id: "4568",
				server_run_operation_transaction_json: SERVER_RUN,
				concurrent_remote_operation_transactions: [],
			},
		],
	});
}

function setup() {
	const sqlite = new DatabaseConstructor(":memory:");
	const db = drizzle(sqlite, {schema});
	migrate(db, {migrationsFolder});
	// A whole-tree import seeded the transaction-log position at the fake init's id.
	storeTreeTxId(db, "4567");
	const api = createFakeInternalApi();
	const client = new WorkflowyInternalClient({
		credentials: {username: "alice@example.com", password: "hunter2"},
		fetch: api.fetch,
		baseUrl: "https://workflowy.test",
		transientId: "6f1c1d1e-0000-4000-8000-000000000001",
	});
	const clock = {ms: START_MS};
	const adapter = new WorkflowyInternalAdapter({
		client,
		db,
		now: () => clock.ms,
		pushAndPoll: {randomId: () => "pollid01", timezone: "America/New_York", sleep: async () => {}},
	});
	return {sqlite, db, api, adapter, clock};
}

/** Every version of every account table and of the import times: a write that changes nothing leaves this equal. */
function accountHistory(db: ReturnType<typeof setup>["db"]) {
	return [...ACCOUNT_COMPOSITE_TABLES, schema.apiImportTimestamp].map((table) => db.select().from(table).all());
}

function network(requests: RecordedRequest[]) {
	return requests.map((r) => [r.method, r.path]);
}

function pushedTrees(request: RecordedRequest | undefined): unknown {
	const fields = new URLSearchParams(request?.body ?? "");
	return JSON.parse(fields.get("push_poll_data") ?? "null");
}

describe("WorkflowyInternalAdapter account state", () => {
	let open: DatabaseConstructor.Database[] = [];
	afterEach(() => {
		for (const sqlite of open) {
			sqlite.close();
		}
		open = [];
	});
	function tracked() {
		const result = setup();
		open.push(result.sqlite);
		return result;
	}

	it("returns the account's user id and join date from the initialization data", async () => {
		const {adapter} = tracked();

		await expect(adapter.getAccount()).resolves.toStrictEqual({
			userId: 123,
			joinedAt: new Date(1_500_000_000_000),
			fullName: null,
		});
	});

	it("returns the account's full name when the server sends one", async () => {
		const {adapter, api} = tracked();
		const data = initializationData();
		data.user = {id: 123, email: "alice@example.com", fullName: "Alice Smith"};
		api.respond("/get_initialization_data", () => json(data, {headers: {wfclientid: FAKE_CLIENT_ID}}));

		await expect(adapter.getAccount()).resolves.toStrictEqual({
			userId: 123,
			joinedAt: new Date(1_500_000_000_000),
			fullName: "Alice Smith",
		});
	});

	it("sets a root metadata path with one edit on None built against the fresh metadata, then reads it from the cache", async () => {
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
						data: {
							projectid: "None",
							metadataPatches: [{op: "add", path: ["color"], value: {tags: {alice: 3}}}],
							metadataInversePatches: [{op: "remove", path: ["color"]}],
						},
						client_timestamp: 300_000_000,
						undo_data: {
							previous_last_modified: null,
							previous_last_modified_by: null,
							metadataPatches: [{op: "remove", path: ["color"]}],
						},
					},
				],
			},
		]);

		const requestsBefore = api.requests.length;
		await expect(adapter.getRootMeta(["color", "tags"])).resolves.toStrictEqual({alice: 3});
		await expect(adapter.getRootMeta(["starring", "locations"])).resolves.toStrictEqual({abc: "None"});
		expect(api.requests).toHaveLength(requestsBefore);
	});

	it("leaves the account tables unchanged when the push is rejected", async () => {
		const {api, adapter, db, clock} = tracked();
		await adapter.getRootMeta([]);
		const before = accountHistory(db);
		clock.ms += 31_000;
		api.respond("/push_and_poll", () =>
			json({results: [{new_most_recent_operation_transaction_id: "4568", error: "bad op"}]}),
		);

		await expect(adapter.setRootMeta(["color", "tags", "alice"], 3)).rejects.toBeInstanceOf(OperationRejected);

		expect(accountHistory(db)).toStrictEqual(before);
	});

	it("serves reads from the cache for 30s, then answers from the cache while one initialization GET refreshes it in the background", async () => {
		const {api, adapter, clock} = tracked();
		await expect(adapter.getSetting("theme")).resolves.toBe("dark");
		api.respond("/get_initialization_data", () =>
			json(
				{...initializationData(), settings: {theme: "light", show_completed: true}},
				{headers: {wfclientid: FAKE_CLIENT_ID}},
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

		expect({
			fresh,
			stale,
			staleAgain,
			refreshed,
			network: network(api.requests.slice(requestsBefore)),
		}).toStrictEqual({
			fresh: "dark",
			stale: "dark",
			staleAgain: "dark",
			refreshed: "light",
			network: [["GET", "/get_initialization_data"]],
		});
	});

	it("keeps a root metadata write made during a background refresh over the refresh's older snapshot", async () => {
		const {api, adapter, clock} = tracked();
		await adapter.getRootMeta([]);
		clock.ms += 31_000;
		api.respond("/push_and_poll", pushOk);
		let releaseRefresh = () => {};
		const refreshReleased = new Promise<void>((resolve) => {
			releaseRefresh = resolve;
		});
		api.respondOnce("/get_initialization_data", async () => {
			await refreshReleased;
			return json(initializationData(), {headers: {wfclientid: FAKE_CLIENT_ID}});
		});

		await adapter.getRootMeta([]);
		await adapter.setRootMeta(["color", "tags", "alice"], 3);
		releaseRefresh();
		await adapter.accountRefreshed();

		await expect(adapter.getRootMeta(["color", "tags"])).resolves.toStrictEqual({alice: 3});
	});

	it("reads the entropy key from the initialization data once, then serves it from the account row", async () => {
		const {api, adapter, db, clock} = tracked();
		api.respond("/get_initialization_data", () =>
			json(
				{...initializationData(), user: {id: 123, email: "alice@example.com", entropyKey: "k".repeat(64)}},
				{headers: {wfclientid: FAKE_CLIENT_ID}},
			),
		);

		await expect(adapter.getEntropyKey()).resolves.toBe("k".repeat(64));
		const requestsBefore = api.requests.length;
		clock.ms += 365 * 24 * 60 * 60 * 1000;
		const fresh = new WorkflowyInternalAdapter({
			client: new WorkflowyInternalClient({
				credentials: {username: "a", password: "b"},
				fetch: api.fetch,
				baseUrl: "https://workflowy.test",
			}),
			db,
			now: () => clock.ms,
		});

		await expect(fresh.getEntropyKey()).resolves.toBe("k".repeat(64));
		expect(api.requests.slice(requestsBefore)).toStrictEqual([]);
	});

	it("refreshes every account table with one initialization GET, even when the cache is fresh", async () => {
		const {api, adapter, db, clock} = tracked();
		await adapter.getSetting("theme");
		api.respond("/get_initialization_data", () =>
			json(
				{
					...initializationData(),
					settings: {theme: "light"},
					user: {id: 123, email: "alice@example.com", entropyKey: "k".repeat(64)},
				},
				{headers: {wfclientid: FAKE_CLIENT_ID}},
			),
		);
		const requestsBefore = api.requests.length;
		clock.ms += 1000;

		const counts = await adapter.refreshAccountState();

		const {account, rootPreferences, accountSettings, stars} = readAccountRows(db);
		expect({
			counts,
			account,
			rootPreferences: rootPreferences.map((row) => Object.entries(row).filter(([, value]) => value !== null)),
			theme: accountSettings.map((row) => row.theme),
			stars,
			fetchedAt: readImportTime(db, "account"),
			network: network(api.requests.slice(requestsBefore)),
		}).toStrictEqual({
			counts: {
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
					userId: 123,
					fullName: null,
					dateJoinedSec: 1_500_000_000,
					entropyKey: "k".repeat(64),
					username: null,
					email: null,
				},
			],
			rootPreferences: [[["userId", 123]]],
			theme: ["light"],
			stars: [{locationKey: "abc", treeRoot: "None"}],
			fetchedAt: START_MS + 1000,
			network: [["GET", "/get_initialization_data"]],
		});
	});

	it("keeps the account's history: an import, a local write and a re-import each add a version", async () => {
		const {api, adapter, db, clock} = tracked();
		await adapter.getSetting("theme");
		clock.ms += 1000;
		await adapter.setSetting("theme", "light");
		api.respond("/get_initialization_data", () =>
			json({...initializationData(), settings: {theme: "solarized"}}, {headers: {wfclientid: FAKE_CLIENT_ID}}),
		);
		clock.ms += 1000;
		await adapter.refreshAccountState();

		const versions = db
			.select({theme: schema.accountSettings.theme, systemTo: schema.accountSettings.systemTo})
			.from(schema.accountSettings)
			.orderBy(schema.accountSettings.systemFrom)
			.all();
		expect(versions.map((row) => [row.theme, row.systemTo === "9999-12-31 23:59:59"])).toStrictEqual([
			["dark", false],
			["light", false],
			["solarized", true],
		]);
	});

	it("answers undefined for the entropy key when the account data has none", async () => {
		const {adapter} = tracked();

		await expect(adapter.getEntropyKey()).resolves.toBeUndefined();
	});

	it("posts a setting change with yes/no flags and the client id, then caches the new value", async () => {
		const {api, adapter} = tracked();

		await adapter.setSetting("show_completed", false);

		const post = api.requests.find((r) => r.path === "/change_settings");
		expect(Object.fromEntries(new URLSearchParams(post?.body ?? ""))).toStrictEqual({
			show_completed: "no",
			clientId: FAKE_CLIENT_ID,
			crosscheck_user_id: "123",
		});
		const requestsBefore = api.requests.length;
		await expect(adapter.getSetting("show_completed")).resolves.toBe(false);
		expect(api.requests).toHaveLength(requestsBefore);
	});

	it("posts the Dropbox backup flag as yes and caches it as a boolean", async () => {
		const {api, adapter} = tracked();

		await adapter.setSetting("backup_to_dropbox", true);

		const post = api.requests.find((r) => r.path === "/change_settings");
		expect({
			body: Object.fromEntries(new URLSearchParams(post?.body ?? "")),
			cached: await adapter.getSetting("backup_to_dropbox"),
		}).toStrictEqual({
			body: {backup_to_dropbox: "yes", clientId: FAKE_CLIENT_ID, crosscheck_user_id: "123"},
			cached: true,
		});
	});

	it("posts a saved-views delta, then caches the new list as saved_views_json and saved_views rows", async () => {
		const {api, adapter, db} = tracked();
		const view = {zoomedProject: {projectid: "abc", auxiliaryRootProjectId: "None"}, searchQuery: "#todo"};
		const delta = JSON.stringify({added: [view]});

		await adapter.setSavedViews(JSON.stringify([view]), delta);

		const post = api.requests.find((r) => r.path === "/change_settings");
		expect({
			body: Object.fromEntries(new URLSearchParams(post?.body ?? "")),
			cached: await adapter.getSetting("saved_views_json"),
			delta: await adapter.getSetting("saved_views_json_delta"),
			rows: readAccountRows(db).savedViews,
		}).toStrictEqual({
			body: {saved_views_json_delta: delta, clientId: FAKE_CLIENT_ID, crosscheck_user_id: "123"},
			cached: JSON.stringify([view]),
			delta: undefined,
			rows: [{position: 0, projectId: "abc", auxiliaryRootProjectId: "None", searchQuery: "#todo"}],
		});
	});

	it("leaves the cached setting unchanged when the settings POST fails", async () => {
		const {api, adapter, db} = tracked();
		await adapter.getSetting("theme");
		const before = accountHistory(db);
		api.respond("/change_settings", () => new Response("boom", {status: 500}));

		await expect(adapter.setSetting("theme", "light")).rejects.toThrow("/change_settings returned 500");

		expect(accountHistory(db)).toStrictEqual(before);
	});
	it("serves the visible feature list from the account cache, with no network for a second adapter", async () => {
		const {api, adapter, db, clock} = tracked();
		const list = [
			{codename: "bdl", name: "Backlinks", label: null, description: "d"},
			{codename: "dashboards", name: "Dashboard layout", label: "LABS", description: "x"},
		];
		api.respond("/get_initialization_data", () =>
			json({...initializationData(), features: list}, {headers: {wfclientid: FAKE_CLIENT_ID}}),
		);

		await expect(adapter.visibleFeatures()).resolves.toStrictEqual(list);

		const requestsBefore = api.requests.length;
		const second = new WorkflowyInternalAdapter({
			client: new WorkflowyInternalClient({
				credentials: {username: "alice@example.com", password: "hunter2"},
				fetch: api.fetch,
				baseUrl: "https://workflowy.test",
			}),
			db,
			now: () => clock.ms,
		});
		await expect(second.visibleFeatures()).resolves.toStrictEqual(list);
		expect(api.requests).toHaveLength(requestsBefore);
	});

	it("reads the enabled feature dict, keeping only true or yes entries", async () => {
		const {api, adapter} = tracked();
		api.respond("/get_initialization_data", () =>
			json(
				{...initializationData(), settings: {features: {bdl: true, a: "yes", x: false, y: null, z: "no"}}},
				{headers: {wfclientid: FAKE_CLIENT_ID}},
			),
		);

		await expect(adapter.enabledFeatures()).resolves.toStrictEqual({bdl: true, a: true});
	});

	it("enables a feature: posts the codename and client id, then caches the dict in enabled_features", async () => {
		const {api, adapter, db} = tracked();
		api.respond("/get_initialization_data", () =>
			json(
				{...initializationData(), settings: {features: {dates: true}}},
				{headers: {wfclientid: FAKE_CLIENT_ID}},
			),
		);

		const next = await adapter.setFeature("dashboards", true);

		const posts = api.requests.filter((r) => r.path.startsWith("/features/"));
		expect(posts.map((r) => [r.method, r.path])).toStrictEqual([["POST", "/features/enable/dashboards"]]);
		expect(Object.fromEntries(new URLSearchParams(posts[0]?.body ?? ""))).toStrictEqual({
			clientId: FAKE_CLIENT_ID,
			crosscheck_user_id: "123",
		});
		expect(next).toStrictEqual({dates: true, dashboards: true});
		await expect(adapter.enabledFeatures()).resolves.toStrictEqual({dates: true, dashboards: true});
		expect(readAccountRows(db).enabledFeatures).toStrictEqual([
			{codename: "dates", enabled: 1},
			{codename: "dashboards", enabled: 1},
		]);
	});

	it("disables a feature by dropping its key", async () => {
		const {api, adapter, db} = tracked();
		api.respond("/get_initialization_data", () =>
			json(
				{...initializationData(), settings: {features: {dates: true, table: true}}},
				{headers: {wfclientid: FAKE_CLIENT_ID}},
			),
		);

		const next = await adapter.setFeature("dates", false);

		expect(api.requests.filter((r) => r.path.startsWith("/features/")).map((r) => r.path)).toStrictEqual([
			"/features/disable/dates",
		]);
		expect(next).toStrictEqual({table: true});
		expect(readAccountRows(db).enabledFeatures).toStrictEqual([{codename: "table", enabled: 1}]);
	});

	it("leaves the account tables unchanged when the feature POST fails", async () => {
		const {api, adapter, db} = tracked();
		await adapter.getSetting("theme");
		const before = accountHistory(db);
		api.respond("/features/enable/dashboards", () => new Response("boom", {status: 500}));

		await expect(adapter.setFeature("dashboards", true)).rejects.toThrow("returned 500");

		expect(accountHistory(db)).toStrictEqual(before);
	});

	it("rejects a codename that could escape the path and sends nothing", async () => {
		const {api, adapter} = tracked();

		await expect(adapter.setFeature("../x", true)).rejects.toThrow(TypeError);

		expect(api.requests).toStrictEqual([]);
	});

	it("keeps every written setting as a version a later server refresh supersedes but never erases", async () => {
		const {api, adapter, db, clock} = tracked();
		await adapter.setSetting("theme", "light");
		await adapter.setSetting("ignore_loom", true);
		api.respond("/get_initialization_data", () =>
			json({...initializationData(), settings: {theme: "solarized"}}, {headers: {wfclientid: FAKE_CLIENT_ID}}),
		);
		clock.ms += 31_000;
		await adapter.getSetting("theme");
		await adapter.accountRefreshed();

		expect({
			cached: await adapter.getSetting("theme"),
			versions: db
				.select({theme: schema.accountSettings.theme, ignoreLoom: schema.accountSettings.ignoreLoom})
				.from(schema.accountSettings)
				.orderBy(schema.accountSettings.systemFrom)
				.all(),
		}).toStrictEqual({
			cached: "solarized",
			versions: [
				{theme: "light", ignoreLoom: null},
				{theme: "light", ignoreLoom: 1},
				{theme: "solarized", ignoreLoom: null},
			],
		});
	});

	it("writes no account row when the settings POST fails on an empty cache", async () => {
		const {api, adapter, db} = tracked();
		api.respond("/change_settings", () => new Response("boom", {status: 500}));

		await expect(adapter.setSetting("theme", "light")).rejects.toThrow("/change_settings returned 500");

		expect(accountHistory(db).flat()).toStrictEqual([]);
	});
});
