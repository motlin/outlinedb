import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {join} from "node:path";
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {applyApiBatch, beginApiImport, finishApiImport} from "../src/cache/api-import.js";
import {runUnitOfWork} from "../src/cache/node-composite.js";
import {
	TRANSACTION_TIMEOUT_MS,
	TransactionTimeoutError,
	startUnitOfWork,
	unitOfWorkSignal,
} from "../src/cache/system-time.js";
import * as schema from "../src/db/schema.js";
import {nodeContent} from "../src/db/schema.js";
import {FAR_FUTURE_DATE} from "../src/temporal/constants.js";
import type {WorkflowyNode} from "../src/types/workflowy.js";

const migrationsFolder = join(import.meta.dirname, "../src/db/migrations");
const START = new Date("2026-02-01T00:00:00.000Z");

function apiNode(id: string): WorkflowyNode {
	return {id, name: `Name ${id}`, priority: 0, createdAt: 1_767_225_600, modifiedAt: 1_767_225_600};
}

describe("transaction timeout", () => {
	const open: DatabaseConstructor.Database[] = [];

	function createDb() {
		const sqlite = new DatabaseConstructor(":memory:");
		open.push(sqlite);
		const db = drizzle(sqlite, {schema});
		migrate(db, {migrationsFolder});
		return db;
	}

	function insertNode(tx: Parameters<Parameters<typeof runUnitOfWork>[1]>[0]["tx"], id: string, systemTime: string) {
		tx.insert(nodeContent)
			.values({id, name: id, note: null, parentId: null, systemFrom: systemTime, systemTo: FAR_FUTURE_DATE})
			.run();
	}

	afterEach(() => {
		vi.useRealTimers();
		for (const sqlite of open.splice(0)) {
			sqlite.close();
		}
	});

	it("starts at 60 seconds", () => {
		expect(TRANSACTION_TIMEOUT_MS).toBe(60_000);
	});

	it("commits a unit of work that finishes exactly at the timeout", () => {
		vi.useFakeTimers({toFake: ["Date"], now: START});
		const db = createDb();

		runUnitOfWork(db, ({tx, systemTime}) => {
			insertNode(tx, "node-1", systemTime);
			vi.setSystemTime(START.getTime() + TRANSACTION_TIMEOUT_MS);
		});

		expect(
			db.select({id: nodeContent.id, systemFrom: nodeContent.systemFrom}).from(nodeContent).all(),
		).toStrictEqual([{id: "node-1", systemFrom: "2026-02-01 00:00:00.000"}]);
	});

	it("rolls back and throws when a unit of work would commit after the timeout", () => {
		vi.useFakeTimers({toFake: ["Date"], now: START});
		const db = createDb();

		expect(() => {
			runUnitOfWork(db, ({tx, systemTime}) => {
				insertNode(tx, "node-1", systemTime);
				vi.setSystemTime(START.getTime() + TRANSACTION_TIMEOUT_MS + 1);
			});
		}).toThrow(new TransactionTimeoutError("2026-02-01 00:00:00.000", TRANSACTION_TIMEOUT_MS + 1));
		expect(db.select().from(nodeContent).all()).toStrictEqual([]);
	});

	it("names the system time and the elapsed time in the error", () => {
		expect(new TransactionTimeoutError("2026-02-01 00:00:00.000", 60_001).message).toBe(
			"Unit of work stamped 2026-02-01 00:00:00.000 would commit 60001ms after it started, past the 60000ms transaction timeout; rolled back",
		);
	});

	it("measures the timeout from when the unit started, not from a caller-supplied system time", () => {
		vi.useFakeTimers({toFake: ["Date"], now: START});
		const db = createDb();
		const start = startUnitOfWork(new Date("2024-01-01T00:00:00.000Z"));

		runUnitOfWork(
			db,
			({tx, systemTime}) => {
				insertNode(tx, "node-1", systemTime);
			},
			start,
		);

		expect(
			db.select({id: nodeContent.id, systemFrom: nodeContent.systemFrom}).from(nodeContent).all(),
		).toStrictEqual([{id: "node-1", systemFrom: "2024-01-01 00:00:00.000"}]);
	});

	it("fails a batch of a batched API import that lands after the import's timeout", () => {
		vi.useFakeTimers({toFake: ["Date"], now: START});
		const db = createDb();
		const state = beginApiImport(db);
		applyApiBatch(state, [apiNode("a")]);
		vi.setSystemTime(START.getTime() + TRANSACTION_TIMEOUT_MS + 1);

		expect(() => {
			applyApiBatch(state, [apiNode("b")]);
		}).toThrow(new TransactionTimeoutError("2026-02-01 00:00:00.000", TRANSACTION_TIMEOUT_MS + 1));
		expect(() => finishApiImport(state)).toThrow(TransactionTimeoutError);
		expect(db.select({id: nodeContent.id, systemTo: nodeContent.systemTo}).from(nodeContent).all()).toStrictEqual([
			{id: "a", systemTo: FAR_FUTURE_DATE},
		]);
	});

	it("gives upstream fetches a signal that aborts when the unit's remaining time runs out", () => {
		vi.useFakeTimers({toFake: ["Date", "setTimeout", "clearTimeout"], now: START});
		const start = startUnitOfWork();
		vi.setSystemTime(START.getTime() + 20_000);

		const signal = unitOfWorkSignal(start);
		vi.advanceTimersByTime(TRANSACTION_TIMEOUT_MS - 20_000 - 1);
		const beforeDeadline = signal.aborted;
		vi.advanceTimersByTime(1);

		expect({beforeDeadline, afterDeadline: signal.aborted, reason: signal.reason}).toStrictEqual({
			beforeDeadline: false,
			afterDeadline: true,
			reason: new TransactionTimeoutError("2026-02-01 00:00:00.000", TRANSACTION_TIMEOUT_MS),
		});
	});

	it("gives an already-expired unit a signal that is already aborted", () => {
		vi.useFakeTimers({toFake: ["Date", "setTimeout", "clearTimeout"], now: START});
		const start = startUnitOfWork();
		vi.setSystemTime(START.getTime() + TRANSACTION_TIMEOUT_MS + 5);

		expect(unitOfWorkSignal(start).aborted).toBe(true);
	});
});
