import {beforeEach, describe, expect, it, vi} from "vite-plus/test";
import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {Hono} from "hono";
import {join} from "node:path";
import type * as SharedCache from "@outlinedb/shared/cache";
import * as schema from "@outlinedb/shared/db";
import type {WorkflowyInternalAdapter} from "@outlinedb/shared/internal";
import type {WorkflowyNode} from "@outlinedb/shared/types";
import type {AppEnv, ServerContext} from "../src/server/context.js";
import {httpAppFor} from "./http-app-for.js";

const updateNode = vi.hoisted(() => vi.fn<SharedCache.WorkflowyWriteThroughClient["updateNode"]>());
const deleteNode = vi.hoisted(() => vi.fn<SharedCache.WorkflowyWriteThroughClient["deleteNode"]>());

vi.mock("@outlinedb/shared/cache", async (importOriginal) => {
	const actual = await importOriginal<typeof SharedCache>();
	return {
		...actual,
		WorkflowyWriteThroughClient: class {
			updateNode = updateNode;
			deleteNode = deleteNode;
		},
	};
});

const {CacheService, collectItemRelationships, emptyItemRelationships, storeInternalMetadata} =
	await import("@outlinedb/shared/cache");

const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");
const NOT_CONFIGURED =
	"Workflowy internal API is not configured (set WORKFLOWY_USERNAME and WORKFLOWY_PASSWORD, or run './bin/run.js internal login')";

function apiNode(id: string, layoutMode?: string): WorkflowyNode {
	return {
		id,
		name: id.toUpperCase(),
		note: null,
		parent_id: null,
		priority: 0,
		createdAt: 100,
		modifiedAt: 200,
		...(layoutMode === undefined ? {} : {data: {layoutMode}}),
	};
}

function dto(
	id: string,
	layoutMode: string | null,
	numberedStart: number | null,
	defaultToBottom = false,
	table: unknown = null,
) {
	return {
		id,
		parent_id: null,
		name: id.toUpperCase(),
		note: null,
		priority: 0,
		data: {layoutMode},
		numberedStart,
		createdAt: 100,
		modifiedAt: 200,
		completedAt: null,
		hasChildren: false,
		hasUncompletedChildren: false,
		hasMirrors: false,
		isMirror: false,
		originalNodeId: null,
		attachment: null,
		defaultToBottom,
		calendar: null,
		table,
	};
}

interface FakeAdapter {
	setNodeMetaValues: ReturnType<typeof vi.fn<WorkflowyInternalAdapter["setNodeMetaValues"]>>;
	syncBacklinks: ReturnType<typeof vi.fn<WorkflowyInternalAdapter["syncBacklinks"]>>;
	deleteBacklinksOf: ReturnType<typeof vi.fn<WorkflowyInternalAdapter["deleteBacklinksOf"]>>;
	getRootMeta: ReturnType<typeof vi.fn<WorkflowyInternalAdapter["getRootMeta"]>>;
}

/** Home holds `n1`; the fake adapter writes metadata changes to the cache as the real one does. */
function setup(configured: boolean, rootLayoutMode?: string) {
	const sqlite = new DatabaseConstructor(":memory:");
	const db = drizzle(sqlite, {schema});
	migrate(db, {migrationsFolder});
	const cacheService = new CacheService(db);
	cacheService.insertNode(apiNode("n1"), null);
	const writeMetadata = (id: string, metadata: Record<string, unknown>) => {
		const layoutMode = cacheService.getNode(id)?.layoutMode;
		storeInternalMetadata(db, new Map([[id, layoutMode == null ? metadata : {...metadata, layoutMode}]]));
	};
	const adapter: FakeAdapter = {
		setNodeMetaValues: vi.fn<WorkflowyInternalAdapter["setNodeMetaValues"]>(async (id, changes) => {
			if (id !== "home") {
				const metadata: Record<string, unknown> = {};
				for (const {path, value} of changes) {
					if (path[0] === "layoutMode") {
						cacheService.insertNode(apiNode(id, typeof value === "string" ? value : undefined), null);
					} else if (value !== undefined) {
						metadata[path[0]] = value;
					}
				}
				writeMetadata(id, metadata);
			}
			return Promise.resolve();
		}),
		getRootMeta: vi.fn<WorkflowyInternalAdapter["getRootMeta"]>(async () => Promise.resolve(rootLayoutMode)),
		syncBacklinks: vi.fn<WorkflowyInternalAdapter["syncBacklinks"]>(async () =>
			Promise.resolve({created: [], referencesRoots: [], deleted: []}),
		),
		deleteBacklinksOf: vi.fn<WorkflowyInternalAdapter["deleteBacklinksOf"]>(async () => Promise.resolve([])),
	};
	const ctx = {
		db,
		cacheService,
		apiKey: "test-key",
		config: {} as ServerContext["config"],
		internalAuth: configured ? {} : undefined,
		internalAdapter: () => (configured ? (adapter as unknown as WorkflowyInternalAdapter) : undefined),
	} as unknown as ServerContext;
	const app = new Hono<AppEnv>();
	app.use("*", async (c, next) => {
		c.set("ctx", ctx);
		await next();
	});
	app.route("/", httpAppFor(ctx));
	const request = async (method: string, path: string, body?: unknown) => {
		const res = await app.fetch(
			new Request(`http://x/api/v1${path}`, {
				method,
				headers: {"content-type": "application/json"},
				...(body === undefined ? {} : {body: JSON.stringify(body)}),
			}),
		);
		return {status: res.status, body: res.status === 204 ? null : await res.json()};
	};
	return {adapter, request, writeMetadata, cacheService};
}

beforeEach(() => {
	updateNode.mockReset();
	deleteNode.mockReset();
});

describe("DELETE /api/v1/nodes/:id backlinks", () => {
	const LINK = '<a href="https://workflowy.com/#/0123456789ab">t</a>';

	it("deletes the backlink items of the linked sources in the subtree after the node is deleted", async () => {
		const {adapter, request, cacheService} = setup(true);
		cacheService.insertNode({...apiNode("n1"), name: LINK}, null);
		cacheService.insertNode({...apiNode("c1"), parent_id: "n1", name: "plain"}, "n1");
		cacheService.insertNode({...apiNode("c2"), parent_id: "n1", note: LINK}, "n1");
		const order: string[] = [];
		deleteNode.mockImplementation(async () => {
			order.push("delete");
			return Promise.resolve({mirrorIds: [], promotions: [], nodeId: "n1"});
		});
		adapter.deleteBacklinksOf.mockImplementation(async () => {
			order.push("backlinks");
			return Promise.resolve([]);
		});

		const {status} = await request("DELETE", "/nodes/n1");

		expect({status, order, calls: adapter.deleteBacklinksOf.mock.calls}).toStrictEqual({
			status: 204,
			order: ["delete", "backlinks"],
			calls: [[{ids: ["n1", "c2"], mirrors: []}]],
		});
	});

	it("deletes the backlink items of a source in the subtree whose text no longer links, so none are stranded", async () => {
		const {adapter, request, cacheService} = setup(true);
		cacheService.insertNode({...apiNode("n1"), name: "link removed"}, null);
		cacheService.insertNode(apiNode("target"), null);
		cacheService.insertNode({...apiNode("refs"), parent_id: "target", name: ""}, "target");
		cacheService.insertNode({...apiNode("item"), parent_id: "refs", name: ""}, "refs");
		const relationships = emptyItemRelationships();
		collectItemRelationships(relationships, "refs", {isReferencesRoot: true});
		collectItemRelationships(relationships, "item", {
			mirror: {originalId: "n1", isMirrorRoot: true},
			backlink: {sourceID: "n1", targetID: "target"},
		});
		cacheService.recordRelationships(relationships);
		deleteNode.mockResolvedValue({mirrorIds: [], promotions: [], nodeId: "n1"});

		const {status} = await request("DELETE", "/nodes/n1");

		expect({status, calls: adapter.deleteBacklinksOf.mock.calls}).toStrictEqual({
			status: 204,
			calls: [[{ids: ["n1"], mirrors: [{originalId: "n1", mirrorId: "item"}]}]],
		});
	});

	it("leaves backlinks alone when nothing in the subtree links anywhere", async () => {
		const {adapter, request} = setup(true);
		deleteNode.mockResolvedValue({mirrorIds: [], promotions: [], nodeId: "n1"});

		const {status} = await request("DELETE", "/nodes/n1");

		expect({status, calls: adapter.deleteBacklinksOf.mock.calls}).toStrictEqual({status: 204, calls: []});
	});
});

describe("PATCH /api/v1/nodes/home", () => {
	it("sets Home's layout to board through the root metadata", async () => {
		const {adapter, request} = setup(true);

		const res = await request("PATCH", "/nodes/home", {layoutMode: "board"});

		expect({res, calls: adapter.setNodeMetaValues.mock.calls}).toStrictEqual({
			res: {status: 200, body: {layoutMode: "board"}},
			calls: [["home", [{path: ["layoutMode"], value: "board"}]]],
		});
	});

	it("removes the layoutMode key for bullets", async () => {
		const {adapter, request} = setup(true);

		const res = await request("PATCH", "/nodes/home", {layoutMode: "bullets"});

		expect({res, calls: adapter.setNodeMetaValues.mock.calls}).toStrictEqual({
			res: {status: 200, body: {layoutMode: "bullets"}},
			calls: [["home", [{path: ["layoutMode"], value: undefined}]]],
		});
	});

	it.each([
		[{layoutMode: "table"}, "Home accepts only layoutMode"],
		[{layoutMode: "board", numberedStart: 2}, "Home accepts only layoutMode"],
		[{name: "x"}, "Home accepts only layoutMode"],
		[{}, "Home accepts only layoutMode"],
	])("rejects %j", async (body, error) => {
		const {adapter, request} = setup(true);

		const res = await request("PATCH", "/nodes/home", body);

		expect({res, calls: adapter.setNodeMetaValues.mock.calls}).toStrictEqual({
			res: {status: 400, body: {error}},
			calls: [],
		});
	});

	it("answers 503 without the internal API", async () => {
		const {request} = setup(false);

		await expect(request("PATCH", "/nodes/home", {layoutMode: "board"})).resolves.toStrictEqual({
			status: 503,
			body: {error: NOT_CONFIGURED},
		});
	});
});

describe("GET /api/v1/home", () => {
	it("returns Home's layoutMode", async () => {
		const {request} = setup(true, "board");

		await expect(request("GET", "/home")).resolves.toStrictEqual({status: 200, body: {layoutMode: "board"}});
	});

	it("defaults to bullets when the root has no layoutMode", async () => {
		const {request} = setup(true);

		await expect(request("GET", "/home")).resolves.toStrictEqual({status: 200, body: {layoutMode: "bullets"}});
	});

	it("answers 503 without the internal API", async () => {
		const {request} = setup(false);

		await expect(request("GET", "/home")).resolves.toStrictEqual({status: 503, body: {error: NOT_CONFIGURED}});
	});
});

describe("PATCH /api/v1/nodes/:id metadata", () => {
	it("sets layoutMode and numberedStart with one adapter call", async () => {
		const {adapter, request} = setup(true);

		const res = await request("PATCH", "/nodes/n1", {layoutMode: "numbered", numberedStart: 5});

		expect({res, calls: adapter.setNodeMetaValues.mock.calls, updates: updateNode.mock.calls}).toStrictEqual({
			res: {status: 200, body: {node: dto("n1", "numbered", 5), effects: {backlinkTargets: [], dates: false}}},
			calls: [
				[
					"n1",
					[
						{path: ["layoutMode"], value: "numbered"},
						{path: ["numbered_start"], value: 5},
					],
				],
			],
			updates: [],
		});
	});

	it("removes numbered_start for a null numberedStart and the layoutMode key for bullets", async () => {
		const {adapter, request} = setup(true);

		await request("PATCH", "/nodes/n1", {layoutMode: "bullets", numberedStart: null});

		expect(adapter.setNodeMetaValues.mock.calls).toStrictEqual([
			[
				"n1",
				[
					{path: ["layoutMode"], value: undefined},
					{path: ["numbered_start"], value: undefined},
				],
			],
		]);
	});

	it("writes the name through the public API and the metadata through the adapter", async () => {
		const {adapter, request} = setup(true);
		updateNode.mockResolvedValue(apiNode("n1"));

		await request("POST", "/nodes/n1", {name: "Buy milk", numberedStart: 3});

		expect({calls: adapter.setNodeMetaValues.mock.calls, updates: updateNode.mock.calls}).toStrictEqual({
			calls: [["n1", [{path: ["numbered_start"], value: 3}]]],
			updates: [["n1", {name: "Buy milk"}]],
		});
	});

	it("syncs backlinks after a text edit that adds an internal link", async () => {
		const {adapter, request} = setup(true);
		updateNode.mockResolvedValue(apiNode("n1"));

		await request("PATCH", "/nodes/n1", {note: 'see <a href="https://workflowy.com/#/0123456789ab">t</a>'});

		expect(adapter.syncBacklinks.mock.calls).toStrictEqual([[["n1"]]]);
	});

	it("syncs backlinks after a text edit that removes the last internal link", async () => {
		const {adapter, request, cacheService} = setup(true);
		cacheService.insertNode({...apiNode("n1"), name: '<a href="https://workflowy.com/#/0123456789ab">t</a>'}, null);
		updateNode.mockResolvedValue(apiNode("n1"));

		await request("PATCH", "/nodes/n1", {name: "plain"});

		expect(adapter.syncBacklinks.mock.calls).toStrictEqual([[["n1"]]]);
	});

	it("reports the target of a backlink recreated by an edit that leaves the link set unchanged", async () => {
		const TARGET = "aaaaaaaa-aaaa-4aaa-8aaa-0123456789ab";
		const link = '<a href="https://workflowy.com/#/0123456789ab">t</a>';
		const {adapter, request, cacheService} = setup(true);
		cacheService.insertNode({...apiNode(TARGET), name: "target"}, null);
		cacheService.insertNode({...apiNode("n1"), name: link}, null);
		updateNode.mockResolvedValue(apiNode("n1"));
		adapter.syncBacklinks.mockResolvedValue({
			created: [{id: "b", sourceId: "n1", targetId: TARGET}],
			referencesRoots: [],
			deleted: [],
		});

		const {body} = await request("PATCH", "/nodes/n1", {name: `${link} more`});

		expect((body as {effects: unknown}).effects).toStrictEqual({backlinkTargets: [TARGET], dates: false});
	});

	it("does not sync backlinks for a keystroke in a row whose link target is unknown to the cache and unchanged", async () => {
		const link = '<a href="https://workflowy.com/#/0123456789ab">t</a>';
		const {adapter, request, cacheService} = setup(true);
		cacheService.insertNode({...apiNode("n1"), name: link}, null);
		updateNode.mockResolvedValue(apiNode("n1"));

		await request("PATCH", "/nodes/n1", {name: `${link} more`});

		expect(adapter.syncBacklinks.mock.calls).toStrictEqual([]);
	});

	it("leaves backlinks alone when neither the old nor the new text links anywhere", async () => {
		const {adapter, request} = setup(true);
		updateNode.mockResolvedValue(apiNode("n1"));

		await request("PATCH", "/nodes/n1", {name: "plain"});

		expect(adapter.syncBacklinks.mock.calls).toStrictEqual([]);
	});

	it("reports no effects for a plain text edit", async () => {
		const {request} = setup(true);
		updateNode.mockResolvedValue(apiNode("n1"));

		const {body} = await request("PATCH", "/nodes/n1", {name: "plain"});

		expect(body).toStrictEqual({node: dto("n1", null, null), effects: {backlinkTargets: [], dates: false}});
	});

	it("reports the targets of the links an edit adds or removes, but not those it keeps", async () => {
		const {request, cacheService} = setup(true);
		const kept = "11111111-2222-3333-4444-0123456789ab";
		const removed = "11111111-2222-3333-4444-aaaaaaaaaaaa";
		const added = "11111111-2222-3333-4444-bbbbbbbbbbbb";
		for (const id of [kept, removed, added]) {
			cacheService.insertNode(apiNode(id), null);
		}
		const link = (id: string) => `<a href="https://workflowy.com/#/${id.slice(-12)}">t</a>`;
		cacheService.insertNode({...apiNode("n1"), name: `${link(kept)} ${link(removed)}`}, null);
		updateNode.mockResolvedValue(apiNode("n1"));

		const {body} = await request("PATCH", "/nodes/n1", {name: `${link(kept)} ${link(added)}`});

		expect((body as {effects: unknown}).effects).toStrictEqual({backlinkTargets: [removed, added], dates: false});
	});

	it("reports a date change when an edit adds a <time>", async () => {
		const {request} = setup(true);
		updateNode.mockResolvedValue(apiNode("n1"));

		const {body} = await request("PATCH", "/nodes/n1", {
			note: 'on <time startYear="2026" startMonth="10" startDay="22">Oct 22</time>',
		});

		expect((body as {effects: unknown}).effects).toStrictEqual({backlinkTargets: [], dates: true});
	});

	it("rejects a numberedStart that is not an integer or null", async () => {
		const {adapter, request} = setup(true);

		const res = await request("PATCH", "/nodes/n1", {numberedStart: "5"});

		expect({res, calls: adapter.setNodeMetaValues.mock.calls}).toStrictEqual({
			res: {status: 400, body: {error: "Invalid request body"}},
			calls: [],
		});
	});

	it("answers 503 for numberedStart without the internal API", async () => {
		const {request} = setup(false);

		await expect(request("PATCH", "/nodes/n1", {numberedStart: 5})).resolves.toStrictEqual({
			status: 503,
			body: {error: NOT_CONFIGURED},
		});
	});

	it("falls back to the public API for layoutMode without the internal API", async () => {
		const {request} = setup(false);
		updateNode.mockResolvedValue(apiNode("n1", "board"));

		await request("PATCH", "/nodes/n1", {layoutMode: "board"});

		expect(updateNode.mock.calls).toStrictEqual([["n1", {layoutMode: "board"}]]);
	});
});

describe("node DTO numberedStart", () => {
	it("comes from the cached internal metadata", async () => {
		const {request, writeMetadata} = setup(false);
		writeMetadata("n1", {numbered_start: 5});

		await expect(request("GET", "/nodes/n1")).resolves.toStrictEqual({
			status: 200,
			body: {node: dto("n1", null, 5)},
		});
	});

	it("is null without cached metadata", async () => {
		const {request} = setup(false);

		await expect(request("GET", "/nodes?parent_id=None")).resolves.toStrictEqual({
			status: 200,
			body: {nodes: [dto("n1", null, null)]},
		});
	});
});

describe("node DTO defaultToBottom", () => {
	it("comes from the cached internal metadata's priority.defaultToBottom", async () => {
		const {request, writeMetadata} = setup(false);
		writeMetadata("n1", {priority: {defaultToBottom: true}});

		await expect(request("GET", "/nodes/n1")).resolves.toStrictEqual({
			status: 200,
			body: {node: dto("n1", null, null, true)},
		});
	});

	it("is false without cached metadata", async () => {
		const {request} = setup(false);

		await expect(request("GET", "/nodes/n1")).resolves.toStrictEqual({
			status: 200,
			body: {node: dto("n1", null, null)},
		});
	});
});

describe("PATCH /api/v1/nodes/:id tableSet", () => {
	it("forwards table paths to the adapter and returns them on the node", async () => {
		const {adapter, request} = setup(true);

		const res = await request("PATCH", "/nodes/n1", {tableSet: [{path: ["table", "sizes", "c1"], value: 200}]});

		expect({status: res.status, calls: adapter.setNodeMetaValues.mock.calls}).toStrictEqual({
			status: 200,
			calls: [["n1", [{path: ["table", "sizes", "c1"], value: 200}]]],
		});
	});

	it("rejects paths outside table", async () => {
		const {adapter, request} = setup(true);

		const res = await request("PATCH", "/nodes/n1", {tableSet: [{path: ["layoutMode"], value: "x"}]});

		expect({status: res.status, calls: adapter.setNodeMetaValues.mock.calls}).toStrictEqual({
			status: 400,
			calls: [],
		});
	});

	it("answers 503 without the internal API", async () => {
		const {request} = setup(false);

		await expect(
			request("PATCH", "/nodes/n1", {tableSet: [{path: ["table", "headers"], value: true}]}),
		).resolves.toStrictEqual({status: 503, body: {error: NOT_CONFIGURED}});
	});

	it("GET returns the cached table metadata", async () => {
		const {request, writeMetadata} = setup(true);
		writeMetadata("n1", {table: {sizes: {c1: 200}}});

		const res = await request("GET", "/nodes/n1");

		expect(res.body).toStrictEqual({node: dto("n1", null, null, false, {sizes: {c1: 200}})});
	});
});
