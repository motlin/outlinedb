import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {applyApiBatch, beginApiImport, finishApiImport} from "../src/cache/api-import.js";
import {runUnitOfWork} from "../src/cache/node-composite.js";
import
{
	TRANSACTION_TIMEOUT_MS,
	TransactionTimeoutError,
	startUnitOfWork,
	unitOfWorkSignal,
} from "../src/cache/system-time.js";
import * as schema from "../src/db/schema.js";
import {nodeContent} from "../src/db/schema.js";
import {FAR_FUTURE_DATE, systemTimeAt} from "../src/temporal/constants.js";
import type {WorkflowyNode} from "../src/types/workflowy.js";
import {migratedMemoryDatabase} from "./helpers/migrated-memory-database.js";

const START = new Date("2026-02-01T00:00:00.000Z");

function apiNode(id: string): WorkflowyNode
{
	return {
		id,
		name: `Name ${id}`,
		priority: 0,
		createdAt: 1_767_225_600,
		modifiedAt: 1_767_225_600,
	};
}

describe("transaction timeout", () =>
{
	const open: DatabaseConstructor.Database[] = [];

	function createDb()
	{
		const sqlite = migratedMemoryDatabase();
		open.push(sqlite);
		const db = drizzle(
			sqlite,
			{
				schema,
			},
		);
		return db;
	}

	function insertNode(tx: Parameters<Parameters<typeof runUnitOfWork>[1]>[0]["tx"], id: string, systemTime: number)
	{
		tx.insert(nodeContent)
			.values(
				{
					id,
					name: id,
					note: null,
					parentId: null,
					systemFrom: systemTime,
					systemTo: FAR_FUTURE_DATE,
				},
			)
			.run();
	}

	afterEach(() =>
	{
		vi.useRealTimers();
		for (const sqlite of open.splice(0))
		{
			sqlite.close();
		}
	});

	it("is 60 seconds, the lag every change-feed poll re-reads", () =>
	{
		expect(TRANSACTION_TIMEOUT_MS).toBe(60_000);
	});

	it("commits a unit of work that finishes exactly at the timeout", () =>
	{
		vi.useFakeTimers(
			{
				toFake: ["Date"],
				now: START,
			},
		);
		const db = createDb();

		runUnitOfWork(db, ({tx, systemTime}) =>
		{
			insertNode(tx, "node-1", systemTime);
			vi.setSystemTime(START.getTime() + TRANSACTION_TIMEOUT_MS);
		});

		expect(
			db
				.select(
					{
						id: nodeContent.id,
						systemFrom: nodeContent.systemFrom,
					},
				)
				.from(nodeContent)
				.all(),
		).toStrictEqual([
			{
				id: "node-1",
				systemFrom: systemTimeAt("2026-02-01 00:00:00.000"),
			},
		]);
	});

	it("rolls back and throws when a unit of work would commit after the timeout", () =>
	{
		vi.useFakeTimers(
			{
				toFake: ["Date"],
				now: START,
			},
		);
		const db = createDb();

		expect(() =>
		{
			runUnitOfWork(db, ({tx, systemTime}) =>
			{
				insertNode(tx, "node-1", systemTime);
				vi.setSystemTime(START.getTime() + TRANSACTION_TIMEOUT_MS + 1);
			});
		}).toThrow(new TransactionTimeoutError(systemTimeAt("2026-02-01 00:00:00.000"), TRANSACTION_TIMEOUT_MS + 1));
		expect(db.select().from(nodeContent).all()).toStrictEqual([]);
	});

	it("takes the write lock at BEGIN, so another connection's commit cannot stale its snapshot", () =>
	{
		const dir = mkdtempSync(join(tmpdir(), "unit-of-work-lock-"));
		const file = join(dir, "db.sqlite");
		const template = migratedMemoryDatabase();
		writeFileSync(file, template.serialize());
		template.close();
		const ours = new DatabaseConstructor(file);
		const theirs = new DatabaseConstructor(
			file,
			{
				timeout: 0,
			},
		);
		open.push(ours, theirs);
		ours.pragma("journal_mode = WAL");
		const db = drizzle(
			ours,
			{
				schema,
			},
		);
		let theirWrite = "committed";

		try
		{
			runUnitOfWork(db, ({tx, systemTime}) =>
			{
				tx.select().from(nodeContent).all();
				try
				{
					theirs
						.prepare("INSERT INTO node_content (id, name, system_from, system_to) VALUES (?, ?, ?, ?)")
						.run("theirs", "theirs", systemTime, FAR_FUTURE_DATE);
				}
				catch (error)
				{
					theirWrite = (
						error as
						{
							code: string;
						}
					).code;
				}
				insertNode(tx, "ours", systemTime);
			});

			expect(
				{
					theirWrite,
					ids: db
						.select(
							{
								id: nodeContent.id,
							},
						)
						.from(nodeContent)
						.all(),
				},
			).toStrictEqual(
				{
					theirWrite: "SQLITE_BUSY",
					ids: [
						{
							id: "ours",
						},
					],
				},
			);
		}
		finally
		{
			rmSync(
				dir,
				{
					recursive: true,
					force: true,
				},
			);
		}
	});

	it("names the system time and the elapsed time in the error", () =>
	{
		expect(new TransactionTimeoutError(systemTimeAt("2026-02-01 00:00:00.000"), 60_001).message).toBe(
			"Unit of work stamped 2026-02-01T00:00:00.000000Z would commit 60001ms after it started, past the 60000ms transaction timeout; rolled back",
		);
	});

	it("measures the timeout from when the unit started, not from a caller-supplied system time", () =>
	{
		vi.useFakeTimers(
			{
				toFake: ["Date"],
				now: START,
			},
		);
		const db = createDb();
		const start = startUnitOfWork(new Date("2024-01-01T00:00:00.000Z"));

		runUnitOfWork(
			db,
			({tx, systemTime}) =>
			{
				insertNode(tx, "node-1", systemTime);
			},
			start,
		);

		expect(
			db
				.select(
					{
						id: nodeContent.id,
						systemFrom: nodeContent.systemFrom,
					},
				)
				.from(nodeContent)
				.all(),
		).toStrictEqual([
			{
				id: "node-1",
				systemFrom: systemTimeAt("2024-01-01 00:00:00.000"),
			},
		]);
	});

	it("fails a batch of a batched API import that lands after the import's timeout", () =>
	{
		vi.useFakeTimers(
			{
				toFake: ["Date"],
				now: START,
			},
		);
		const db = createDb();
		const state = beginApiImport(db);
		applyApiBatch(state, [apiNode("a")]);
		vi.setSystemTime(START.getTime() + TRANSACTION_TIMEOUT_MS + 1);

		expect(() =>
		{
			applyApiBatch(state, [apiNode("b")]);
		}).toThrow(new TransactionTimeoutError(systemTimeAt("2026-02-01 00:00:00.000"), TRANSACTION_TIMEOUT_MS + 1));
		expect(() => finishApiImport(state)).toThrow(TransactionTimeoutError);
		expect(
			db
				.select(
					{
						id: nodeContent.id,
						systemTo: nodeContent.systemTo,
					},
				)
				.from(nodeContent)
				.all(),
		).toStrictEqual([
			{
				id: "a",
				systemTo: FAR_FUTURE_DATE,
			},
		]);
	});

	it("gives upstream fetches a signal that aborts when the unit's remaining time runs out", () =>
	{
		vi.useFakeTimers(
			{
				toFake: ["Date", "setTimeout", "clearTimeout"],
				now: START,
			},
		);
		const start = startUnitOfWork();
		vi.setSystemTime(START.getTime() + 20_000);

		const signal = unitOfWorkSignal(start);
		vi.advanceTimersByTime(TRANSACTION_TIMEOUT_MS - 20_000 - 1);
		const beforeDeadline = signal.aborted;
		vi.advanceTimersByTime(1);

		expect(
			{
				beforeDeadline,
				afterDeadline: signal.aborted,
				reason: signal.reason,
			},
		).toStrictEqual(
			{
				beforeDeadline: false,
				afterDeadline: true,
				reason: new TransactionTimeoutError(systemTimeAt("2026-02-01 00:00:00.000"), TRANSACTION_TIMEOUT_MS),
			},
		);
	});

	it("gives an already-expired unit a signal that is already aborted", () =>
	{
		vi.useFakeTimers(
			{
				toFake: ["Date", "setTimeout", "clearTimeout"],
				now: START,
			},
		);
		const start = startUnitOfWork();
		vi.setSystemTime(START.getTime() + TRANSACTION_TIMEOUT_MS + 5);

		expect(unitOfWorkSignal(start).aborted).toBe(true);
	});
});
