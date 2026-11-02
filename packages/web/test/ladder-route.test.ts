import {describe, expect, it, vi} from "vite-plus/test";
import {createHttpApp} from "../src/server/http/app.js";
import {createLadderOps} from "../src/server/ops/ladder.js";
import type {LadderOperations} from "../src/server/ops/ladder.js";
import type {ServerContext} from "../src/server/context.js";
import {inProcessStore} from "../src/server/store.js";
import type {Ladder} from "../src/server/ladder-model.js";
import type {LadderService} from "../src/server/ladder-service.js";
import {checkOpOutputs} from "./helpers/check-op-outputs.js";

/** A router over a service that answers only the operations a test supplies. */
function makeApp(operations: Partial<LadderOperations>)
{
	const unexpected = async (): Promise<never> => Promise.reject(new Error("unexpected ladder service call"));
	const service: LadderOperations =
	{
		read: unexpected,
		move: unexpected,
		complete: unexpected,
		...operations,
	};
	const store = inProcessStore({} as unknown as ServerContext, checkOpOutputs(createLadderOps(() => service)));
	return createHttpApp(
		{
			resolveStore: () => store,
		},
	);
}

const ladders: Record<string, Ladder> =
{
	work:
	{
		root: "work",
		bucketId: "wb",
		tiers: [
			{
				tier: 1,
				label: "1st",
				id: "w1",
				capacity: 2,
				state: "room",
				items: [],
			},
		],
	},
};

describe("GET /api/v1/ladder", () =>
{
	it("returns both ladders as JSON", async () =>
	{
		const app = makeApp(
			{
				read: async () => Promise.resolve(ladders),
			},
		);
		const res = await app.fetch(new Request("http://x/api/v1/ladder"));
		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toStrictEqual(
			{
				ladders,
			},
		);
	});
});

describe("POST /api/v1/ladder/move", () =>
{
	it("passes root, node and destination tier through to the service", async () =>
	{
		const move = vi.fn<LadderService["move"]>().mockResolvedValue(
			{
				verb: "move",
				nodeId: "a",
				name: "A",
				fromTier: "1st",
				toTier: "2nd",
				at: "T",
			},
		);
		const app = makeApp(
			{
				move,
			},
		);
		const res = await app.fetch(
			new Request(
				"http://x/api/v1/ladder/move",
				{
					method: "POST",
					headers:
					{
						"content-type": "application/json",
					},
					body: JSON.stringify(
						{
							root: "work",
							node_id: "a",
							to_tier: "2nd",
						},
					),
				},
			),
		);
		expect(res.status).toBe(200);
		expect(move).toHaveBeenCalledWith(
			{
				root: "work",
				nodeId: "a",
				toTier: "2nd",
			},
		);
		await expect(res.json()).resolves.toMatchObject(
			{
				event:
				{
					verb: "move",
					toTier: "2nd",
				},
			},
		);
	});

	it("rejects a body missing to_tier instead of guessing a destination", async () =>
	{
		const move = vi.fn<LadderService["move"]>();
		const app = makeApp(
			{
				move,
			},
		);
		const res = await app.fetch(
			new Request(
				"http://x/api/v1/ladder/move",
				{
					method: "POST",
					headers:
					{
						"content-type": "application/json",
					},
					body: JSON.stringify(
						{
							root: "work",
							node_id: "a",
						},
					),
				},
			),
		);
		expect(res.status).toBe(400);
		expect(move).not.toHaveBeenCalled();
	});

	it("rejects a non-string node_id instead of passing it to the service", async () =>
	{
		const move = vi.fn<LadderService["move"]>();
		const app = makeApp(
			{
				move,
			},
		);
		const res = await app.fetch(
			new Request(
				"http://x/api/v1/ladder/move",
				{
					method: "POST",
					headers:
					{
						"content-type": "application/json",
					},
					body: JSON.stringify(
						{
							root: "work",
							node_id: 42,
							to_tier: "2nd",
						},
					),
				},
			),
		);
		expect(res.status).toBe(400);
		await expect(res.json()).resolves.toStrictEqual(
			{
				error: "root, node_id and to_tier are required strings, and before_id must be a string when given",
			},
		);
		expect(move).not.toHaveBeenCalled();
	});

	it("rejects a non-string before_id instead of guessing an insertion point", async () =>
	{
		const move = vi.fn<LadderService["move"]>();
		const app = makeApp(
			{
				move,
			},
		);
		const res = await app.fetch(
			new Request(
				"http://x/api/v1/ladder/move",
				{
					method: "POST",
					headers:
					{
						"content-type": "application/json",
					},
					body: JSON.stringify(
						{
							root: "work",
							node_id: "a",
							to_tier: "2nd",
							before_id: 7,
						},
					),
				},
			),
		);
		expect(res.status).toBe(400);
		await expect(res.json()).resolves.toStrictEqual(
			{
				error: "root, node_id and to_tier are required strings, and before_id must be a string when given",
			},
		);
		expect(move).not.toHaveBeenCalled();
	});

	it("reports a rejected move as 400 with the reason, not a 500", async () =>
	{
		const app = makeApp(
			{
				move: async () => Promise.reject(new Error("no tier 9th on the work ladder")),
			},
		);
		const res = await app.fetch(
			new Request(
				"http://x/api/v1/ladder/move",
				{
					method: "POST",
					headers:
					{
						"content-type": "application/json",
					},
					body: JSON.stringify(
						{
							root: "work",
							node_id: "a",
							to_tier: "9th",
						},
					),
				},
			),
		);
		expect(res.status).toBe(400);
		await expect(res.json()).resolves.toStrictEqual(
			{
				error: "no tier 9th on the work ladder",
				reconcile: true,
			},
		);
	});
});

describe("POST /api/v1/ladder/complete", () =>
{
	it("completes through the service", async () =>
	{
		const complete = vi.fn<LadderService["complete"]>().mockResolvedValue(
			{
				verb: "complete",
				nodeId: "a",
				name: "A",
				fromTier: "1st",
				toTier: null,
				at: "T",
			},
		);
		const app = makeApp(
			{
				complete,
			},
		);
		const res = await app.fetch(
			new Request(
				"http://x/api/v1/ladder/complete",
				{
					method: "POST",
					headers:
					{
						"content-type": "application/json",
					},
					body: JSON.stringify(
						{
							root: "work",
							node_id: "a",
						},
					),
				},
			),
		);
		expect(res.status).toBe(200);
		expect(complete).toHaveBeenCalledWith(
			{
				root: "work",
				nodeId: "a",
			},
		);
	});
});
