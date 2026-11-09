import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {join} from "node:path";
import {describe, expect, it} from "vite-plus/test";
import {CacheService} from "@outlinedb/shared/cache";
import * as schema from "@outlinedb/shared/db";
import {mirrors, nodeContent, nodeMetadata, referencesRoots} from "@outlinedb/shared/db";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import {backlinkTargetsOfSource, backlinksNeedSync} from "../src/server/backlinks.js";
import type {ServerContext} from "../src/server/context.js";

const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");
const SEEDED_AT = "2026-01-01 00:00:00.000";

const TARGET = "00000000-0000-4000-8000-0000000000aa";
const SOURCE = "00000000-0000-4000-8000-0000000000bb";
const ROOT = "00000000-0000-4000-8000-0000000000cc";
const ITEM = "00000000-0000-4000-8000-0000000000dd";
const short = (id: string) => id.slice(-12);
const link = (id: string) => `<a href="https://workflowy.com/#/${short(id)}">t</a>`;

function setup({withBacklink}: {withBacklink: boolean}) {
	const sqlite = new DatabaseConstructor(":memory:");
	const db = drizzle(sqlite, {schema});
	migrate(db, {migrationsFolder});
	const rows: [string, string | null][] = [
		[TARGET, null],
		[SOURCE, null],
		[ROOT, TARGET],
		...(withBacklink ? [[ITEM, ROOT] as [string, string | null]] : []),
	];
	for (const [id, parentId] of rows) {
		db.insert(nodeContent)
			.values({
				id,
				name: id === SOURCE ? link(TARGET) : "x",
				note: null,
				parentId,
				systemFrom: SEEDED_AT,
				systemTo: FAR_FUTURE_DATE,
			})
			.run();
		db.insert(nodeMetadata)
			.values({nodeId: id, shortId: short(id), priority: 0, systemFrom: SEEDED_AT, systemTo: FAR_FUTURE_DATE})
			.run();
	}
	db.insert(referencesRoots).values({nodeId: ROOT, systemFrom: SEEDED_AT, systemTo: FAR_FUTURE_DATE}).run();
	if (withBacklink) {
		db.insert(mirrors)
			.values({mirrorId: ITEM, originalId: SOURCE, systemFrom: SEEDED_AT, systemTo: FAR_FUTURE_DATE})
			.run();
	}
	return {ctx: {db, cacheService: new CacheService(db)} as unknown as ServerContext};
}

describe("backlinksNeedSync", () => {
	it("is false when the link set is unchanged and its backlink exists", () => {
		const {ctx} = setup({withBacklink: true});

		expect(backlinksNeedSync(ctx, SOURCE, `a ${link(TARGET)}`, `ab ${link(TARGET)}`)).toBe(false);
	});

	it("is true when the backlink was deleted, even with the same text", () => {
		const {ctx} = setup({withBacklink: false});

		expect(backlinksNeedSync(ctx, SOURCE, `a ${link(TARGET)}`, `ab ${link(TARGET)}`)).toBe(true);
	});

	it("is true when a link is added", () => {
		const {ctx} = setup({withBacklink: true});

		expect(backlinksNeedSync(ctx, SOURCE, "plain", link(TARGET))).toBe(true);
	});

	it("is true when a link is removed", () => {
		const {ctx} = setup({withBacklink: true});

		expect(backlinksNeedSync(ctx, SOURCE, link(TARGET), "plain")).toBe(true);
	});

	it("is false when neither text has links", () => {
		const {ctx} = setup({withBacklink: false});

		expect(backlinksNeedSync(ctx, SOURCE, "plain", "plainer")).toBe(false);
	});
});

describe("backlinkTargetsOfSource", () => {
	it("maps each current backlink item of the source to its target", () => {
		const {ctx} = setup({withBacklink: true});

		expect(backlinkTargetsOfSource(ctx.db, SOURCE)).toStrictEqual(new Map([[ITEM, TARGET]]));
	});
});
