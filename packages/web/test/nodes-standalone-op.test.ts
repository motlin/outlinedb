import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {join} from "node:path";
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import * as schema from "@outlinedb/shared/db";
import type {NodeResponse} from "../src/node-types.js";
import {readNodeConfig} from "../src/server/config.js";
import {buildServerContext} from "../src/server/context.js";
import {LadderEventBus} from "../src/server/ladder-events.js";
import {inProcessStore} from "../src/server/store.js";
import type {StoreClient} from "../src/server/store.js";

const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");
const SEEDED = 1_600_000_000;
const NOW = 1_700_000_000;
const NEW_ID = "0b6f3c1e-2d4a-4b8c-9e7f-1a2b3c4d5e6f";

let sqlite: DatabaseConstructor.Database;
let store: StoreClient;

/** A seeded or written node as the REST API answers it: uncompleted, childless, at Home unless overridden. */
function dto(id: string, overrides: Partial<NodeResponse> = {}): NodeResponse {
	return {
		id,
		parent_id: null,
		name: id,
		note: null,
		priority: 0,
		data: {layoutMode: null},
		numberedStart: null,
		createdAt: SEEDED,
		modifiedAt: SEEDED,
		completedAt: null,
		hasChildren: false,
		hasUncompletedChildren: false,
		isMirror: false,
		hasMirrors: false,
		originalNodeId: null,
		attachment: null,
		defaultToBottom: false,
		calendar: null,
		table: null,
		...overrides,
	};
}

beforeEach(() => {
	vi.useFakeTimers({toFake: ["Date"]});
	vi.setSystemTime(SEEDED * 1000);
	sqlite = new DatabaseConstructor(":memory:");
	const db = drizzle(sqlite, {schema});
	migrate(db, {migrationsFolder});
	// No WORKFLOWY_API_KEY: a standalone Node host.
	const ctx = buildServerContext({db, config: readNodeConfig({}), ladderEvents: new LadderEventBus()});
	store = inProcessStore(ctx);
	const insert = (id: string, parentId: string | null, priority: number) => {
		ctx.cacheService.insertNode(
			{id, name: id, note: null, priority, createdAt: SEEDED, modifiedAt: SEEDED, completedAt: null},
			parentId,
		);
	};
	insert("p", null, 0);
	insert("a", "p", 0);
	insert("b", "p", 1);
	insert("q", null, 1);
	// Writes start later than the seed: a unit of work may not overwrite a version from its own millisecond.
	vi.setSystemTime(NOW * 1000);
	// No upstream exists; any request to one fails the test.
	vi.spyOn(globalThis, "fetch").mockRejectedValue(
		new Error("unexpected fetch: a standalone write called an upstream"),
	);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	sqlite.close();
});

describe("node writes in a standalone context", () => {
	it("creates a node at a slot and reads it back", async () => {
		const created = dto(NEW_ID, {parent_id: "p", name: "new", priority: 1, createdAt: NOW, modifiedAt: NOW});

		await expect(
			store.call("nodes.create", {parent_id: "p", name: "new", index: 1, id: NEW_ID}),
		).resolves.toStrictEqual({ok: true, value: {node: created}, meta: {created: true}});
		await expect(store.call("nodes.children", {parentIds: ["p"]})).resolves.toStrictEqual({
			ok: true,
			value: {children: {p: [dto("a", {parent_id: "p"}), created, dto("b", {parent_id: "p", priority: 2})]}},
		});
	});

	it("answers 404 for a create under an unknown parent", async () => {
		await expect(
			store.call("nodes.create", {parent_id: "4d7c2f10-0000-4000-8000-000000000000", name: "x"}),
		).resolves.toStrictEqual({ok: false, status: 404, body: {error: "Parent node not found"}});
	});

	it("updates a node's name and note and reads it back", async () => {
		const updated = dto("a", {parent_id: "p", name: "renamed", note: "a note", modifiedAt: NOW});

		await expect(store.call("nodes.update", {id: "a", name: "renamed", note: "a note"})).resolves.toStrictEqual({
			ok: true,
			value: {node: updated, effects: {backlinkTargets: [], dates: false}},
		});
		await expect(store.call("nodes.get", {id: "a"})).resolves.toStrictEqual({ok: true, value: {node: updated}});
	});

	it("writes numberedStart locally", async () => {
		await expect(store.call("nodes.update", {id: "a", numberedStart: 3})).resolves.toStrictEqual({
			ok: true,
			value: {
				node: dto("a", {parent_id: "p", numberedStart: 3, modifiedAt: NOW}),
				effects: {backlinkTargets: [], dates: false},
			},
		});
	});

	it("creates several trees at one slot", async () => {
		const result = await store.call("nodes.trees", {
			parent_id: "p",
			after_id: "a",
			trees: [
				{name: "t1", children: [{name: "t2"}]},
				{name: "t3", completed: true},
			],
		});
		const children = await store.call("nodes.children", {parentIds: ["p"]});

		expect(
			children.ok && result.ok
				? {
						ids: result.value.ids.length,
						names: children.value.children.p.map((node) => [node.name, node.hasChildren, node.completedAt]),
					}
				: {result, children},
		).toStrictEqual({
			ids: 2,
			names: [
				["a", false, null],
				["t1", true, null],
				["t3", false, NOW],
				["b", false, null],
			],
		});
	});

	it("restores a deleted node under its original id, and answers 409 for a live one", async () => {
		await store.call("nodes.delete", {id: "a"});
		vi.setSystemTime((NOW + 1) * 1000);

		await expect(store.call("nodes.restore", {id: "a"})).resolves.toStrictEqual({
			ok: true,
			value: {node: dto("a", {parent_id: "p"})},
		});
		await expect(store.call("nodes.restore", {id: "b"})).resolves.toStrictEqual({
			ok: false,
			status: 409,
			body: {error: "Node is not deleted"},
		});
		await expect(store.call("nodes.restore", {id: "4d7c2f10-0000-4000-8000-000000000000"})).resolves.toStrictEqual({
			ok: false,
			status: 404,
			body: {error: "Node not found"},
		});
	});

	it("deletes a node and closes the gap", async () => {
		await expect(store.call("nodes.delete", {id: "a"})).resolves.toStrictEqual({ok: true, value: null});
		await expect(store.call("nodes.get", {id: "a"})).resolves.toStrictEqual({
			ok: false,
			status: 404,
			body: {error: "Node not found"},
		});
		await expect(store.call("nodes.children", {parentIds: ["p"]})).resolves.toStrictEqual({
			ok: true,
			value: {children: {p: [dto("b", {parent_id: "p"})]}},
		});
	});

	it("completes and uncompletes a node", async () => {
		const completed = dto("a", {parent_id: "p", modifiedAt: NOW, completedAt: NOW});

		await expect(store.call("nodes.complete", {id: "a"})).resolves.toStrictEqual({
			ok: true,
			value: {node: completed},
		});
		await expect(store.call("nodes.get", {id: "a"})).resolves.toStrictEqual({ok: true, value: {node: completed}});
		vi.setSystemTime((NOW + 1) * 1000);
		await expect(store.call("nodes.uncomplete", {id: "a"})).resolves.toStrictEqual({
			ok: true,
			value: {node: dto("a", {parent_id: "p", modifiedAt: NOW + 1})},
		});
	});

	it("moves a node to another parent and answers both parents' children", async () => {
		const moved = dto("b", {parent_id: "q", modifiedAt: NOW});

		await expect(store.call("nodes.moveOne", {id: "b", parent_id: "q", index: 0})).resolves.toStrictEqual({
			ok: true,
			value: {nodes: [dto("a", {parent_id: "p"}), moved]},
		});
		await expect(store.call("nodes.get", {id: "b"})).resolves.toStrictEqual({ok: true, value: {node: moved}});
	});

	it("moves several blocks in one call", async () => {
		await expect(
			store.call("nodes.move", {
				moves: [
					{ids: ["b"], parent_id: "p", index: 0},
					{ids: ["a"], parent_id: "q"},
				],
			}),
		).resolves.toStrictEqual({
			ok: true,
			value: {nodes: [dto("b", {parent_id: "p", modifiedAt: NOW}), dto("a", {parent_id: "q", modifiedAt: NOW})]},
		});
	});
});
