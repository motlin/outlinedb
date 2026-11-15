import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import DatabaseConstructor from "better-sqlite3";
import {asc} from "drizzle-orm";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {join} from "node:path";
import {LocalTreeWriter} from "../src/cache/local-tree-writer.js";
import {runUnitOfWork} from "../src/cache/node-composite.js";
import {OutboxRecorder, outboxStatus} from "../src/cache/outbox.js";
import type {OutboxAspect} from "../src/cache/outbox.js";
import * as schema from "../src/db/schema.js";
import {mirrors, nodeContent, nodeMetadata, outbox} from "../src/db/schema.js";
import {OutboxNotAcknowledged} from "../src/internal/errors.js";
import {drainOutbox} from "../src/internal/outbox-drain.js";
import type {OutboxPusher} from "../src/internal/outbox-drain.js";
import type {InternalOp} from "../src/internal/push-and-poll.js";
import {FAR_FUTURE_DATE} from "../src/temporal/constants.js";

const migrationsFolder = join(import.meta.dirname, "../src/db/migrations");
const SEEDED_AT = "2026-01-01 00:00:00.000";
const SEEDED = new Date("2026-01-01T00:00:00.000Z");
/** The account's join date: 2026-01-01T00:00:00Z. */
const JOINED_SEC = 1_767_225_600;
const USER_ID = 42;
/** When each test's drain runs. */
const DRAIN = "2026-03-02 00:00:00.000";
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
function at(seconds: number): string
{
	return `2026-03-01 00:00:${String(seconds).padStart(2, "0")}.000`;
}

function setClock(systemTime: string): void
{
	vi.setSystemTime(new Date(`${systemTime.replace(" ", "T")}Z`));
}

function setup()
{
	const sqlite = new DatabaseConstructor(":memory:");
	const database = drizzle(
		sqlite,
		{
			schema,
		},
	);
	migrate(
		database,
		{
			migrationsFolder,
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

	const writer = new LocalTreeWriter(
		database,
		{
			outbox: new OutboxRecorder(),
		},
	);
	const outboxRows = () =>
		database.select().from(outbox).orderBy(asc(outbox.nodeId), asc(outbox.aspect), asc(outbox.systemFrom)).all();

	const pushes: InternalOp[][] = [];
	/**
	 * A pusher whose server run is `respond`'s ops (by default every op pushed), or which fails with its error.
	 * `beforeAccept` runs between the push and its acknowledgement.
	 */
	const pusher = (
		respond: (ops: InternalOp[]) => InternalOp[] | Error = (ops) => ops,
		beforeAccept: () => void = () =>
		{
		},
	): OutboxPusher => (
	{
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
						remote: [],
						needsRefresh: false,
					},
				);
			});
			return Promise.resolve();
		},
	});

	const drain = async (target = pusher()) =>
	{
		setClock(DRAIN);
		return drainOutbox(database, target);
	};

	return {
		database,
		writer,
		outboxRows,
		pushes,
		pusher,
		drain,
	};
}

/** An outbox row first enqueued at `enqueuedAt`, closed by the drain unless `systemTo` says otherwise. */
function row(
	nodeId: string,
	aspect: OutboxAspect,
	enqueuedAt: string,
	{
		systemFrom = enqueuedAt,
		systemTo = DRAIN,
		lastError = null,
	}:
	{
		systemFrom?: string;
		systemTo?: string;
		lastError?: string | null;
	} = {},
)
{
	return {
		nodeId,
		aspect,
		enqueuedAt,
		lastError,
		systemFrom,
		systemTo,
	};
}

const NO_PREVIOUS =
{
	previous_last_modified: null,
	previous_last_modified_by: null,
};

function bulkCreate(id: string, parentId: string, index: number): InternalOp
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
					nm: id,
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

	it("sends nothing for a node created and deleted before the drain, and only the delete for a renamed node it deleted", async () =>
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
					closed: 5,
				},
				pushes: [
					[
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
								priority: 1,
							},
						},
					],
				],
				outbox: [
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

		expect(
			{
				pushes: pushes.length,
				outbox: outboxRows(),
				status: outboxStatus(database),
			},
		).toStrictEqual(
			{
				pushes: 1,
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
					oldestEnqueuedAt: at(0),
					lastError: "offline",
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
					lastError: new OutboxNotAcknowledged(1, 0).message,
				},
			),
		]);
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
					setClock("2026-03-02 00:00:01.000");
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
							systemTo: "2026-03-02 00:00:01.000",
						},
					),
				],
			},
		);
	});
});
