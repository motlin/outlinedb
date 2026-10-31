import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {join} from "node:path";
import {afterEach, describe, expect, it} from "vite-plus/test";
import {CacheService, storeInternalMetadata} from "@workflowy/shared/cache";
import * as schema from "@workflowy/shared/db";
import type {WorkflowyInternalAdapter} from "@workflowy/shared/internal";
import {FAR_FUTURE_DATE} from "@workflowy/shared/temporal";
import type {ServerContext} from "../src/server/context.js";
import {httpAppFor} from "./http-app-for.js";

const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");

const open: DatabaseConstructor.Database[] = [];
afterEach(() => {
	for (const sqlite of open.splice(0)) {
		sqlite.close();
	}
});

function app(
	levels: Record<string, boolean>,
	{layoutEnabled, weekStartDay}: {layoutEnabled?: boolean; weekStartDay?: number} = {},
) {
	const sqlite = new DatabaseConstructor(":memory:");
	open.push(sqlite);
	const db = drizzle(sqlite, {schema});
	migrate(db, {migrationsFolder});
	db.insert(schema.nodeContent)
		.values({id: "cal", name: "📆 Calendar", parentId: null, systemFrom: "2026-01-01", systemTo: FAR_FUTURE_DATE})
		.run();
	storeInternalMetadata(db, new Map([["cal", {calendar: {root: true, levels}}]]));
	const meta: Record<string, unknown> = weekStartDay === undefined ? {} : {weekStartDay};
	const applied: unknown[] = [];
	const adapter = {
		getSetting: async () => Promise.resolve(undefined),
		setSetting: async () => Promise.resolve(),
		saveLocalSettings: () => {},
		getRootMeta: async (path: string[]) => Promise.resolve(meta[path[0] ?? ""]),
		setRootMetaValues: async (changes: {path: string[]; value: unknown}[]) => {
			for (const {path, value} of changes) {
				meta[path[0] ?? ""] = value;
			}
			return Promise.resolve();
		},
		applyCalendarLayout: async (appliedLevels: unknown) => {
			applied.push(appliedLevels);
			return Promise.resolve({rootId: "cal", writes: 1});
		},
	};
	const ctx = {
		db,
		cacheService: new CacheService(db),
		calendarLayoutEnabled: layoutEnabled,
		internalAdapter: () => adapter as unknown as WorkflowyInternalAdapter,
	} as unknown as ServerContext;
	const hono = httpAppFor(ctx);
	const patch = async (body: unknown) =>
		hono.fetch(
			new Request("http://x/api/v1/preferences", {
				method: "PATCH",
				headers: {"content-type": "application/json"},
				body: JSON.stringify(body),
			}),
		);
	return {patch, applied};
}

describe("PATCH /api/v1/preferences weekStartDay", () => {
	it("re-applies the current layout once when the week start changes under a week-level calendar", async () => {
		const {patch, applied} = app({year: true, month: true, week: true, day: true});
		await patch({weekStartDay: 1});
		expect(applied).toStrictEqual([{year: true, month: true, week: true, day: true}]);
	});

	it("does not re-layout when the calendar has no week level", async () => {
		const {patch, applied} = app({year: true, month: true, day: true});
		await patch({weekStartDay: 1});
		expect(applied).toStrictEqual([]);
	});

	it("does not re-layout when the week start is unchanged", async () => {
		const {patch, applied} = app({year: true, week: true, day: true}, {weekStartDay: 1});
		await patch({weekStartDay: 1});
		expect(applied).toStrictEqual([]);
	});

	it("does not re-layout when applying layouts is disabled", async () => {
		const {patch, applied} = app({year: true, week: true, day: true}, {layoutEnabled: false});
		await patch({weekStartDay: 1});
		expect(applied).toStrictEqual([]);
	});

	it("does not re-layout for other preferences", async () => {
		const {patch, applied} = app({year: true, week: true, day: true});
		await patch({dateFormat: "YYYY-MM-DD"});
		expect(applied).toStrictEqual([]);
	});
});
