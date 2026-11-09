import {CacheService, ensureNodeTags} from "@outlinedb/shared/cache";
import {nodeContent} from "@outlinedb/shared/db";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import {sql} from "drizzle-orm";
import {describe, expect, it} from "vite-plus/test";
import {buildTestDb} from "./helpers/round-trip-helpers.js";

function node(id: string, name: string, note: string | null = null) {
	return {id, name, note, parent_id: null, priority: 100, createdAt: 1, modifiedAt: 1};
}

function nodeTagRows(database: ReturnType<typeof buildTestDb>["database"]) {
	return database.all<{node_id: string; tag_key: string; tag: string}>(
		sql`SELECT node_id, tag_key, tag FROM node_tags ORDER BY node_id, tag_key`,
	);
}

describe("node_tags", () => {
	it("keeps each live item's distinct tags in step with every write, skipping #use-template tags", () => {
		const {database, sqlite} = buildTestDb();
		const cache = new CacheService(database);

		cache.insertNode(node("a", "Alpha #Red #red <b>#Blue</b>", "#use-template:x @Pat"), null);
		cache.insertNode(node("b", "Beta #green"), null);
		const created = nodeTagRows(database);

		cache.insertNode(node("a", "Alpha #Blue"), null);
		const edited = nodeTagRows(database);

		cache.deleteNode("b");
		const deleted = nodeTagRows(database);

		sqlite.close();
		expect({created, edited, deleted}).toStrictEqual({
			created: [
				{node_id: "a", tag_key: "#blue", tag: "#Blue"},
				{node_id: "a", tag_key: "#red", tag: "#Red"},
				{node_id: "a", tag_key: "@pat", tag: "@Pat"},
				{node_id: "b", tag_key: "#green", tag: "#green"},
			],
			edited: [
				{node_id: "a", tag_key: "#blue", tag: "#Blue"},
				{node_id: "b", tag_key: "#green", tag: "#green"},
			],
			deleted: [{node_id: "a", tag_key: "#blue", tag: "#Blue"}],
		});
	});

	it("backfills an empty node_tags from the live tree, leaving closed versions out", () => {
		const {database, sqlite} = buildTestDb();
		const at = "2026-01-01 00:00:00.000";
		database
			.insert(nodeContent)
			.values([
				{id: "live", name: "Live #kept", note: null, parentId: null, systemFrom: at, systemTo: FAR_FUTURE_DATE},
				{id: "gone", name: "Gone #lost", note: null, parentId: null, systemFrom: at, systemTo: at},
			])
			.run();

		ensureNodeTags(database);

		const rows = nodeTagRows(database);
		sqlite.close();
		expect(rows).toStrictEqual([{node_id: "live", tag_key: "#kept", tag: "#kept"}]);
	});
});
