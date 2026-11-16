import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {join} from "node:path";
import {describe, expect, it} from "vite-plus/test";
import {AccountOutboxRecorder, readPendingAccountOutbox} from "../src/cache/account-outbox.js";
import {readAccountSnapshot, writeAccountSnapshot} from "../src/cache/account-store.js";
import {CacheService} from "../src/cache/cache-service.js";
import {backfillCalendarMetadata} from "../src/cache/calendar-metadata-backfill.js";
import {readNodeInternalMetadata, storeInternalMetadata} from "../src/cache/internal-metadata.js";
import {LocalAccount} from "../src/cache/local-account.js";
import {LocalTreeWriter} from "../src/cache/local-tree-writer.js";
import {runUnitOfWork} from "../src/cache/node-composite.js";
import {OutboxRecorder, readPendingOutbox} from "../src/cache/outbox.js";
import * as schema from "../src/db/schema.js";

const migrationsFolder = join(import.meta.dirname, "../src/db/migrations");
const CAL = "cal";
const ROOT_META =
{
	calendar:
	{
		root: true,
	},
};
const oct1 = new Date(2026, 9, 1).getTime();
const oct17 = new Date(2026, 9, 17).getTime();

/**
 * A mirror's local tables holding `children` (parent -> ids, `home` for Home) with `metadata`, and root metadata
 * `calendar` (absent when undefined); the backfill writes through a writer and an account that record outbox rows.
 */
function setup(
	children: Record<string, string[]>,
	metadata: Record<string, Record<string, unknown>>,
	calendar?: Record<string, unknown>,
)
{
	const db = drizzle(
		new DatabaseConstructor(":memory:"),
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
	runUnitOfWork(db, (unitOfWork) =>
	{
		writeAccountSnapshot(
			unitOfWork,
			{
				account:
				{
					userId: "42",
					dateJoinedSec: 1_500_000_000,
				},
				rootMetadata:
					calendar === undefined
						? {}
						:
							{
								calendar,
							},
				settings: {},
				visibleFeatures: [],
			},
		);
	});
	const cache = new CacheService(db);
	const insert = (parent: string) =>
	{
		for (const [index, id] of (children[parent] ?? []).entries())
		{
			cache.insertNode(
				{
					id,
					name: id,
					note: null,
					priority: index,
					createdAt: 1_600_000_000,
					modifiedAt: 1_600_000_000,
					completedAt: null,
				},
				parent === "home" ? null : parent,
			);
			insert(id);
		}
	};
	insert("home");
	storeInternalMetadata(db, new Map(Object.entries(metadata)));
	const run = async (force = false) =>
		backfillCalendarMetadata(
			{
				db,
				writer: new LocalTreeWriter(
					db,
					{
						outbox: new OutboxRecorder(),
					},
				),
				account: new LocalAccount(
					db,
					{
						outbox: new AccountOutboxRecorder(),
					},
				),
				force,
			},
		);
	return {
		run,
		/** A node's calendar metadata now. */
		calendarOf: (id: string) => readNodeInternalMetadata(db, id).calendar,
		/** The pending rows: node metadata ids, and root metadata paths. */
		pending: () => (
		{
			nodes: readPendingOutbox(db, 100).map(({nodeId, aspect}) => `${nodeId}:${aspect}`),
			root: readPendingAccountOutbox(db).map(({subject, key}) => `${subject}:${key.replaceAll("\u001F", ".")}`),
		}),
		rootCalendar: () => readAccountSnapshot(db)?.rootMetadata.calendar,
	};
}

describe("backfillCalendarMetadata", () =>
{
	it("adds timestamps from the ancestor values, then dateIds from the timestamps, and sets both flags locally, each with outbox rows", async () =>
	{
		const {run, calendarOf, pending, rootCalendar} = setup(
			{
				home: [CAL],
				[CAL]: ["y"],
				y: ["m"],
				m: ["d", "entry"],
				d: ["child"],
			},
			{
				[CAL]: ROOT_META,
				y:
				{
					calendar:
					{
						level: "year",
						value: "2026",
						timestamp: new Date(2026, 0, 1).getTime(),
						dateId: 20_260_000,
					},
				},
				m:
				{
					calendar:
					{
						level: "month",
						value: "10",
						timestamp: oct1,
					},
				},
				d:
				{
					calendar:
					{
						level: "day",
						value: "17",
					},
				},
			},
			{
				rootId: CAL,
			},
		);

		const result = await run();

		expect(
			{
				result,
				month: calendarOf("m"),
				day: calendarOf("d"),
				rootCalendar: rootCalendar(),
				pending: pending(),
			},
		).toStrictEqual(
			{
				result:
				{
					timestamps: ["d"],
					dateIds: ["m", "d"],
				},
				month:
				{
					level: "month",
					value: "10",
					timestamp: oct1,
					dateId: 20_261_000,
				},
				day:
				{
					level: "day",
					value: "17",
					timestamp: oct17,
					dateId: 20_261_017,
				},
				rootCalendar:
				{
					rootId: CAL,
					ts_added_v2: true,
					dateId_added_v1: true,
				},
				pending:
				{
					nodes: ["d:metadata", "m:metadata"],
					root: ["root_metadata:calendar.ts_added_v2", "root_metadata:calendar.dateId_added_v1"],
				},
			},
		);
	});

	it("does nothing once both flags are set, and reruns both backfills when forced", async () =>
	{
		const {run, pending} = setup(
			{
				home: [CAL],
				[CAL]: ["y"],
			},
			{
				[CAL]: ROOT_META,
				y:
				{
					calendar:
					{
						level: "year",
						value: "2026",
					},
				},
			},
			{
				rootId: CAL,
				ts_added_v2: true,
				dateId_added_v1: true,
			},
		);

		const unforced = await run();
		const unforcedPending = pending();
		const forced = await run(true);

		expect(
			{
				unforced,
				unforcedPending,
				forced,
				pending: pending(),
			},
		).toStrictEqual(
			{
				unforced:
				{
					timestamps: [],
					dateIds: [],
				},
				unforcedPending:
				{
					nodes: [],
					root: [],
				},
				forced:
				{
					timestamps: ["y"],
					dateIds: ["y"],
				},
				pending:
				{
					nodes: ["y:metadata"],
					root: [],
				},
			},
		);
	});

	it("tags the calendar.rootId node as the root when it has no calendar metadata", async () =>
	{
		const {run, calendarOf, pending} = setup(
			{
				home: ["plain"],
			},
			{},
			{
				rootId: "plain",
				ts_added_v2: false,
				dateId_added_v1: true,
			},
		);

		await run();

		expect(
			{
				root: calendarOf("plain"),
				pending: pending(),
			},
		).toStrictEqual(
			{
				root:
				{
					root: true,
				},
				pending:
				{
					nodes: ["plain:metadata"],
					root: ["root_metadata:calendar.ts_added_v2"],
				},
			},
		);
	});

	it("only sets the flags when root metadata names no calendar root", async () =>
	{
		const {run, pending, rootCalendar} = setup(
			{
				home: [CAL],
				[CAL]: ["d"],
			},
			{
				[CAL]: ROOT_META,
				d:
				{
					calendar:
					{
						level: "day",
						value: "17",
					},
				},
			},
		);

		const result = await run();

		expect(
			{
				result,
				rootCalendar: rootCalendar(),
				pending: pending(),
			},
		).toStrictEqual(
			{
				result:
				{
					timestamps: [],
					dateIds: [],
				},
				rootCalendar:
				{
					ts_added_v2: true,
					dateId_added_v1: true,
				},
				pending:
				{
					nodes: [],
					root: ["root_metadata:calendar.ts_added_v2", "root_metadata:calendar.dateId_added_v1"],
				},
			},
		);
	});

	it("walks past week ancestors and skips nodes it cannot date", async () =>
	{
		const {run, calendarOf} = setup(
			{
				home: [CAL],
				[CAL]: ["y"],
				y: ["m"],
				m: ["w", "loose"],
				w: ["d"],
			},
			{
				[CAL]: ROOT_META,
				y:
				{
					calendar:
					{
						level: "year",
						value: "2026",
						timestamp: new Date(2026, 0, 1).getTime(),
						dateId: 20_260_000,
					},
				},
				m:
				{
					calendar:
					{
						level: "month",
						value: "10",
						timestamp: oct1,
						dateId: 20_261_000,
					},
				},
				w:
				{
					calendar:
					{
						level: "week",
						value: "42",
					},
				},
				d:
				{
					calendar:
					{
						level: "day",
						value: "17",
					},
				},
				loose:
				{
					calendar:
					{
						level: "fortnight",
					},
				},
			},
			{
				rootId: CAL,
				dateId_added_v1: true,
			},
		);

		const result = await run();

		expect(
			{
				result,
				day: calendarOf("d"),
				loose: calendarOf("loose"),
			},
		).toStrictEqual(
			{
				result:
				{
					timestamps: ["d"],
					dateIds: [],
				},
				day:
				{
					level: "day",
					value: "17",
					timestamp: oct17,
				},
				loose:
				{
					level: "fortnight",
				},
			},
		);
	});
});
