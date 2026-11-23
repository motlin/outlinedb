import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {and, asc, eq} from "drizzle-orm";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {LocalCalendar} from "../src/cache/local-calendar.js";
import {LocalTreeWriter} from "../src/cache/local-tree-writer.js";
import {runUnitOfWork} from "../src/cache/node-composite.js";
import {readPendingAccountOutbox} from "../src/cache/account-outbox.js";
import
{
	listPendingOutbox,
	OutboxRecorder,
	outboxStatus,
	readLeftOutRows,
	readPendingOutbox,
} from "../src/cache/outbox.js";
import type {OutboxAspect} from "../src/cache/outbox.js";
import * as schema from "../src/db/schema.js";
import {mirrors, nodeContent, nodeMetadata, outbox} from "../src/db/schema.js";
import {OutboxNotAcknowledged} from "../src/internal/errors.js";
import {calendarNodeId, calendarRootId} from "../src/internal/calendar-ids.js";
import {drainOutbox, settleLeftOutRows} from "../src/internal/outbox-drain.js";
import type {OutboxPusher, UpstreamNode} from "../src/internal/outbox-drain.js";
import type {InternalOp} from "../src/internal/push-and-poll.js";
import {FAR_FUTURE_DATE, parseTemporalTimestamp, systemTimeAt} from "../src/temporal/constants.js";
import {migratedMemoryDatabase} from "./helpers/migrated-memory-database.js";

const SEEDED_AT = systemTimeAt("2026-01-01 00:00:00.000");
const SEEDED = new Date("2026-01-01T00:00:00.000Z");
/** The account's join date: 2026-01-01T00:00:00Z. */
const JOINED_SEC = 1_767_225_600;
const USER_ID = 42;
/** When each test's drain runs. */
const DRAIN = systemTimeAt("2026-03-02 00:00:00.000");
/** The drain's client timestamp: 60 days after the join date. */
const CT = 60 * 86_400;

/** Home holds p and q; p holds a, b and c; c holds c1; q holds x and m, which mirrors c1. */
const SEED: [id: string, parentId: string | null, key: string][] = [
	["p", null, "a0"],
	["q", null, "a1"],
	["a", "p", "a0"],
	["b", "p", "a1"],
	["c", "p", "a2"],
	["c1", "c", "a0"],
	["x", "q", "a0"],
	["m", "q", "a1"],
];

/** The system time `seconds` after 2026-03-01 00:00:00 UTC, when the test's writes start. */
function at(seconds: number): number
{
	return systemTimeAt(`2026-03-01 00:00:${String(seconds).padStart(2, "0")}.000`);
}

function setClock(systemTime: number): void
{
	vi.setSystemTime(parseTemporalTimestamp(systemTime));
}

function setup()
{
	const sqlite = migratedMemoryDatabase();
	const database = drizzle(
		sqlite,
		{
			schema,
		},
	);
	database
		.insert(nodeContent)
		.values(
			SEED.map(([id, parentId]) => (
			{
				id,
				name: id === "m" ? null : id,
				note: null,
				parentId,
				systemFrom: SEEDED_AT,
				systemTo: FAR_FUTURE_DATE,
			})),
		)
		.run();
	database
		.insert(nodeMetadata)
		.values(
			SEED.map(([id, , orderKey]) => (
			{
				nodeId: id,
				shortId: id.padStart(12, "0"),
				orderKey,
				createdAt: SEEDED,
				modifiedAt: SEEDED,
				systemFrom: SEEDED_AT,
				systemTo: FAR_FUTURE_DATE,
			})),
		)
		.run();
	database
		.insert(mirrors)
		.values(
			{
				mirrorId: "m",
				originalId: "c1",
				systemFrom: SEEDED_AT,
				systemTo: FAR_FUTURE_DATE,
			},
		)
		.run();

	let generated = 0;
	const generateId = () =>
	{
		generated += 1;
		return `g${generated}`;
	};
	const writer = new LocalTreeWriter(
		database,
		{
			outbox: new OutboxRecorder(),
			generateId,
		},
	);
	const outboxRows = () =>
		database.select().from(outbox).orderBy(asc(outbox.nodeId), asc(outbox.aspect), asc(outbox.systemFrom)).all();

	const pushes: InternalOp[][] = [];
	const upstreamReads: string[] = [];
	/**
	 * A pusher whose server run is `respond`'s ops (by default every op pushed), or which fails with its error.
	 * `beforeAccept` runs between the push and its acknowledgement. `upstream` is what workflowy.com holds for the ids
	 * the drain reads back (null: absent); reading any other id fails. `remote` is the reply's one remote transaction.
	 */
	const pusher = (
		respond: (ops: InternalOp[]) => InternalOp[] | Error = (ops) => ops,
		beforeAccept: () => void = () =>
		{
		},
		upstream: Record<string, UpstreamNode | null> = {},
		remote: (ops: InternalOp[]) => InternalOp[] = () => [],
	): OutboxPusher => (
	{
		upstreamNode: async (id) =>
		{
			upstreamReads.push(id);
			const node = upstream[id];
			return node === undefined
				? Promise.reject(new Error(`unexpected upstream read of ${id}`))
				: Promise.resolve(node);
		},
		session: async () =>
			Promise.resolve(
				{
					userId: USER_ID,
					dateJoinedSec: JOINED_SEC,
				},
			),
		push: async (ops, accept) =>
		{
			pushes.push(ops);
			const serverRun = respond(ops);
			if (serverRun instanceof Error)
			{
				return Promise.reject(serverRun);
			}
			beforeAccept();
			runUnitOfWork(database, (unitOfWork) =>
			{
				accept(
					unitOfWork,
					{
						txId: "2",
						serverRun,
						remote: [
							{
								id: "1",
								ops: remote(ops),
							},
						],
						needsRefresh: false,
					},
				);
			});
			return Promise.resolve();
		},
	});

	const drain = async (target = pusher(), time = DRAIN) =>
	{
		setClock(time);
		return drainOutbox(database, target);
	};

	return {
		database,
		writer,
		generateId,
		outboxRows,
		pushes,
		upstreamReads,
		pusher,
		drain,
	};
}

/** An outbox row first enqueued at `enqueuedAt`, closed by the drain unless `systemTo` says otherwise. */
function row(
	nodeId: string,
	aspect: OutboxAspect,
	enqueuedAt: number,
	{
		systemFrom = enqueuedAt,
		systemTo = DRAIN,
		lastError = null,
		leftOutOp = null,
	}:
	{
		systemFrom?: number;
		systemTo?: number;
		lastError?: string | null;
		leftOutOp?: string | null;
	} = {},
)
{
	return {
		nodeId,
		aspect,
		enqueuedAt,
		lastError,
		leftOutOp,
		systemFrom,
		systemTo,
	};
}

const NO_PREVIOUS =
{
	previous_last_modified: null,
	previous_last_modified_by: null,
};

function bulkCreate(
	id: string,
	parentId: string,
	index: number,
	{
		name = id,
		metadata,
	}:
	{
		name?: string;
		metadata?: Record<string, unknown>;
	} = {},
): InternalOp
{
	return {
		type: "bulk_create",
		data:
		{
			parentid: parentId,
			starting_priority: index,
			project_trees: JSON.stringify([
				{
					id,
					nm: name,
					...(metadata === undefined
						? {}
						:
							{
								metadata,
							}),
					ct: CT,
					cb: USER_ID,
					ch: [],
				},
			]),
			isForSearch: false,
		},
		client_timestamp: CT,
		undo_data: {},
	};
}

/** A metadata-only `edit` of `id`. */
function metadataEdit(id: string, patches: unknown[], inverse: unknown[], clientTimestamp = CT): InternalOp
{
	return {
		type: "edit",
		data:
		{
			projectid: id,
			metadataPatches: patches,
			metadataInversePatches: inverse,
		},
		client_timestamp: clientTimestamp,
		undo_data:
		{
			...NO_PREVIOUS,
			metadataPatches: inverse,
		},
	};
}

/** A rename of `id` from `previous` to `name`. */
function rename(id: string, name: string, previous: string, clientTimestamp = CT): InternalOp
{
	return {
		type: "edit",
		data:
		{
			projectid: id,
			name,
			metadataPatches: [],
			metadataInversePatches: [],
		},
		client_timestamp: clientTimestamp,
		undo_data:
		{
			...NO_PREVIOUS,
			previous_name: previous,
			metadataPatches: [],
		},
	};
}

describe("drainOutbox", () =>
{
	beforeEach(() =>
	{
		vi.useFakeTimers(
			{
				toFake: ["Date"],
				now: new Date("2026-03-01T00:00:00.000Z"),
			},
		);
	});

	afterEach(() =>
	{
		vi.useRealTimers();
	});

	it("creates parents before children and siblings in order-key order, each at its index among upstream siblings, then closes every row", async () =>
	{
		const {writer, outboxRows, pushes, drain} = setup();
		setClock(at(0));
		writer.createAt(
			{
				parentId: "p",
				index: 0,
				id: "n2",
				name: "n2",
			},
		);
		setClock(at(1));
		writer.createAt(
			{
				parentId: "p",
				index: 0,
				id: "n1",
				name: "n1",
			},
		);
		setClock(at(2));
		writer.createAt(
			{
				parentId: "n2",
				id: "k",
				name: "k",
			},
		);
		setClock(at(3));
		writer.createAt(
			{
				parentId: "q",
				id: "y",
				name: "y",
			},
		);

		const result = await drain();

		expect(
			{
				result,
				pushes,
				outbox: outboxRows(),
			},
		).toStrictEqual(
			{
				result:
				{
					ops: 4,
					closed: 8,
					flagged: 0,
				},
				pushes: [
					[
						bulkCreate("n1", "p", 0),
						bulkCreate("n2", "p", 1),
						bulkCreate("k", "n2", 0),
						bulkCreate("y", "q", 2),
					],
				],
				outbox: [
					row("k", "create", at(2)),
					row("k", "placement", at(2)),
					row("n1", "create", at(1)),
					row("n1", "placement", at(1)),
					row("n2", "create", at(0)),
					row("n2", "placement", at(0)),
					row("y", "create", at(3)),
					row("y", "placement", at(3)),
				],
			},
		);
	});

	it("sends placements, then name, note and metadata edits, then completions, against what upstream holds", async () =>
	{
		const {writer, outboxRows, pushes, drain} = setup();
		setClock(at(0));
		writer.moveTo(
			{
				ids: ["x"],
				parentId: "p",
				index: 1,
			},
		);
		setClock(at(1));
		writer.updateNode(
			"a",
			{
				name: "A",
				layoutMode: "board",
			},
		);
		setClock(at(2));
		writer.updateNode(
			"b",
			{
				note: "nb",
			},
		);
		setClock(at(3));
		writer.completeNode("c");

		const result = await drain();

		expect(
			{
				result,
				pushes,
				outbox: outboxRows(),
			},
		).toStrictEqual(
			{
				result:
				{
					ops: 4,
					closed: 5,
					flagged: 0,
				},
				pushes: [
					[
						{
							type: "move",
							data:
							{
								projectid: "x",
								parentid: "p",
								priority: 1,
							},
							client_timestamp: CT,
							undo_data:
							{
								previous_parentid: "q",
								previous_priority: 0,
								...NO_PREVIOUS,
							},
						},
						{
							type: "edit",
							data:
							{
								projectid: "a",
								name: "A",
								metadataPatches: [
									{
										op: "add",
										path: ["layoutMode"],
										value: "board",
									},
								],
								metadataInversePatches: [
									{
										op: "remove",
										path: ["layoutMode"],
									},
								],
							},
							client_timestamp: CT,
							undo_data:
							{
								...NO_PREVIOUS,
								previous_name: "a",
								metadataPatches: [
									{
										op: "remove",
										path: ["layoutMode"],
									},
								],
							},
						},
						{
							type: "edit",
							data:
							{
								projectid: "b",
								description: "nb",
								metadataPatches: [],
								metadataInversePatches: [],
							},
							client_timestamp: CT,
							undo_data:
							{
								...NO_PREVIOUS,
								previous_description: "",
								metadataPatches: [],
							},
						},
						{
							type: "complete",
							data:
							{
								projectid: "c",
							},
							client_timestamp: CT,
							undo_data:
							{
								...NO_PREVIOUS,
								previous_completed: false,
							},
						},
					],
				],
				outbox: [
					row("a", "metadata", at(1)),
					row("a", "name", at(1)),
					row("b", "note", at(2)),
					row("c", "completion", at(3)),
					row("x", "placement", at(0)),
				],
			},
		);
	});

	it("sends a coalesced rename once with its latest name, and closes a rename back to upstream's name without sending it", async () =>
	{
		const {writer, outboxRows, pushes, drain} = setup();
		setClock(at(0));
		writer.updateNode(
			"a",
			{
				name: "A1",
			},
		);
		setClock(at(1));
		writer.updateNode(
			"a",
			{
				name: "A2",
			},
		);
		setClock(at(2));
		writer.updateNode(
			"c",
			{
				name: "C",
			},
		);
		setClock(at(3));
		writer.updateNode(
			"c",
			{
				name: "c",
			},
		);

		const result = await drain();

		expect(
			{
				result,
				pushes,
				outbox: outboxRows(),
			},
		).toStrictEqual(
			{
				result:
				{
					ops: 1,
					closed: 2,
					flagged: 0,
				},
				pushes: [
					[
						{
							type: "edit",
							data:
							{
								projectid: "a",
								name: "A2",
								metadataPatches: [],
								metadataInversePatches: [],
							},
							client_timestamp: CT,
							undo_data:
							{
								...NO_PREVIOUS,
								previous_name: "a",
								metadataPatches: [],
							},
						},
					],
				],
				outbox: [row("a", "name", at(0)), row("c", "name", at(2))],
			},
		);
	});

	it("sends nothing for a node created and deleted before the drain, only the delete for a renamed node it deleted, and a sibling's move against upstream still holding the deleted node", async () =>
	{
		const {writer, outboxRows, pushes, drain} = setup();
		setClock(at(0));
		writer.createAt(
			{
				parentId: "p",
				id: "n",
				name: "n",
			},
		);
		setClock(at(1));
		writer.deleteNode("n");
		setClock(at(2));
		writer.updateNode(
			"b",
			{
				name: "B",
			},
		);
		setClock(at(3));
		writer.deleteNode("b");
		setClock(at(4));
		writer.moveTo(
			{
				ids: ["a"],
				parentId: "p",
				index: 2,
			},
		);

		const result = await drain();

		expect(
			{
				result,
				pushes,
				outbox: outboxRows(),
			},
		).toStrictEqual(
			{
				result:
				{
					ops: 2,
					closed: 6,
					flagged: 0,
				},
				pushes: [
					[
						{
							type: "move",
							data:
							{
								projectid: "a",
								parentid: "p",
								priority: 2,
							},
							client_timestamp: CT,
							undo_data:
							{
								previous_parentid: "p",
								previous_priority: 0,
								...NO_PREVIOUS,
							},
						},
						{
							type: "delete",
							data:
							{
								projectid: "b",
							},
							client_timestamp: CT,
							undo_data:
							{
								...NO_PREVIOUS,
								parentid: "p",
								priority: 0,
							},
						},
					],
				],
				outbox: [
					row("a", "placement", at(4)),
					row("b", "delete", at(3)),
					row("b", "name", at(2)),
					row("n", "create", at(0)),
					row("n", "delete", at(1)),
					row("n", "placement", at(0)),
				],
			},
		);
	});

	it("pushes nothing and closes the rows when a node created and deleted is all that is pending", async () =>
	{
		const {writer, outboxRows, pushes, drain} = setup();
		setClock(at(0));
		writer.createAt(
			{
				parentId: "p",
				id: "n",
				name: "n",
			},
		);
		setClock(at(1));
		writer.deleteNode("n");

		const result = await drain();

		expect(
			{
				result,
				pushes,
				outbox: outboxRows(),
			},
		).toStrictEqual(
			{
				result:
				{
					ops: 0,
					closed: 3,
					flagged: 0,
				},
				pushes: [],
				outbox: [row("n", "create", at(0)), row("n", "delete", at(1)), row("n", "placement", at(0))],
			},
		);
	});

	it("records a failed push as last_error on every row it carried, keeps them pending, surfaces it in the status, and throws", async () =>
	{
		const {database, writer, outboxRows, pushes, pusher, drain} = setup();
		setClock(at(0));
		writer.updateNode(
			"a",
			{
				name: "A",
			},
		);

		await expect(drain(pusher(() => new Error("offline")))).rejects.toThrow("offline");
		// The same failure again leaves the rows as they are: a repeat writes no new version.
		setClock(systemTimeAt("2026-03-02 00:01:00.000"));
		await expect(
			drainOutbox(
				database,
				pusher(() => new Error("offline")),
			),
		).rejects.toThrow("offline");

		expect(
			{
				pushes: pushes.length,
				outbox: outboxRows(),
				status: outboxStatus(database),
			},
		).toStrictEqual(
			{
				pushes: 2,
				outbox: [
					row("a", "name", at(0)),
					row(
						"a",
						"name",
						at(0),
						{
							systemFrom: DRAIN,
							systemTo: FAR_FUTURE_DATE,
							lastError: "offline",
						},
					),
				],
				status:
				{
					pending: 1,
					flagged: 0,
					oldestEnqueuedAt: at(0),
					lastError: "offline",
				},
			},
		);
	});

	it("records a failed session fetch as last_error on every pending row, keeps them pending, and throws", async () =>
	{
		const {database, writer, outboxRows, pushes, pusher, drain} = setup();
		setClock(at(0));
		writer.updateNode(
			"a",
			{
				name: "A",
			},
		);

		await expect(
			drain(
				{
					...pusher(),
					session: async () => Promise.reject(new Error("workflowy.com is down")),
				},
			),
		).rejects.toThrow("workflowy.com is down");

		expect(
			{
				pushes: pushes.length,
				outbox: outboxRows(),
				status: outboxStatus(database),
			},
		).toStrictEqual(
			{
				pushes: 0,
				outbox: [
					row("a", "name", at(0)),
					row(
						"a",
						"name",
						at(0),
						{
							systemFrom: DRAIN,
							systemTo: FAR_FUTURE_DATE,
							lastError: "workflowy.com is down",
						},
					),
				],
				status:
				{
					pending: 1,
					flagged: 0,
					oldestEnqueuedAt: at(0),
					lastError: "workflowy.com is down",
				},
			},
		);
	});

	it("keeps the rows pending with last_error when the server run does not echo every op", async () =>
	{
		const {writer, outboxRows, pusher, drain} = setup();
		setClock(at(0));
		writer.updateNode(
			"a",
			{
				name: "A",
			},
		);

		await expect(drain(pusher(() => []))).rejects.toThrow(OutboxNotAcknowledged);

		expect(outboxRows()).toStrictEqual([
			row("a", "name", at(0)),
			row(
				"a",
				"name",
				at(0),
				{
					systemFrom: DRAIN,
					systemTo: FAR_FUTURE_DATE,
					lastError: new OutboxNotAcknowledged(1, 0, ["edit a"]).message,
				},
			),
		]);
	});

	it("closes every row when the server run leaves out ops whose effect workflowy.com already holds: creates of nodes it has, deletes of nodes it lacks", async () =>
	{
		const {writer, outboxRows, pushes, upstreamReads, pusher, drain} = setup();
		setClock(at(0));
		writer.createAt(
			{
				parentId: "p",
				index: 0,
				id: "n",
				name: "n",
			},
		);
		setClock(at(1));
		writer.updateNode(
			"a",
			{
				name: "A",
			},
		);
		setClock(at(2));
		writer.deleteNode("b");

		const result = await drain(
			pusher(
				(ops) => ops.filter(({type}) => type === "edit"),
				undefined,
				{
					n:
					{
						parentId: "p",
					},
					b: null,
				},
			),
		);

		expect(
			{
				result,
				pushes,
				upstreamReads,
				outbox: outboxRows(),
			},
		).toStrictEqual(
			{
				result:
				{
					ops: 3,
					closed: 4,
					flagged: 0,
				},
				pushes: [
					[
						bulkCreate("n", "p", 0),
						rename("a", "A", "a"),
						{
							type: "delete",
							data:
							{
								projectid: "b",
							},
							client_timestamp: CT,
							undo_data:
							{
								...NO_PREVIOUS,
								parentid: "p",
								// b's index once n is in place upstream ahead of it: n, a, b, c.
								priority: 2,
							},
						},
					],
				],
				upstreamReads: ["n", "b"],
				outbox: [
					row("a", "name", at(1)),
					row("b", "delete", at(2)),
					row("n", "create", at(0)),
					row("n", "placement", at(0)),
				],
			},
		);
	});

	it("flags the rows of left-out ops it cannot read back instead of closing them, closes the rest and those the reply's remote transactions show, stops sending them, and sends a new write again", async () =>
	{
		const {database, writer, outboxRows, pushes, pusher, drain} = setup();
		setClock(at(0));
		writer.createAt(
			{
				parentId: "p",
				index: 0,
				id: "n",
				name: "n",
			},
		);
		setClock(at(1));
		writer.updateNode(
			"a",
			{
				name: "A",
			},
		);
		setClock(at(2));
		writer.completeNode("c");
		const {upstreamNode: _upstreamNode, ...blind} = pusher(
			(ops) => ops.filter(({type}) => type === "bulk_create"),
			undefined,
			undefined,
			(ops) => ops.filter(({type}) => type === "complete"),
		);

		const first = await drain(blind);
		const flaggedStatus = outboxStatus(database);
		const second = await drain(blind);
		const REWRITE = systemTimeAt("2026-03-02 00:00:01.000");
		setClock(REWRITE);
		writer.updateNode(
			"a",
			{
				name: "A2",
			},
		);
		const REDRAIN = systemTimeAt("2026-03-02 00:00:02.000");
		const third = await drain(pusher(), REDRAIN);

		const leftOut =
			"Workflowy's server run left out edit a; not sent again until a catch-up shows it or the node changes";
		expect(
			{
				results: [first, second, third],
				flaggedStatus,
				pushed: pushes.map((ops) => ops.map(({type}) => type)),
				third: pushes[1],
				outbox: outboxRows(),
				status: outboxStatus(database),
			},
		).toStrictEqual(
			{
				results: [
					{
						ops: 3,
						closed: 3,
						flagged: 1,
					},
					{
						ops: 0,
						closed: 0,
						flagged: 0,
					},
					{
						ops: 1,
						closed: 1,
						flagged: 0,
					},
				],
				flaggedStatus:
				{
					pending: 0,
					flagged: 1,
					oldestEnqueuedAt: null,
					lastError: null,
				},
				pushed: [["bulk_create", "edit", "complete"], ["edit"]],
				// The rewrite goes out against what upstream held before the left-out edit.
				third: [rename("a", "A2", "a", CT + 2)],
				outbox: [
					row("a", "name", at(1)),
					row(
						"a",
						"name",
						at(1),
						{
							systemFrom: DRAIN,
							systemTo: REWRITE,
							lastError: leftOut,
							leftOutOp: "edit",
						},
					),
					row(
						"a",
						"name",
						at(1),
						{
							systemFrom: REWRITE,
							systemTo: REDRAIN,
						},
					),
					row("c", "completion", at(2)),
					row("n", "create", at(0)),
					row("n", "placement", at(0)),
				],
				status:
				{
					pending: 0,
					flagged: 0,
					oldestEnqueuedAt: null,
					lastError: null,
				},
			},
		);
	});

	it("settles a flagged row once a catch-up shows an op of its left-out type naming its node, and only then", async () =>
	{
		const {database, writer, outboxRows, pusher, drain} = setup();
		setClock(at(0));
		writer.updateNode(
			"a",
			{
				name: "A",
			},
		);
		const {upstreamNode: _upstreamNode, ...blind} = pusher(() => []);
		await drain(blind);
		const SETTLED = systemTimeAt("2026-03-02 00:00:01.000");
		setClock(SETTLED);

		runUnitOfWork(database, (unitOfWork) =>
		{
			settleLeftOutRows(unitOfWork, [rename("b", "B", "b"), metadataEdit("b", [], [])]);
		});
		const unsettled = outboxStatus(database).flagged;
		runUnitOfWork(database, (unitOfWork) =>
		{
			settleLeftOutRows(unitOfWork, [rename("a", "A", "a")]);
		});

		expect(
			{
				unsettled,
				outbox: outboxRows(),
			},
		).toStrictEqual(
			{
				unsettled: 1,
				outbox: [
					row("a", "name", at(0)),
					row(
						"a",
						"name",
						at(0),
						{
							systemFrom: DRAIN,
							systemTo: SETTLED,
							lastError:
								"Workflowy's server run left out edit a; not sent again until a catch-up shows it or the node changes",
							leftOutOp: "edit",
						},
					),
				],
			},
		);
	});

	it("keeps every row pending, naming the ops, when a left-out op's effect is not on workflowy.com", async () =>
	{
		const {writer, outboxRows, upstreamReads, pusher, drain} = setup();
		setClock(at(0));
		writer.createAt(
			{
				parentId: "p",
				index: 0,
				id: "n",
				name: "n",
			},
		);
		setClock(at(1));
		writer.updateNode(
			"a",
			{
				name: "A",
			},
		);
		setClock(at(2));
		writer.deleteNode("b");
		const unacknowledged = new OutboxNotAcknowledged(3, 1, ["bulk_create n", "delete b"]);

		await expect(
			drain(
				pusher(
					(ops) => ops.filter(({type}) => type === "edit"),
					undefined,
					{
						n: null,
						b:
						{
							parentId: "p",
						},
					},
				),
			),
		).rejects.toThrow(unacknowledged.message);

		const pending =
		{
			systemFrom: DRAIN,
			systemTo: FAR_FUTURE_DATE,
			lastError: unacknowledged.message,
		};
		expect(
			{
				upstreamReads,
				outbox: outboxRows(),
			},
		).toStrictEqual(
			{
				upstreamReads: ["n", "b"],
				outbox: [
					row("a", "name", at(1)),
					row("a", "name", at(1), pending),
					row("b", "delete", at(2)),
					row("b", "delete", at(2), pending),
					row("n", "create", at(0)),
					row("n", "create", at(0), pending),
					row("n", "placement", at(0)),
					row("n", "placement", at(0), pending),
				],
			},
		);
	});

	it("keeps a row pending when its node changed again while the push was in flight", async () =>
	{
		const {writer, outboxRows, pusher, drain} = setup();
		setClock(at(0));
		writer.updateNode(
			"a",
			{
				name: "A1",
			},
		);
		writer.updateNode(
			"b",
			{
				name: "B",
			},
		);

		const result = await drain(
			pusher(
				(ops) => ops,
				() =>
				{
					setClock(systemTimeAt("2026-03-02 00:00:01.000"));
					writer.updateNode(
						"a",
						{
							name: "A2",
						},
					);
				},
			),
		);

		expect(
			{
				result,
				outbox: outboxRows(),
			},
		).toStrictEqual(
			{
				result:
				{
					ops: 2,
					closed: 1,
					flagged: 0,
				},
				outbox: [
					row(
						"a",
						"name",
						at(0),
						{
							systemTo: FAR_FUTURE_DATE,
						},
					),
					row(
						"b",
						"name",
						at(0),
						{
							systemTo: systemTimeAt("2026-03-02 00:00:01.000"),
						},
					),
				],
			},
		);
	});
	it("sends each new mirror's create, then one edit per original listing all its new mirrors in one patch", async () =>
	{
		const {writer, outboxRows, pushes, drain} = setup();
		setClock(at(0));
		writer.createMirrorsAt(
			{
				originalIds: ["a", "c1", "a"],
				parentId: "q",
				index: 0,
			},
		);

		const result = await drain();

		expect(
			{
				result,
				pushes,
				outbox: outboxRows(),
			},
		).toStrictEqual(
			{
				result:
				{
					ops: 5,
					closed: 9,
					flagged: 0,
				},
				pushes: [
					[
						bulkCreate(
							"g1",
							"q",
							0,
							{
								name: "",
								metadata:
								{
									mirror:
									{
										originalId: "a",
										isMirrorRoot: true,
									},
								},
							},
						),
						bulkCreate(
							"g2",
							"q",
							1,
							{
								name: "",
								metadata:
								{
									mirror:
									{
										originalId: "c1",
										isMirrorRoot: true,
									},
								},
							},
						),
						bulkCreate(
							"g3",
							"q",
							2,
							{
								name: "",
								metadata:
								{
									mirror:
									{
										originalId: "a",
										isMirrorRoot: true,
									},
								},
							},
						),
						metadataEdit(
							"a",
							[
								{
									op: "add",
									path: ["mirror"],
									value:
									{
										mirrorRootIds:
										{
											g1: true,
											g3: true,
										},
									},
								},
							],
							[
								{
									op: "remove",
									path: ["mirror"],
								},
							],
						),
						metadataEdit(
							"c1",
							[
								{
									op: "add",
									path: ["mirror", "mirrorRootIds", "g2"],
									value: true,
								},
							],
							[
								{
									op: "remove",
									path: ["mirror", "mirrorRootIds", "g2"],
								},
							],
						),
					],
				],
				outbox: [
					row("g1", "create", at(0)),
					row("g1", "mirror", at(0)),
					row("g1", "placement", at(0)),
					row("g2", "create", at(0)),
					row("g2", "mirror", at(0)),
					row("g2", "placement", at(0)),
					row("g3", "create", at(0)),
					row("g3", "mirror", at(0)),
					row("g3", "placement", at(0)),
				],
			},
		);
	});

	it("lists a pending mirror's rows under its original's name", () =>
	{
		const {database, writer} = setup();
		setClock(at(0));
		writer.createMirrorsAt(
			{
				originalIds: ["a"],
				parentId: "q",
				index: 0,
			},
		);

		expect(listPendingOutbox(database)).toStrictEqual(
			["create", "mirror", "placement"].map((aspect) => (
			{
				nodeId: "g1",
				name: "a",
				aspect,
				enqueuedAt: at(0),
				lastError: null,
				leftOutOp: null,
			})),
		);
	});

	it("holds a pending mirror whose mirrors row ended with an error instead of sending it as a plain node", async () =>
	{
		const {database, writer, outboxRows, pushes, drain} = setup();
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		setClock(at(0));
		writer.createMirrorsAt(
			{
				originalIds: ["a"],
				parentId: "q",
				index: 0,
			},
		);
		writer.updateNode(
			"b",
			{
				name: "B",
			},
		);
		// An import that missed the pending mirror ended its row.
		database
			.update(mirrors)
			.set(
				{
					systemTo: at(1),
				},
			)
			.where(and(eq(mirrors.mirrorId, "g1"), eq(mirrors.systemTo, FAR_FUTURE_DATE)))
			.run();
		const error =
			"Mirror g1 of a lost its mirrors row while its mirror write was pending; not sending it as a plain node";

		const result = await drain();

		expect(
			{
				result,
				pushes,
				outbox: outboxRows(),
				logged: logged.mock.calls,
			},
		).toStrictEqual(
			{
				result:
				{
					ops: 1,
					closed: 1,
					flagged: 0,
				},
				pushes: [[rename("b", "B", "b")]],
				outbox: [
					row("b", "name", at(0)),
					row("g1", "create", at(0)),
					row(
						"g1",
						"create",
						at(0),
						{
							systemFrom: DRAIN,
							systemTo: FAR_FUTURE_DATE,
							lastError: error,
						},
					),
					row("g1", "mirror", at(0)),
					row(
						"g1",
						"mirror",
						at(0),
						{
							systemFrom: DRAIN,
							systemTo: FAR_FUTURE_DATE,
							lastError: error,
						},
					),
					row("g1", "placement", at(0)),
					row(
						"g1",
						"placement",
						at(0),
						{
							systemFrom: DRAIN,
							systemTo: FAR_FUTURE_DATE,
							lastError: error,
						},
					),
				],
				logged: [[`[OUTBOX] ${error}`]],
			},
		);
	});

	it("sends a backlink's references root, item and source listing, then the item's delete and the source's unlisting", async () =>
	{
		const {database, writer, outboxRows, pushes, pusher} = setup();
		const link = '<a href="https://workflowy.com/#/00000000000b">b</a>';
		setClock(at(0));
		writer.updateNode(
			"a",
			{
				name: link,
			},
		);
		setClock(at(1));
		writer.syncBacklinks(["a"]);
		setClock(DRAIN);
		const linked = await drainOutbox(database, pusher());
		const UNLINKED = systemTimeAt("2026-03-02 00:00:10.000");
		setClock(UNLINKED);
		writer.updateNode(
			"a",
			{
				name: "a",
			},
		);
		const UNSYNCED = systemTimeAt("2026-03-02 00:00:11.000");
		setClock(UNSYNCED);
		writer.syncBacklinks(["a"]);
		const SECOND_DRAIN = systemTimeAt("2026-03-02 00:01:00.000");
		setClock(SECOND_DRAIN);
		const unlinked = await drainOutbox(database, pusher());
		const secondCt = CT + 60;

		expect(
			{
				linked,
				unlinked,
				pushes,
				outbox: outboxRows(),
			},
		).toStrictEqual(
			{
				linked:
				{
					ops: 4,
					closed: 6,
					flagged: 0,
				},
				unlinked:
				{
					ops: 3,
					closed: 3,
					flagged: 0,
				},
				pushes: [
					[
						bulkCreate(
							"g1",
							"b",
							0,
							{
								name: "",
								metadata:
								{
									isReferencesRoot: true,
								},
							},
						),
						bulkCreate(
							"g2",
							"g1",
							0,
							{
								name: "",
								metadata:
								{
									mirror:
									{
										originalId: "a",
										isMirrorRoot: true,
									},
									backlink:
									{
										sourceID: "a",
										targetID: "b",
									},
								},
							},
						),
						rename("a", link, "a"),
						metadataEdit(
							"a",
							[
								{
									op: "add",
									path: ["mirror"],
									value:
									{
										backlinkMirrorRootIds:
										{
											g2: true,
										},
									},
								},
							],
							[
								{
									op: "remove",
									path: ["mirror"],
								},
							],
						),
					],
					[
						rename("a", "a", link, secondCt),
						metadataEdit(
							"a",
							[
								{
									op: "remove",
									path: ["mirror", "backlinkMirrorRootIds", "g2"],
								},
							],
							[
								{
									op: "add",
									path: ["mirror", "backlinkMirrorRootIds", "g2"],
									value: true,
								},
							],
							secondCt,
						),
						{
							type: "delete",
							data:
							{
								projectid: "g2",
							},
							client_timestamp: secondCt,
							undo_data:
							{
								...NO_PREVIOUS,
								parentid: "g1",
								priority: 0,
							},
						},
					],
				],
				outbox: [
					row(
						"a",
						"mirror",
						UNSYNCED,
						{
							systemTo: SECOND_DRAIN,
						},
					),
					row("a", "name", at(0)),
					row(
						"a",
						"name",
						UNLINKED,
						{
							systemTo: SECOND_DRAIN,
						},
					),
					row("g1", "create", at(1)),
					row("g1", "placement", at(1)),
					row("g2", "create", at(1)),
					row(
						"g2",
						"delete",
						UNSYNCED,
						{
							systemTo: SECOND_DRAIN,
						},
					),
					row("g2", "mirror", at(1)),
					row("g2", "placement", at(1)),
				],
			},
		);
	});

	it("sends a metadata write at upstream key paths as one edit of the node's metadata", async () =>
	{
		const {writer, outboxRows, pushes, drain} = setup();
		setClock(at(0));
		writer.setNodeMetaValues("p", [
			{
				path: ["calendar", "found_dates"],
				value: false,
			},
		]);

		const result = await drain();

		expect(
			{
				result,
				pushes,
				outbox: outboxRows(),
			},
		).toStrictEqual(
			{
				result:
				{
					ops: 1,
					closed: 1,
					flagged: 0,
				},
				pushes: [
					[
						metadataEdit(
							"p",
							[
								{
									op: "add",
									path: ["calendar"],
									value:
									{
										found_dates: false,
									},
								},
							],
							[
								{
									op: "remove",
									path: ["calendar"],
								},
							],
						),
					],
				],
				outbox: [row("p", "metadata", at(0))],
			},
		);
	});

	it("creates a calendar root and day chain with their deterministic ids and calendar metadata at midnight in the account timezone", async () =>
	{
		const {database, generateId, outboxRows, pushes, drain} = setup();
		const rootMeta: unknown[] = [];
		const calendar = new LocalCalendar(
			database,
			{
				outbox: new OutboxRecorder(),
				generateId,
				account:
				{
					getEntropyKey: async () => Promise.resolve("entropy"),
					getRootMeta: async () => Promise.resolve(undefined),
					getSetting: async (name) => Promise.resolve(name === "timezone" ? "America/New_York" : undefined),
					setRootMetaValues: async (changes) =>
					{
						rootMeta.push(...changes);
						return Promise.resolve();
					},
				},
			},
		);
		setClock(at(0));
		const ensured = await calendar.ensureCalendarDay(
			20_260_301,
			{
				createChild: false,
			},
		);
		const rootId = calendarRootId("entropy");
		const yearId = calendarNodeId("entropy", "year", 20_260_000);
		const monthId = calendarNodeId("entropy", "month", 20_260_300);
		const dayId = calendarNodeId("entropy", "day", 20_260_301);

		const result = await drain();

		expect(
			{
				ensured,
				rootMeta,
				result,
				pushes,
				outbox: outboxRows(),
			},
		).toStrictEqual(
			{
				ensured:
				{
					dayId,
					firstChildId: null,
					created: [yearId, monthId, dayId],
				},
				rootMeta: [
					{
						path: ["calendar", "rootId"],
						value: rootId,
					},
				],
				result:
				{
					ops: 4,
					closed: 6,
					flagged: 0,
				},
				pushes: [
					[
						bulkCreate(
							rootId,
							"None",
							2,
							{
								name: "📆 Calendar",
								metadata:
								{
									calendar:
									{
										root: true,
									},
									restorableUniqueNode: true,
								},
							},
						),
						bulkCreate(
							yearId,
							rootId,
							0,
							{
								name: "2026",
								metadata:
								{
									calendar:
									{
										level: "year",
										value: "2026",
										dateId: 20_260_000,
										timestamp: 1_767_243_600_000,
									},
									restorableUniqueNode: true,
								},
							},
						),
						bulkCreate(
							monthId,
							yearId,
							0,
							{
								name: "3",
								metadata:
								{
									calendar:
									{
										level: "month",
										value: "3",
										dateId: 20_260_300,
										timestamp: 1_772_341_200_000,
									},
									restorableUniqueNode: true,
								},
							},
						),
						bulkCreate(
							dayId,
							monthId,
							0,
							{
								name: '<time startYear="2026" startMonth="3" startDay="1">Sun, Mar 1, 2026</time>',
								metadata:
								{
									calendar:
									{
										level: "day",
										value: "1",
										dateId: 20_260_301,
										timestamp: 1_772_341_200_000,
									},
									restorableUniqueNode: true,
								},
							},
						),
					],
				],
				// The chain's top is placed under the root; the levels nested under it carry their slot in their create.
				outbox: [
					row(yearId, "create", at(0)),
					row(yearId, "placement", at(0)),
					row(monthId, "create", at(0)),
					row(dayId, "create", at(0)),
					row(rootId, "create", at(0)),
					row(rootId, "placement", at(0)),
				],
			},
		);
	});
	it("moves a node deleted and restored before any drain back where it was, since upstream never lost it", async () =>
	{
		const {writer, outboxRows, pushes, drain} = setup();
		setClock(at(0));
		writer.deleteNode("b");
		setClock(at(1));
		writer.restoreNode(
			{
				id: "b",
				parentId: "q",
				index: 0,
			},
		);

		const result = await drain();

		expect(
			{
				result,
				pushes,
				outbox: outboxRows(),
			},
		).toStrictEqual(
			{
				result:
				{
					ops: 1,
					closed: 3,
					flagged: 0,
				},
				pushes: [
					[
						{
							type: "move",
							data:
							{
								projectid: "b",
								parentid: "q",
								priority: 0,
							},
							client_timestamp: CT,
							undo_data:
							{
								previous_parentid: "p",
								previous_priority: 1,
								...NO_PREVIOUS,
							},
						},
					],
				],
				outbox: [row("b", "create", at(1)), row("b", "delete", at(0)), row("b", "placement", at(1))],
			},
		);
	});

	it("sends only the edits made before a delete when a node and its mirrored child are restored in place before any drain", async () =>
	{
		const {writer, outboxRows, pushes, drain} = setup();
		setClock(at(0));
		writer.updateNode(
			"c",
			{
				name: "C",
			},
		);
		setClock(at(1));
		writer.deleteNode("c");
		setClock(at(2));
		writer.restoreNode(
			{
				id: "c",
			},
		);

		const result = await drain();

		expect(
			{
				result,
				pushes,
				outbox: outboxRows(),
			},
		).toStrictEqual(
			{
				result:
				{
					ops: 1,
					closed: 7,
					flagged: 0,
				},
				pushes: [[rename("c", "C", "c")]],
				outbox: [
					row("c", "create", at(2)),
					row("c", "delete", at(1)),
					row("c", "name", at(0)),
					row("c", "placement", at(2)),
					row("c1", "create", at(2)),
					row("c1", "delete", at(1)),
					row("m", "mirror", at(2)),
				],
			},
		);
	});

	it("undeletes a restored node whose delete already went out", async () =>
	{
		const {database, writer, outboxRows, pushes, pusher, drain} = setup();
		setClock(at(0));
		writer.deleteNode("b");
		await drain();
		const RESTORED = systemTimeAt("2026-03-02 00:00:10.000");
		setClock(RESTORED);
		writer.restoreNode(
			{
				id: "b",
			},
		);
		const SECOND_DRAIN = systemTimeAt("2026-03-02 00:01:00.000");
		setClock(SECOND_DRAIN);
		const result = await drainOutbox(database, pusher());

		expect(
			{
				result,
				undelete: pushes[1],
				pending: outboxRows().filter(({systemTo}) => systemTo === FAR_FUTURE_DATE),
			},
		).toStrictEqual(
			{
				result:
				{
					ops: 1,
					closed: 2,
					flagged: 0,
				},
				undelete: [
					{
						type: "undelete",
						data:
						{
							projectid: "b",
							parentid: "p",
							priority: 1,
						},
						client_timestamp: CT + 60,
						undo_data: NO_PREVIOUS,
					},
				],
				pending: [],
			},
		);
	});

	it("reads the pending rows, the flagged rows and the status through their partial indexes, never scanning closed versions", () =>
	{
		const queries:
		{
			sql: string;
			params: unknown[];
		}[] = [];
		const sqlite = migratedMemoryDatabase();
		const database = drizzle(
			sqlite,
			{
				schema,
				logger:
				{
					logQuery(sql, params)
					{
						queries.push(
							{
								sql,
								params,
							},
						);
					},
				},
			},
		);
		readPendingOutbox(database, 50);
		readPendingAccountOutbox(database);
		outboxStatus(database);
		readLeftOutRows(database);
		const plans = queries.map(({sql, params}) =>
			(
				sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as
				{
					detail: string;
				}[]
			).map(({detail}) => detail),
		);
		sqlite.close();
		// Each walks only the pending rows of a partial index, never the closed versions that pile up behind them.
		// The flagged count and the catch-up's flagged read walk only the flagged rows, never the pending ones.
		expect(plans).toStrictEqual([
			["SCAN outbox USING INDEX outbox_pending_idx"],
			["SCAN outbox USING INDEX outbox_pending_idx"],
			["SCAN account_outbox USING INDEX account_outbox_pending_idx"],
			["SCAN outbox USING INDEX outbox_pending_idx"],
			["SCAN outbox USING INDEX outbox_pending_idx", "USE TEMP B-TREE FOR ORDER BY"],
			["SCAN account_outbox USING COVERING INDEX account_outbox_pending_idx"],
			["SCAN account_outbox USING INDEX account_outbox_pending_idx", "USE TEMP B-TREE FOR ORDER BY"],
			["SCAN outbox USING INDEX outbox_left_out_idx"],
			["SCAN outbox USING INDEX outbox_left_out_idx"],
		]);
	});
});
