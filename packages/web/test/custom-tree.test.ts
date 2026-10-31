import {describe, expect, it} from "vite-plus/test";
import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {join} from "node:path";
import {CacheService} from "@workflowy/shared/cache";
import * as schema from "@workflowy/shared/db";
import {nodeContent, nodeMetadata} from "@workflowy/shared/db";
import {FAR_FUTURE_DATE} from "@workflowy/shared/temporal";
import type {ServerContext} from "../src/server/context.js";
import {httpAppFor} from "./http-app-for.js";
import {collectCustomSections, findCustomRoot} from "../src/server/custom-tree.js";
import type {CustomNode} from "../src/server/custom-tree.js";

const grammars = new Set(["Hotkeys", "Themes"]);
const node = (name: string, children: CustomNode[] = [], completed = false): CustomNode => ({
	name,
	completed,
	children,
});

describe("collectCustomSections", () => {
	it("collects Hotkeys nodes in post-order, nested ones before their ancestor", () => {
		const root = node("Custom", [
			node("Hotkeys", [node("A"), node("Hotkeys", [node("B")])]),
			node("Hotkeys", [node("C")]),
		]);
		expect(collectCustomSections(root, grammars).Hotkeys.map((h) => h.children.map((c) => c.name))).toStrictEqual([
			["B"],
			["A", "Hotkeys"],
			["C"],
		]);
	});

	it("skips completed grammar nodes, nodes under completed parents and a completed root", () => {
		expect(
			collectCustomSections(
				node("Custom", [node("Hotkeys", [], true), node("Other", [node("Hotkeys")], true)]),
				grammars,
			),
		).toStrictEqual({});
		expect(collectCustomSections(node("Custom", [node("Hotkeys")], true), grammars)).toStrictEqual({});
		expect(collectCustomSections(null, grammars)).toStrictEqual({});
	});
});

describe("findCustomRoot", () => {
	const top = [
		{id: "a", name: "Work", completedAt: null},
		{id: "done", name: "Custom", completedAt: new Date()},
		{id: "b", name: "<b>Custom</b>", completedAt: null},
		{id: "c", name: "Custom", completedAt: null},
	];
	it("prefers a valid id, skips completed Custom, strips formatting and returns null for no match", () => {
		expect({
			preferred: findCustomRoot(top, "c"),
			completedPreferred: findCustomRoot(top, "done"),
			bold: findCustomRoot(top),
			none: findCustomRoot([top[0]]),
		}).toStrictEqual({preferred: "c", completedPreferred: "b", bold: "b", none: null});
	});
});

describe("GET /api/v1/custom-tree", () => {
	const AT = "2026-01-01 00:00:00.000";
	it("returns the sections under the Custom root and the ids whose change can change them", async () => {
		const sqlite = new DatabaseConstructor(":memory:");
		const db = drizzle(sqlite, {schema});
		migrate(db, {migrationsFolder: join(import.meta.dirname, "../../shared/src/db/migrations")});
		const rows: [string, string | null, string, number][] = [
			["custom", null, "Custom", 0],
			["other", null, "Other", 1],
			["elsewhere", "other", "Hotkeys", 0],
			["hk", "custom", "Hotkeys", 0],
			["combo", "hk", "alt+z", 0],
			["cmd", "combo", "zoom_in", 0],
		];
		for (const [id, parentId, name, priority] of rows) {
			db.insert(nodeContent)
				.values({id, name, note: null, parentId, systemFrom: AT, systemTo: FAR_FUTURE_DATE})
				.run();
			db.insert(nodeMetadata).values({nodeId: id, priority, systemFrom: AT, systemTo: FAR_FUTURE_DATE}).run();
		}
		const ctx = {db, cacheService: new CacheService(db)} as unknown as ServerContext;
		const app = httpAppFor(ctx);

		const body = await (await app.fetch(new Request("http://x/api/v1/custom-tree"))).json();

		expect(body).toStrictEqual({
			rootId: "custom",
			rootChildren: [{id: "hk", name: "Hotkeys"}],
			watchedIds: ["custom", "other", "hk", "combo", "cmd"],
			sections: {
				Hotkeys: [
					{
						name: "Hotkeys",
						completed: false,
						children: [
							{
								name: "alt+z",
								completed: false,
								children: [{name: "zoom_in", completed: false, children: []}],
							},
						],
					},
				],
			},
		});
	});
});
