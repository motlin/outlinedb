import DatabaseConstructor from "better-sqlite3";
import {sql} from "drizzle-orm";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {z} from "zod";
import * as schema from "@outlinedb/shared/db";
import type {AppDatabase} from "@outlinedb/shared/db";
import type {ServerContext} from "../src/server/context.js";
import
{
	TreeEventBus,
	accountChangePublisher,
	expansionChangePublisher,
	withTreeChangePublish,
} from "../src/server/node-events.js";
import {nodeEventsSocketHandlers} from "../src/server/node-events-socket.js";
import {defineOp, ok} from "../src/server/ops/define.js";
import {inProcessStore} from "../src/server/store.js";

const MARK = "2026-11-05 12:00:00.000";

function connect(bus: TreeEventBus)
{
	const ws =
	{
		send: vi.fn<(data: string) => void>(),
	};
	const handlers = nodeEventsSocketHandlers(bus);
	handlers.onOpen?.({}, ws);
	return {
		ws,
		handlers,
	};
}

const open: DatabaseConstructor.Database[] = [];
afterEach(() =>
{
	for (const sqlite of open.splice(0))
	{
		sqlite.close();
	}
});

function scratchDb(): AppDatabase
{
	const sqlite = new DatabaseConstructor(":memory:");
	open.push(sqlite);
	const db = drizzle(
		sqlite,
		{
			schema,
		},
	);
	db.run(sql`CREATE TABLE scratch (x INTEGER)`);
	return db;
}

function framesOf(ws: {
	send:
	{
		mock:
		{
			calls: [string][];
		};
	};
})
{
	return ws.send.mock.calls.map(([frame]) => JSON.parse(frame) as unknown);
}

describe("nodeEventsSocketHandlers", () =>
{
	it("sends exactly one tree.changed frame per published change to every connected socket", () =>
	{
		const bus = new TreeEventBus();
		const first = connect(bus);
		const second = connect(bus);
		bus.publish(MARK);
		const expected = [
			{
				type: "tree.changed",
				latest: MARK,
			},
		];
		expect(
			{
				first: framesOf(first.ws),
				second: framesOf(second.ws),
			},
		).toStrictEqual(
			{
				first: expected,
				second: expected,
			},
		);
		expect(first.ws.send.mock.calls).toStrictEqual([[`{"type":"tree.changed","latest":"${MARK}"}`]]);
	});

	it("stops sending to a socket after it closes", () =>
	{
		const bus = new TreeEventBus();
		const closed = connect(bus);
		const live = connect(bus);
		closed.handlers.onClose?.({}, closed.ws);
		bus.publish(MARK);
		expect(
			{
				closed: framesOf(closed.ws),
				live: framesOf(live.ws),
			},
		).toStrictEqual(
			{
				closed: [],
				live: [
					{
						type: "tree.changed",
						latest: MARK,
					},
				],
			},
		);
	});

	it("drops a socket whose send throws without starving the others", () =>
	{
		const bus = new TreeEventBus();
		const broken = connect(bus);
		broken.ws.send.mockImplementation(() =>
		{
			throw new Error("socket closed");
		});
		const live = connect(bus);
		bus.publish(MARK);
		bus.publish(MARK);
		expect(
			{
				broken: broken.ws.send.mock.calls.length,
				live: live.ws.send.mock.calls.length,
			},
		).toStrictEqual(
			{
				broken: 1,
				live: 2,
			},
		);
	});
});

describe("withTreeChangePublish", () =>
{
	it("publishes one change after a unit of work that wrote, and none after one that only read", async () =>
	{
		const db = scratchDb();
		const bus = new TreeEventBus();
		const {ws} = connect(bus);
		const now = () => MARK;
		await withTreeChangePublish(db, bus, async () => Promise.resolve(db.all(sql`SELECT * FROM scratch`)), now);
		expect(framesOf(ws)).toStrictEqual([]);
		await withTreeChangePublish(
			db,
			bus,
			async () =>
			{
				db.run(sql`INSERT INTO scratch VALUES (1)`);
				db.run(sql`INSERT INTO scratch VALUES (2)`);
				return Promise.resolve();
			},
			now,
		);
		expect(framesOf(ws)).toStrictEqual([
			{
				type: "tree.changed",
				latest: MARK,
			},
		]);
	});

	it("still publishes when the unit of work wrote and then threw", async () =>
	{
		const db = scratchDb();
		const bus = new TreeEventBus();
		const {ws} = connect(bus);
		await expect(
			withTreeChangePublish(
				db,
				bus,
				async () =>
				{
					db.run(sql`INSERT INTO scratch VALUES (1)`);
					return Promise.reject(new Error("late failure"));
				},
				() => MARK,
			),
		).rejects.toThrow("late failure");
		expect(framesOf(ws)).toStrictEqual([
			{
				type: "tree.changed",
				latest: MARK,
			},
		]);
	});
});

describe("inProcessStore with treeEvents", () =>
{
	it("announces each op that wrote and stays quiet for reads", async () =>
	{
		const db = scratchDb();
		const bus = new TreeEventBus();
		const {ws} = connect(bus);
		const ops =
		{
			read: defineOp(
				{
					input: z.object({}),
					output: z.null(),
					run: (ctx: ServerContext) =>
					{
						ctx.db.all(sql`SELECT * FROM scratch`);
						return ok(null);
					},
				},
			),
			write: defineOp(
				{
					input: z.object({}),
					output: z.null(),
					run: (ctx: ServerContext) =>
					{
						ctx.db.run(sql`INSERT INTO scratch VALUES (1)`);
						return ok(null);
					},
				},
			),
		};
		const store = inProcessStore(
			{
				db,
			} as ServerContext,
			ops,
			{
				treeEvents: bus,
			},
		);
		await store.call("read" as never, {} as never);
		await store.call("write" as never, {} as never);
		const frames = framesOf(ws) as
		{
			type: string;
			latest: string;
		}[];
		expect(frames.map(({type}) => type)).toStrictEqual(["tree.changed"]);
		expect(frames[0].latest).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/u);
	});
});

describe("expansionChangePublisher", () =>
{
	it("sends one expansion.changed frame when the keys' version moves, and none while it holds", () =>
	{
		const bus = new TreeEventBus();
		const {ws} = connect(bus);
		let current: string | undefined = "aaaaaaaaaaaaaaaa";
		const check = expansionChangePublisher(bus, () => current);
		check();
		current = "bbbbbbbbbbbbbbbb";
		check();
		check();
		current = undefined;
		check();
		expect(ws.send.mock.calls).toStrictEqual([['{"type":"expansion.changed","version":"bbbbbbbbbbbbbbbb"}']]);
	});
});

describe("accountChangePublisher", () =>
{
	it("sends one account.changed frame when the account tables' version moves, and none while it holds", () =>
	{
		const bus = new TreeEventBus();
		const {ws} = connect(bus);
		let current = "aaaaaaaaaaaaaaaa";
		const check = accountChangePublisher(bus, () => current);
		check();
		current = "bbbbbbbbbbbbbbbb";
		check();
		check();
		expect(ws.send.mock.calls).toStrictEqual([['{"type":"account.changed","version":"bbbbbbbbbbbbbbbb"}']]);
	});
});
