import {describe, expect, it} from "vite-plus/test";
import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {and, eq} from "drizzle-orm";
import {Hono} from "hono";
import {join} from "node:path";
import {CacheService} from "@workflowy/shared/cache";
import * as schema from "@workflowy/shared/db";
import {mirrors, nodeContent, nodeMetadata, referencesRoots} from "@workflowy/shared/db";
import {FAR_FUTURE_DATE} from "@workflowy/shared/temporal";
import type {AppEnv, ServerContext} from "../src/server/context.js";
import {notReferencesContent} from "../src/server/backlinks.js";
import {httpAppFor} from "./http-app-for.js";

const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");
const SEEDED_AT = "2026-01-01 00:00:00.000";
const COMPLETED_AT = new Date("2026-02-01T00:00:00Z");

/*
 * folder
 *   target            (links in from src-1, src-2 and a deleted source)
 *     child-a
 *     refs            (references root)
 *       bl-1          (backlink item mirroring src-1)
 *       bl-2          (backlink item mirroring src-2)
 *       bl-gone       (backlink item whose source was deleted, ending its mirror row)
 *   lonely
 *     refs-lonely     (references root, its only child)
 * projects
 *   src-1
 *     src-1-child
 * src-2               (completed, top level)
 */
const TREE: [id: string, parentId: string | null, name: string][] = [
	["folder", null, "Folder"],
	["target", "folder", "Target"],
	["child-a", "target", "Child A"],
	["refs", "target", ""],
	["bl-1", "refs", ""],
	["bl-2", "refs", ""],
	["bl-gone", "refs", ""],
	["lonely", "folder", "Lonely"],
	["refs-lonely", "lonely", ""],
	["projects", null, "Projects"],
	["src-1", "projects", 'See <a href="https://workflowy.com/#/target">Target</a>'],
	["src-1-child", "src-1", "Detail"],
	["src-2", null, "Also Target"],
];

function setup() {
	const sqlite = new DatabaseConstructor(":memory:");
	const db = drizzle(sqlite, {schema});
	migrate(db, {migrationsFolder});
	const priorities = new Map<string | null, number>();
	for (const [id, parentId, name] of TREE) {
		const priority = priorities.get(parentId) ?? 0;
		priorities.set(parentId, priority + 1);
		db.insert(nodeContent)
			.values({id, name, note: null, parentId, systemFrom: SEEDED_AT, systemTo: FAR_FUTURE_DATE})
			.run();
		db.insert(nodeMetadata)
			.values({
				nodeId: id,
				priority,
				completedAt: id === "src-2" ? COMPLETED_AT : null,
				systemFrom: SEEDED_AT,
				systemTo: FAR_FUTURE_DATE,
			})
			.run();
	}
	for (const nodeId of ["refs", "refs-lonely"]) {
		db.insert(referencesRoots).values({nodeId, systemFrom: SEEDED_AT, systemTo: FAR_FUTURE_DATE}).run();
	}
	for (const [mirrorId, originalId] of [
		["bl-1", "src-1"],
		["bl-2", "src-2"],
	] as const) {
		db.insert(mirrors).values({mirrorId, originalId, systemFrom: SEEDED_AT, systemTo: FAR_FUTURE_DATE}).run();
	}

	const ctx = {db, cacheService: new CacheService(db)} as unknown as ServerContext;
	const app = new Hono<AppEnv>();
	app.use("*", async (c, next) => {
		c.set("ctx", ctx);
		await next();
	});
	app.route("/", httpAppFor(ctx));
	return {app, db};
}

async function getJson(app: Hono<AppEnv>, path: string): Promise<unknown> {
	const response = await app.fetch(new Request(`http://x${path}`));
	expect(response.status).toBe(200);
	return response.json();
}

describe("references roots in the nodes routes", () => {
	it("never lists a references root as a child", async () => {
		const {app} = setup();

		const body = (await getJson(app, "/api/v1/nodes?parent_id=target")) as {nodes: {id: string}[]};

		expect(body.nodes.map((node) => node.id)).toStrictEqual(["child-a"]);
	});

	it("never lists an empty references root as a child", async () => {
		const {app} = setup();

		const body = (await getJson(app, "/api/v1/nodes?parent_id=lonely")) as {nodes: {id: string}[]};

		expect(body.nodes).toStrictEqual([]);
	});

	it("does not count a references root toward hasChildren", async () => {
		const {app} = setup();

		const list = (await getJson(app, "/api/v1/nodes?parent_id=folder")) as {
			nodes: {id: string; hasChildren: boolean}[];
		};
		const single = (await getJson(app, "/api/v1/nodes/lonely")) as {node: {hasChildren: boolean}};

		expect(list.nodes.map(({id, hasChildren}) => ({id, hasChildren}))).toStrictEqual([
			{id: "target", hasChildren: true},
			{id: "lonely", hasChildren: false},
		]);
		expect(single.node.hasChildren).toBe(false);
	});
});

describe("GET /api/v1/nodes/:id/backlinks", () => {
	it("returns the backlink items whose source is current, with the source text and ancestor crumbs", async () => {
		const {app} = setup();

		const body = await getJson(app, "/api/v1/nodes/target/backlinks");

		expect(body).toStrictEqual({
			rootId: "refs",
			items: [
				{
					node: {
						id: "bl-1",
						parent_id: "refs",
						name: 'See <a href="https://workflowy.com/#/target">Target</a>',
						note: null,
						priority: 0,
						data: {layoutMode: null},
						numberedStart: null,
						createdAt: null,
						modifiedAt: null,
						completedAt: null,
						hasChildren: true,
						hasUncompletedChildren: true,
						hasMirrors: false,
						isMirror: true,
						originalNodeId: "src-1",
						attachment: null,
						defaultToBottom: false,
						calendar: null,
						table: null,
					},
					sourceId: "src-1",
					crumbs: [{id: "projects", name: "Projects"}],
				},
				{
					node: {
						id: "bl-2",
						parent_id: "refs",
						name: "Also Target",
						note: null,
						priority: 1,
						data: {layoutMode: null},
						numberedStart: null,
						createdAt: null,
						modifiedAt: null,
						completedAt: COMPLETED_AT.getTime() / 1000,
						hasChildren: false,
						hasUncompletedChildren: false,
						hasMirrors: false,
						isMirror: true,
						originalNodeId: "src-2",
						attachment: null,
						defaultToBottom: false,
						calendar: null,
						table: null,
					},
					sourceId: "src-2",
					crumbs: [],
				},
			],
		});
	});

	it("returns no root for an item without a references root", async () => {
		const {app} = setup();

		await expect(getJson(app, "/api/v1/nodes/child-a/backlinks")).resolves.toStrictEqual({rootId: null, items: []});
	});
});

describe("a references root fetched directly", () => {
	it("flags itself and carries its Backlinks label", async () => {
		const {app} = setup();

		const body = (await getJson(app, "/api/v1/nodes/refs")) as {node: Record<string, unknown>};

		expect({
			isReferencesRoot: body.node.isReferencesRoot,
			backlinksLabel: body.node.backlinksLabel,
			name: body.node.name,
		}).toStrictEqual({isReferencesRoot: true, backlinksLabel: "2 Backlinks", name: ""});
	});

	it("leaves an ordinary node unflagged", async () => {
		const {app} = setup();

		const body = (await getJson(app, "/api/v1/nodes/target")) as {node: Record<string, unknown>};

		expect({isReferencesRoot: body.node.isReferencesRoot, backlinksLabel: body.node.backlinksLabel}).toStrictEqual({
			isReferencesRoot: undefined,
			backlinksLabel: undefined,
		});
	});

	it("reads as its label in the ancestors of a backlink item", async () => {
		const {app} = setup();

		const body = (await getJson(app, "/api/v1/nodes/bl-1/ancestors")) as {ancestors: {id: string; name: string}[]};

		expect(body.ancestors.map(({id, name}) => ({id, name}))).toStrictEqual([
			{id: "folder", name: "Folder"},
			{id: "target", name: "Target"},
			{id: "refs", name: "2 Backlinks"},
			{id: "bl-1", name: 'See <a href="https://workflowy.com/#/target">Target</a>'},
		]);
	});
});

describe("notReferencesContent", () => {
	it("excludes references roots and the backlink items under them", () => {
		const {db} = setup();

		const ids = db
			.select({id: nodeContent.id})
			.from(nodeContent)
			.where(and(eq(nodeContent.systemTo, FAR_FUTURE_DATE), notReferencesContent()))
			.orderBy(nodeContent.id)
			.all()
			.map((row) => row.id);

		expect(ids).toStrictEqual([
			"child-a",
			"folder",
			"lonely",
			"projects",
			"src-1",
			"src-1-child",
			"src-2",
			"target",
		]);
	});
});

const DELETED_AT = "2026-03-01 00:00:00.000";

/**
 * A references root whose only backlink item outlived both ends of its link:
 * the original (`src-gone`) was deleted, so its mirror row closed, yet the
 * item and its root are still current upstream. Upstream draws no Backlinks
 * section for such a target.
 *
 * folder
 *   stranded
 *     refs-stranded   (references root, current)
 *       bl-stranded   (current backlink item; its mirror row and original are closed)
 */
function addStrandedBacklink(db: ReturnType<typeof setup>["db"]): void {
	const rows: [id: string, parentId: string, systemTo: string][] = [
		["stranded", "folder", FAR_FUTURE_DATE],
		["refs-stranded", "stranded", FAR_FUTURE_DATE],
		["bl-stranded", "refs-stranded", FAR_FUTURE_DATE],
		["src-gone", "projects", DELETED_AT],
	];
	for (const [id, parentId, systemTo] of rows) {
		db.insert(nodeContent).values({id, name: "", note: null, parentId, systemFrom: SEEDED_AT, systemTo}).run();
		db.insert(nodeMetadata)
			.values({nodeId: id, priority: 0, completedAt: null, systemFrom: SEEDED_AT, systemTo})
			.run();
	}
	db.insert(referencesRoots)
		.values({nodeId: "refs-stranded", systemFrom: SEEDED_AT, systemTo: FAR_FUTURE_DATE})
		.run();
	db.insert(mirrors)
		.values({mirrorId: "bl-stranded", originalId: "src-gone", systemFrom: SEEDED_AT, systemTo: DELETED_AT})
		.run();
}

describe("a backlink item whose original is deleted", () => {
	it("stays out of its target's Backlinks section", async () => {
		const {app, db} = setup();
		addStrandedBacklink(db);

		await expect(getJson(app, "/api/v1/nodes/stranded/backlinks")).resolves.toStrictEqual({
			rootId: "refs-stranded",
			items: [],
		});
	});

	it("gives its target no children and no arrow", async () => {
		const {app, db} = setup();
		addStrandedBacklink(db);

		const children = (await getJson(app, "/api/v1/nodes?parent_id=stranded")) as {nodes: {id: string}[]};
		const target = (await getJson(app, "/api/v1/nodes/stranded")) as {
			node: {hasChildren: boolean; hasUncompletedChildren: boolean};
		};

		expect({
			children: children.nodes,
			hasChildren: target.node.hasChildren,
			hasUncompletedChildren: target.node.hasUncompletedChildren,
		}).toStrictEqual({children: [], hasChildren: false, hasUncompletedChildren: false});
	});
});
