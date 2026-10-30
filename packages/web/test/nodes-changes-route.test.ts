import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {Hono} from "hono";
import {join} from "node:path";
import * as schema from "@workflowy/shared/db";
import type {WorkflowyNode} from "@workflowy/shared/types";
import type {AppEnv, ServerContext} from "../src/server/context.js";
import type {NodeChangesResponse} from "../src/node-types.js";
import {httpAppFor} from "./http-app-for.js";

const {CacheService} = await import("@workflowy/shared/cache");

const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");

function apiNode(id: string, parentId: string | null, priority: number): WorkflowyNode {
	return {id, name: id, note: null, parent_id: parentId, priority, createdAt: 100, modifiedAt: 200, completed: false};
}

/** When `setup` seeds the tree; tests move the clock relative to it. */
const T0 = Date.parse("2026-10-29T12:00:00.000Z");

/** The temporal timestamp `ms` after {@link T0}. */
function stamp(ms: number): string {
	return new Date(T0 + ms).toISOString().replace("T", " ").replace("Z", "");
}

/**
 * Home holds `parents` parents P0.., each with two children, seeded at {@link T0}. The clock then stands two
 * transaction timeouts later, so the seeding falls behind every watermark the test sees.
 */
function setup(parents: number) {
	vi.useFakeTimers({toFake: ["Date"], now: T0});
	const sqlite = new DatabaseConstructor(":memory:");
	let statements = 0;
	const db = drizzle(sqlite, {
		schema,
		logger: {
			logQuery() {
				statements += 1;
			},
		},
	});
	migrate(db, {migrationsFolder});
	const cacheService = new CacheService(db);
	for (let p = 0; p < parents; p++) {
		cacheService.insertNode(apiNode(`P${p}`, null, p), null);
		for (let k = 0; k < 2; k++) {
			cacheService.insertNode(apiNode(`P${p}c${k}`, `P${p}`, k), `P${p}`);
		}
	}
	vi.setSystemTime(T0 + 120_000);
	const ctx = {db, cacheService} as unknown as ServerContext;
	const app = new Hono<AppEnv>();
	app.use("*", async (c, next) => {
		c.set("ctx", ctx);
		await next();
	});
	app.route("/", httpAppFor(ctx));
	const changes = async (since: string | null) => {
		const before = statements;
		const query = since === null ? "" : `?since=${encodeURIComponent(since)}`;
		const res = await app.fetch(new Request(`http://x/api/v1/nodes/changes${query}`));
		const body = (await res.json()) as NodeChangesResponse;
		return {status: res.status, body, statements: statements - before};
	};
	return {cacheService, changes};
}

/** A response reduced to what a test compares: id sets, and each list as parent -> child ids. */
function shape(body: NodeChangesResponse) {
	return {
		reset: body.reset,
		changedIds: new Set(body.changedIds),
		deletedIds: new Set(body.deletedIds),
		children: Object.fromEntries(
			body.children.map(({parentId, nodes}) => [parentId ?? "home", nodes.map((node) => node.id)]),
		),
	};
}

describe("GET /api/v1/nodes/changes", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("without since answers only the watermark: now less the transaction timeout", async () => {
		const {changes} = setup(1);

		const {status, body} = await changes(null);

		expect({status, latest: body.latest, ...shape(body)}).toStrictEqual({
			status: 200,
			latest: stamp(60_000),
			reset: false,
			changedIds: new Set(),
			deletedIds: new Set(),
			children: {},
		});
	});

	it("answers a created node with its parent's refreshed children", async () => {
		const {cacheService, changes} = setup(2);
		const seeded = await changes(null);
		vi.setSystemTime(T0 + 130_000);
		cacheService.insertNode(apiNode("New", "P1", 5), "P1");

		const {body} = await changes(seeded.body.latest);

		expect({latest: body.latest, ...shape(body)}).toStrictEqual({
			latest: stamp(70_000),
			reset: false,
			changedIds: new Set(["New"]),
			deletedIds: new Set(),
			children: {P1: ["P1c0", "P1c1", "New"]},
		});
	});

	it("answers a moved node with both its old and new parents' children", async () => {
		const {cacheService, changes} = setup(2);
		const seeded = await changes(null);
		cacheService.insertNode(apiNode("P0c1", "P1", 5), "P1");

		const {body} = await changes(seeded.body.latest);

		expect(shape(body)).toStrictEqual({
			reset: false,
			changedIds: new Set(["P0c1"]),
			deletedIds: new Set(),
			children: {P0: ["P0c0"], P1: ["P1c0", "P1c1", "P0c1"]},
		});
	});

	it("answers a deleted node as deleted, with its parent's children", async () => {
		const {cacheService, changes} = setup(2);
		const seeded = await changes(null);
		cacheService.deleteNode("P1c0");

		const {body} = await changes(seeded.body.latest);

		expect(shape(body)).toStrictEqual({
			reset: false,
			changedIds: new Set(["P1c0"]),
			deletedIds: new Set(["P1c0"]),
			children: {P1: ["P1c1"]},
		});
	});

	it("delivers a change stamped before an earlier poll's watermark that commits after it", async () => {
		const {cacheService, changes} = setup(2);
		const seeded = await changes(null);
		vi.setSystemTime(T0 + 130_000);
		cacheService.insertNode(apiNode("Later", "P0", 5), "P0");
		const first = await changes(seeded.body.latest);
		// A unit that read the clock before "Later" and committed after the first poll, within the timeout.
		vi.setSystemTime(T0 + 100_000);
		cacheService.insertNode(apiNode("Earlier", "P1", 5), "P1");
		vi.setSystemTime(T0 + 140_000);
		const second = await changes(first.body.latest);
		// Past the timeout window, the re-reads stop.
		vi.setSystemTime(T0 + 300_000);
		const third = await changes(second.body.latest);
		const fourth = await changes(third.body.latest);

		const reduce = ({body}: {body: NodeChangesResponse}) => ({latest: body.latest, ...shape(body)});
		expect({
			first: reduce(first),
			second: reduce(second),
			third: reduce(third),
			fourth: reduce(fourth),
		}).toStrictEqual({
			first: {
				latest: stamp(70_000),
				reset: false,
				changedIds: new Set(["Later"]),
				deletedIds: new Set(),
				children: {P0: ["P0c0", "P0c1", "Later"]},
			},
			// The last timeout window is read again, so "Later" repeats, once, beside "Earlier".
			second: {
				latest: stamp(80_000),
				reset: false,
				changedIds: new Set(["Later", "Earlier"]),
				deletedIds: new Set(),
				children: {P0: ["P0c0", "P0c1", "Later"], P1: ["P1c0", "P1c1", "Earlier"]},
			},
			third: {
				latest: stamp(240_000),
				reset: false,
				changedIds: new Set(["Later", "Earlier"]),
				deletedIds: new Set(),
				children: {P0: ["P0c0", "P0c1", "Later"], P1: ["P1c0", "P1c1", "Earlier"]},
			},
			fourth: {latest: stamp(240_000), reset: false, changedIds: new Set(), deletedIds: new Set(), children: {}},
		});
		expect(second.body.changedIds).toStrictEqual([...new Set(second.body.changedIds)]);
	});

	it("answers reset for a cursor it never issued", async () => {
		const {changes} = setup(1);
		const seeded = await changes(null);

		const resets = await Promise.all(
			["42", stamp(60_001)].map(async (since) => {
				const {body} = await changes(since);
				return {reset: body.reset, latest: body.latest};
			}),
		);

		expect(resets).toStrictEqual([
			{reset: true, latest: seeded.body.latest},
			{reset: true, latest: seeded.body.latest},
		]);
	});

	it("keeps its statement count independent of how many parents changed", async () => {
		const run = async (parents: number) => {
			const {cacheService, changes} = setup(parents);
			const seeded = await changes(null);
			vi.setSystemTime(T0 + 130_000);
			for (let p = 0; p < parents; p++) {
				cacheService.insertNode(apiNode(`New${p}`, `P${p}`, 5), `P${p}`);
			}
			return changes(seeded.body.latest);
		};

		const few = await run(2);
		const many = await run(12);

		expect({
			few: Object.keys(shape(few.body).children).length,
			many: Object.keys(shape(many.body).children).length,
			same: few.statements === many.statements,
		}).toStrictEqual({few: 2, many: 12, same: true});
		expect(many.statements).toBeLessThanOrEqual(40);
	});
});
