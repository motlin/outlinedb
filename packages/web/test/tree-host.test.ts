import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {join} from "node:path";
import {afterEach, describe, expect, it} from "vite-plus/test";
import * as schema from "@outlinedb/shared/db";
import {nodeContent, nodeMetadata} from "@outlinedb/shared/db";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import
{
	bindTreeHost,
	loadTreeRows,
	peekTreeSnapshotBuild,
	peekTreeSnapshotRows,
	scheduleTreeSnapshotRebuild,
	warmTreeSnapshot,
	withTreeSnapshotRebuild,
} from "../src/server/tree-snapshot.js";
import type {ChangeSource, TreeScheduler} from "../src/server/tree-snapshot.js";

const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");
const SEEDED_AT = "2026-01-01 00:00:00.000";

const open: DatabaseConstructor.Database[] = [];

afterEach(() =>
{
	for (const sqlite of open.splice(0))
	{
		sqlite.close();
	}
});

class FakeChangeSource implements ChangeSource
{
	version = 1;
	open = true;
	isOpen(): boolean
	{
		return this.open;
	}
	dataVersion(): string
	{
		return String(this.version);
	}
}

class FakeScheduler implements TreeScheduler
{
	readonly pending = new Map<number, () => void>();
	readonly delays: number[] = [];
	private next = 0;
	setTimer(run: () => void, delayMs: number): () => void
	{
		this.delays.push(delayMs);
		this.next += 1;
		const handle = this.next;
		this.pending.set(handle, run);
		return () =>
		{
			this.pending.delete(handle);
		};
	}
	runAll(): void
	{
		const runs = [...this.pending.values()];
		this.pending.clear();
		runs.forEach((run) =>
		{
			run();
		});
	}
}

function insertNode(db: ReturnType<typeof setup>["db"], id: string, name: string, priority: number): void
{
	db.insert(nodeContent)
		.values(
			{
				id,
				name,
				note: null,
				parentId: null,
				systemFrom: SEEDED_AT,
				systemTo: FAR_FUTURE_DATE,
			},
		)
		.run();
	db.insert(nodeMetadata)
		.values(
			{
				nodeId: id,
				priority,
				systemFrom: SEEDED_AT,
				systemTo: FAR_FUTURE_DATE,
			},
		)
		.run();
}

function setup()
{
	const sqlite = new DatabaseConstructor(":memory:");
	open.push(sqlite);
	const db = drizzle(
		sqlite,
		{
			schema,
		},
	);
	migrate(
		db,
		{
			migrationsFolder,
		},
	);
	insertNode(db, "a", "Alpha", 0);
	const source = new FakeChangeSource();
	const scheduler = new FakeScheduler();
	bindTreeHost(
		db,
		{
			changeSource: source,
			scheduler,
		},
	);
	return {
		db,
		source,
		scheduler,
	};
}

const ids = (db: ReturnType<typeof setup>["db"]) => loadTreeRows(db, null).map((row) => row.id);

describe("tree snapshot host seams", () =>
{
	it("refreshes right away after a write by this server", () =>
	{
		const {db, scheduler} = setup();
		expect(ids(db)).toStrictEqual(["a"]);
		insertNode(db, "b", "Beta", 1);
		expect(ids(db)).toStrictEqual(["a", "b"]);
		expect(
			{
				pending: scheduler.pending.size,
				delays: scheduler.delays,
			},
		).toStrictEqual(
			{
				pending: 0,
				delays: [],
			},
		);
	});

	it("serves the previous snapshot and schedules a debounced rebuild after a foreign change", () =>
	{
		const {db, source, scheduler} = setup();
		const first = loadTreeRows(db, null);
		source.version += 1;
		expect(loadTreeRows(db, null)).toBe(first);
		expect(
			{
				pending: scheduler.pending.size,
				delays: scheduler.delays,
			},
		).toStrictEqual(
			{
				pending: 1,
				delays: [500],
			},
		);
		scheduler.runAll();
		expect(peekTreeSnapshotBuild(db)).toBe("patch");
	});

	it("skips the scheduled rebuild once the source is closed", () =>
	{
		const {db, source, scheduler} = setup();
		const first = loadTreeRows(db, null);
		insertNode(db, "b", "Beta", 1);
		scheduleTreeSnapshotRebuild(db);
		source.open = false;
		scheduler.runAll();
		expect(peekTreeSnapshotRows(db)).toBe(first);
	});

	it("warms the snapshot through the host", () =>
	{
		const {db} = setup();
		warmTreeSnapshot(db);
		expect(peekTreeSnapshotRows(db)?.map((row) => row.id)).toStrictEqual(["a"]);
	});

	it("does not cold-build a snapshot in the background after a write when none is loaded", async () =>
	{
		const {db, scheduler} = setup();
		await withTreeSnapshotRebuild(db, async () =>
		{
			insertNode(db, "b", "Beta", 1);
			await Promise.resolve();
		});
		expect(
			{
				pending: scheduler.pending.size,
				rows: peekTreeSnapshotRows(db),
			},
		).toStrictEqual(
			{
				pending: 0,
				rows: undefined,
			},
		);
	});

	it("coalesces back-to-back writes into one patch of the loaded snapshot", async () =>
	{
		const {db, scheduler} = setup();
		warmTreeSnapshot(db);
		for (const [id, name, priority] of [
			["b", "Beta", 1],
			["c", "Gamma", 2],
			["d", "Delta", 3],
		] as const)
		{
			await withTreeSnapshotRebuild(db, async () =>
			{
				insertNode(db, id, name, priority);
				await Promise.resolve();
			});
		}
		expect(scheduler.pending.size).toBe(1);
		scheduler.runAll();
		expect(
			{
				build: peekTreeSnapshotBuild(db),
				ids: peekTreeSnapshotRows(db)?.map((row) => row.id),
				pending: scheduler.pending.size,
			},
		).toStrictEqual(
			{
				build: "patch",
				ids: ["a", "b", "c", "d"],
				pending: 0,
			},
		);
	});
});
