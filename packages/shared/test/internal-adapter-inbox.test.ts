import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {join} from "node:path";
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import type {InternalSession, WorkflowyInternalClient} from "../src/api/workflowy-internal-client.js";
import type {WorkflowyWriteThroughClient} from "../src/cache/workflowy-write-through-client.js";
import {storeTreeTxId} from "../src/cache/tree-transaction.js";
import * as schema from "../src/db/schema.js";
import {WorkflowyInternalAdapter} from "../src/internal/adapter.js";
import {InboxMissing} from "../src/internal/errors.js";
import {PushAndPoll} from "../src/internal/push-and-poll.js";
import {FAR_FUTURE_DATE} from "../src/temporal/constants.js";

const migrationsFolder = join(import.meta.dirname, "../src/db/migrations");

const SESSION: InternalSession = {
	clientId: "client",
	clientVersion: "21",
	userId: 123,
	ownerId: 123,
	dateJoinedSec: 1_500_000_000,
	txId: "1",
	rootMetadata: {},
	settings: {},
	visibleFeatures: [],
	expandedKeys: [],
	entropyKey: "e".repeat(64),
};

interface PushedTree {
	id: string;
	nm: string;
	ch: PushedTree[];
}

/**
 * A fake adapter world: `live` is workflowy.com's tree (`home` is Home) with each node's name,
 * `cached` (default `live`) the cache's copy. Refreshing a parent copies its live children into
 * the cache. Live reads, pushes and refreshes are recorded in `calls`.
 */
function setup(options: {
	live: Record<string, {id: string; name: string}[]>;
	cached?: Record<string, {id: string; name: string}[]>;
	session?: InternalSession;
	freshSession?: InternalSession;
	standalone?: boolean;
}) {
	const sqlite = new DatabaseConstructor(":memory:");
	const db = drizzle(sqlite, {schema});
	migrate(db, {migrationsFolder});
	storeTreeTxId(db, "4567");
	const live = new Map(Object.entries(options.live).map(([parent, nodes]) => [parent, [...nodes]]));
	const cacheNode = (parent: string, node: {id: string; name: string}) => {
		db.insert(schema.nodeContent)
			.values({
				id: node.id,
				name: node.name,
				parentId: parent === "home" ? null : parent,
				systemFrom: "2026-01-01",
				systemTo: FAR_FUTURE_DATE,
			})
			.onConflictDoNothing()
			.run();
	};
	for (const [parent, nodes] of Object.entries(options.cached ?? options.live)) {
		for (const node of nodes) {
			cacheNode(parent, node);
		}
	}
	const session = options.session ?? SESSION;
	const freshSession = options.freshSession ?? session;
	let bootstraps = 0;
	const client = {
		session,
		bootstrap: async () => Promise.resolve(++bootstraps === 1 ? session : freshSession),
	} as unknown as WorkflowyInternalClient;
	const calls: unknown[] = [];
	const parentOf = (id: string) => [...live].find(([, nodes]) => nodes.some((node) => node.id === id))?.[0];
	const writeThrough = {
		liveChildren: async (parent: string | null) => {
			calls.push(["live", parent]);
			return Promise.resolve(live.get(parent ?? "home") ?? []);
		},
		findLiveNode: async (id: string) => {
			calls.push(["findLive", id]);
			const parent = parentOf(id);
			return Promise.resolve(parent === undefined ? null : {id, parent_id: parent === "home" ? null : parent});
		},
		refreshChildren: async (parentIds: (string | null)[]) => {
			calls.push(["refreshChildren", parentIds]);
			for (const parent of parentIds) {
				for (const node of live.get(parent ?? "home") ?? []) {
					cacheNode(parent ?? "home", node);
				}
			}
			return Promise.resolve();
		},
	} as unknown as WorkflowyWriteThroughClient;
	let generated = 0;
	const adapter = new WorkflowyInternalAdapter({
		client,
		db,
		writeThrough,
		...(options.standalone === undefined ? {} : {standalone: options.standalone}),
		now: () => 1_800_000_000_000,
		generateId: () => `random-${++generated}`,
	});
	vi.spyOn(PushAndPoll.prototype, "pushAndPoll").mockImplementation(async ({ops = []} = {}) => {
		for (const op of ops) {
			if (op.type === "edit") {
				const {projectid, metadataPatches} = op.data as {projectid: string; metadataPatches: unknown};
				calls.push(["edit", {id: projectid, metadataPatches}]);
				continue;
			}
			const data = op.data as {parentid: string; starting_priority: number; project_trees: string};
			const trees = (JSON.parse(data.project_trees) as PushedTree[]).map(({id, nm}) => ({id, nm}));
			calls.push([op.type, {parentId: data.parentid, index: data.starting_priority, trees}]);
			const parent = data.parentid === "None" ? "home" : data.parentid;
			const list = live.get(parent) ?? [];
			list.splice(data.starting_priority, 0, ...trees.map(({id, nm}) => ({id, name: nm})));
			live.set(parent, list);
		}
		return Promise.resolve({txId: "2", serverRun: [], remote: [], needsRefresh: false});
	});
	return {sqlite, adapter, calls, live};
}

describe("WorkflowyInternalAdapter.ensureInbox", () => {
	let open: DatabaseConstructor.Database[] = [];
	afterEach(() => {
		vi.restoreAllMocks();
		for (const sqlite of open) {
			sqlite.close();
		}
		open = [];
	});
	function tracked(options: Parameters<typeof setup>[0]) {
		const result = setup(options);
		open.push(result.sqlite);
		return result;
	}
	const withInboxId = (inboxId: string): InternalSession => ({...SESSION, rootMetadata: {inbox_id: inboxId}});

	it("returns the cached node root metadata inbox_id names without touching workflowy.com", async () => {
		const {adapter, calls} = tracked({
			live: {home: [{id: "a", name: "a"}], a: [{id: "capture", name: "📥 Capture"}]},
			session: withInboxId("capture"),
		});

		const result = await adapter.ensureInbox();

		expect({result, calls}).toStrictEqual({result: {id: "capture", created: false}, calls: []});
	});

	it("returns the cached Home child named Inbox when inbox_id is unset", async () => {
		const {adapter, calls} = tracked({
			live: {
				home: [
					{id: "a", name: "a"},
					{id: "inbox", name: "Inbox"},
				],
			},
		});

		const result = await adapter.ensureInbox();

		expect({result, calls}).toStrictEqual({result: {id: "inbox", created: false}, calls: []});
	});

	it("re-syncs inbox_id from workflowy.com and caches that live Inbox when the cache misses it while connected", async () => {
		const {adapter, calls} = tracked({
			live: {home: [{id: "a", name: "a"}], a: [{id: "live-inbox", name: "Inbox"}]},
			cached: {home: [{id: "a", name: "a"}]},
			freshSession: withInboxId("live-inbox"),
		});

		const result = await adapter.ensureInbox();

		expect({result, calls, again: await adapter.ensureInbox()}).toStrictEqual({
			result: {id: "live-inbox", created: false},
			calls: [
				["findLive", "live-inbox"],
				["refreshChildren", ["a"]],
			],
			again: {id: "live-inbox", created: false},
		});
	});

	it("re-reads Home for a node named Inbox when workflowy.com names no inbox_id while connected", async () => {
		const {adapter, calls} = tracked({
			live: {
				home: [
					{id: "a", name: "a"},
					{id: "live-inbox", name: "Inbox"},
				],
			},
			cached: {home: [{id: "a", name: "a"}]},
		});

		const result = await adapter.ensureInbox();

		expect({result, calls}).toStrictEqual({
			result: {id: "live-inbox", created: false},
			calls: [["refreshChildren", [null]]],
		});
	});

	it("fails loudly instead of creating a duplicate Inbox when workflowy.com has none while connected", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const {adapter, calls, live} = tracked({live: {home: [{id: "a", name: "a"}]}});

		await expect(adapter.ensureInbox()).rejects.toStrictEqual(new InboxMissing());
		expect({calls, home: live.get("home"), logged: error.mock.calls}).toStrictEqual({
			calls: [["refreshChildren", [null]]],
			home: [{id: "a", name: "a"}],
			logged: [[new InboxMissing()]],
		});
	});

	it("creates an Inbox at the end of Home and points inbox_id at it when none exists in standalone mode", async () => {
		const {adapter, calls, live} = tracked({live: {home: [{id: "a", name: "a"}]}, standalone: true});

		const result = await adapter.ensureInbox();

		expect({
			result,
			calls,
			home: live.get("home"),
			inboxId: await adapter.getRootMeta(["inbox_id"]),
			again: await adapter.ensureInbox(),
		}).toStrictEqual({
			result: {id: "random-1", created: true},
			calls: [
				["live", null],
				["bulk_create", {parentId: "None", index: 1, trees: [{id: "random-1", nm: "Inbox"}]}],
				["refreshChildren", [null]],
				["edit", {id: "None", metadataPatches: [{op: "add", path: ["inbox_id"], value: "random-1"}]}],
			],
			home: [
				{id: "a", name: "a"},
				{id: "random-1", name: "Inbox"},
			],
			inboxId: "random-1",
			again: {id: "random-1", created: false},
		});
	});
});

describe("WorkflowyInternalAdapter.addToInbox", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("creates the item at the top of the Inbox", async () => {
		const {sqlite, adapter, calls, live} = setup({
			live: {home: [{id: "inbox", name: "Inbox"}], inbox: [{id: "older", name: "older"}]},
		});

		const result = await adapter.addToInbox({name: "Shared page https://example.com"});

		expect({result, calls, inbox: live.get("inbox")}).toStrictEqual({
			result: {inboxId: "inbox", id: "random-1"},
			calls: [
				["live", "inbox"],
				[
					"bulk_create",
					{parentId: "inbox", index: 0, trees: [{id: "random-1", nm: "Shared page https://example.com"}]},
				],
				["refreshChildren", ["inbox"]],
			],
			inbox: [
				{id: "random-1", name: "Shared page https://example.com"},
				{id: "older", name: "older"},
			],
		});
		sqlite.close();
	});
});
