import {describe, expect, it, vi} from "vite-plus/test";
import {LadderEventBus} from "../src/server/ladder-events.js";
import {LadderService} from "../src/server/ladder-service.js";
import type {LadderServiceOptions} from "../src/server/ladder-service.js";

const tier = (
	id: string,
	label: string,
	items:
	{
		id: string;
		name: string;
	}[],
) => (
{
	id,
	name: label,
	completedAt: null,
	children: items.map((i) => (
	{
		id: i.id,
		name: i.name,
		completedAt: null,
		children: [],
	})),
});

function makeService(overrides: Partial<ConstructorParameters<typeof LadderService>[0]> = {})
{
	const buckets =
	{
		work:
		{
			id: "wb",
			name: "📌 work",
			children: [
				tier("w1", "1st", [
					{
						id: "a",
						name: "A",
					},
				]),
				tier("w2", "2nd", []),
			],
		},
		personal:
		{
			id: "pb",
			name: "📌 personal",
			children: [
				tier("p1", "1st", [
					{
						id: "x",
						name: "X",
					},
				]),
			],
		},
	};
	const moveNode = vi.fn<LadderServiceOptions["moveNode"]>(async () => {});
	const completeNode = vi.fn<LadderServiceOptions["completeNode"]>(async () => {});
	const events = new LadderEventBus();
	const service = new LadderService(
		{
			readBuckets: async () => Promise.resolve(buckets),
			moveNode,
			completeNode,
			events,
			...overrides,
		},
	);
	return {
		service,
		moveNode,
		completeNode,
		events,
	};
}

describe("LadderService.read", () =>
{
	it("returns both ladders with tiers and capacity state", async () =>
	{
		const {service} = makeService();
		const ladders = await service.read();
		expect(Object.keys(ladders)).toStrictEqual(["work", "personal"]);
		expect(ladders.work.tiers.map((t) => t.label)).toStrictEqual(["1st", "2nd"]);
		expect(ladders.work.tiers[0].state).toBe("room");
	});
});

describe("LadderService.move", () =>
{
	it("writes the move to Workflowy with the destination tier as parent", async () =>
	{
		const {service, moveNode} = makeService();
		await service.move(
			{
				root: "work",
				nodeId: "a",
				toTier: "2nd",
			},
		);
		expect(moveNode).toHaveBeenCalledWith("a", "w2", -1);
	});

	it("publishes one event per write, so a watcher is woken per edit", async () =>
	{
		const {service, events} = makeService();
		const seen: unknown[] = [];
		events.subscribe((e) =>
		{
			seen.push(e);
		});
		await service.move(
			{
				root: "work",
				nodeId: "a",
				toTier: "2nd",
			},
		);
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject(
			{
				verb: "move",
				nodeId: "a",
				fromTier: "1st",
				toTier: "2nd",
				name: "A",
			},
		);
	});

	it("does not publish an event when the write fails", async () =>
	{
		const {service, events} = makeService(
			{
				moveNode: vi.fn<LadderServiceOptions["moveNode"]>(async () =>
					Promise.reject(new Error("upstream 500")),
				),
			},
		);
		const seen: unknown[] = [];
		events.subscribe((e) =>
		{
			seen.push(e);
		});
		await expect(
			service.move(
				{
					root: "work",
					nodeId: "a",
					toTier: "2nd",
				},
			),
		).rejects.toThrow("upstream 500");
		expect(seen).toStrictEqual([]);
	});

	it("answers once the move lands, without waiting for the tier refresh", async () =>
	{
		const refreshTier = vi.fn<NonNullable<LadderServiceOptions["refreshTier"]>>(
			async () => new Promise<void>(() => {}),
		);
		const {service} = makeService(
			{
				refreshTier,
			},
		);
		const answered = await Promise.race([
			service
				.move(
					{
						root: "work",
						nodeId: "a",
						toTier: "2nd",
					},
				)
				.then(() => "answered"),
			new Promise((resolve) =>
			{
				setImmediate(() =>
				{
					resolve("blocked");
				});
			}),
		]);
		expect(
			{
				answered,
				refreshed: refreshTier.mock.calls,
			},
		).toStrictEqual(
			{
				answered: "answered",
				refreshed: [["w2"]],
			},
		);
	});

	it("keeps a landed move when the tier refresh fails", async () =>
	{
		const failure = vi.spyOn(console, "error").mockImplementation(() => {});
		const {service} = makeService(
			{
				refreshTier: vi.fn<NonNullable<LadderServiceOptions["refreshTier"]>>(async () =>
					Promise.reject(new Error("Test refresh throttled")),
				),
			},
		);
		await expect(
			service.move(
				{
					root: "work",
					nodeId: "a",
					toTier: "2nd",
				},
			),
		).resolves.toMatchObject(
			{
				nodeId: "a",
			},
		);
		await new Promise((resolve) =>
		{
			setImmediate(resolve);
		});
		expect(failure.mock.calls.map(([message]): unknown => message)).toStrictEqual([
			"ladder: could not refresh tier w2 after a move: Test refresh throttled",
		]);
		failure.mockRestore();
	});

	it("rejects an unknown root instead of writing somewhere plausible", async () =>
	{
		const {service, moveNode} = makeService();
		await expect(
			service.move(
				{
					root: "nope",
					nodeId: "a",
					toTier: "2nd",
				},
			),
		).rejects.toThrow(/nope/u);
		expect(moveNode).not.toHaveBeenCalled();
	});

	it("rejects a node from the other ladder rather than moving it across roots", async () =>
	{
		const {service, moveNode} = makeService();
		await expect(
			service.move(
				{
					root: "work",
					nodeId: "x",
					toTier: "2nd",
				},
			),
		).rejects.toThrow(/x/u);
		expect(moveNode).not.toHaveBeenCalled();
	});
});

describe("LadderService.complete", () =>
{
	it("completes the node and publishes a complete event", async () =>
	{
		const {service, completeNode, events} = makeService();
		const seen: unknown[] = [];
		events.subscribe((e) =>
		{
			seen.push(e);
		});
		await service.complete(
			{
				root: "work",
				nodeId: "a",
			},
		);
		expect(completeNode).toHaveBeenCalledWith("a");
		expect(seen[0]).toMatchObject(
			{
				verb: "complete",
				nodeId: "a",
				fromTier: "1st",
				name: "A",
			},
		);
	});
});

describe("exact placement using top/bottom writes", () =>
{
	it("persists a middle insertion in order and broadcasts each successful write", async () =>
	{
		const buckets =
		{
			work:
			{
				id: "bucket",
				children: [
					tier("first", "1st", [
						{
							id: "alice",
							name: "Alice",
						},
						{
							id: "bob",
							name: "Bob",
						},
						{
							id: "charlie",
							name: "Charlie",
						},
					]),
				],
			},
		};
		const {service, moveNode, events} = makeService(
			{
				readBuckets: async () => Promise.resolve(buckets),
				now: () => new Date("2000-01-01T00:00:00.000Z"),
			},
		);
		const seen: unknown[] = [];
		events.subscribe((event) =>
		{
			seen.push(event);
		});
		await service.move(
			{
				root: "work",
				nodeId: "alice",
				toTier: "1st",
				beforeNodeId: "charlie",
			},
		);
		expect(moveNode.mock.calls).toStrictEqual([
			["alice", "first", -1],
			["bob", "first", -1],
		]);
		expect(seen).toStrictEqual([
			{
				verb: "move",
				nodeId: "alice",
				name: "Alice",
				fromTier: "1st",
				toTier: "1st",
				beforeNodeId: "",
				at: "2000-01-01T00:00:00.000Z",
			},
			{
				verb: "move",
				nodeId: "bob",
				name: "Bob",
				fromTier: "1st",
				toTier: "1st",
				beforeNodeId: "",
				at: "2000-01-01T00:00:00.000Z",
			},
			{
				verb: "move",
				nodeId: "alice",
				name: "Alice",
				fromTier: "1st",
				toTier: "1st",
				beforeNodeId: "charlie",
				at: "2000-01-01T00:00:00.000Z",
			},
		]);
	});

	it("rejects a stale insertion target without moving anything", async () =>
	{
		const {service, moveNode} = makeService();
		await expect(
			service.move(
				{
					root: "work",
					nodeId: "a",
					toTier: "2nd",
					beforeNodeId: "missing",
				},
			),
		).rejects.toThrow(new Error("node missing is not a destination row"));
		expect(moveNode.mock.calls).toStrictEqual([]);
	});
});

describe("exact placement using one internal-API move", () =>
{
	const node = (id: string, completedAt: string | null = null) => (
	{
		id,
		name: id,
		completedAt,
		children: [],
	});
	const buckets =
	{
		work:
		{
			id: "bucket",
			children: [
				{
					id: "first",
					name: "1st",
					completedAt: null,
					children: [node("zed")],
				},
				{
					id: "second",
					name: "2nd",
					completedAt: null,
					children: [node("done", "2026-01-01T00:00:00.000Z"), node("alice"), node("bob"), node("charlie")],
				},
			],
		},
	};

	function exactService()
	{
		const moveTo = vi.fn<NonNullable<LadderServiceOptions["moveTo"]>>(async () => {});
		const made = makeService(
			{
				readBuckets: async () => Promise.resolve(buckets),
				moveTo,
				now: () => new Date("2000-01-01T00:00:00.000Z"),
			},
		);
		const seen: unknown[] = [];
		made.events.subscribe((event) =>
		{
			seen.push(event);
		});
		return {
			...made,
			moveTo,
			seen,
		};
	}

	const landed = (nodeId: string, fromTier: string, beforeNodeId: string) => (
	{
		verb: "move",
		nodeId,
		name: nodeId,
		fromTier,
		toTier: "2nd",
		beforeNodeId,
		at: "2000-01-01T00:00:00.000Z",
	});

	it("lands a step-down mid-tier with one move indexed over every child, completed rows included", async () =>
	{
		const {service, moveTo, moveNode, seen} = exactService();
		await service.move(
			{
				root: "work",
				nodeId: "zed",
				toTier: "2nd",
				beforeNodeId: "bob",
			},
		);
		expect(
			{
				moveTo: moveTo.mock.calls,
				moveNode: moveNode.mock.calls,
				seen,
			},
		).toStrictEqual(
			{
				moveTo: [["zed", "second", 2]],
				moveNode: [],
				seen: [landed("zed", "1st", "bob")],
			},
		);
	});

	it("lands a step-down at the top of the tier just before its first open row", async () =>
	{
		const {service, moveTo, moveNode, seen} = exactService();
		await service.move(
			{
				root: "work",
				nodeId: "zed",
				toTier: "2nd",
				beforeNodeId: "alice",
			},
		);
		expect(
			{
				moveTo: moveTo.mock.calls,
				moveNode: moveNode.mock.calls,
				seen,
			},
		).toStrictEqual(
			{
				moveTo: [["zed", "second", 1]],
				moveNode: [],
				seen: [landed("zed", "1st", "alice")],
			},
		);
	});

	it("lands a row at the bottom of the tier after every child", async () =>
	{
		const {service, moveTo, moveNode, seen} = exactService();
		await service.move(
			{
				root: "work",
				nodeId: "zed",
				toTier: "2nd",
			},
		);
		expect(
			{
				moveTo: moveTo.mock.calls,
				moveNode: moveNode.mock.calls,
				seen,
			},
		).toStrictEqual(
			{
				moveTo: [["zed", "second", 4]],
				moveNode: [],
				seen: [landed("zed", "1st", "")],
			},
		);
	});

	it("reorders within a tier with one move and no writes to the other rows", async () =>
	{
		const {service, moveTo, moveNode, seen} = exactService();
		await service.move(
			{
				root: "work",
				nodeId: "alice",
				toTier: "2nd",
				beforeNodeId: "charlie",
			},
		);
		expect(
			{
				moveTo: moveTo.mock.calls,
				moveNode: moveNode.mock.calls,
				seen,
			},
		).toStrictEqual(
			{
				moveTo: [["alice", "second", 3]],
				moveNode: [],
				seen: [landed("alice", "2nd", "charlie")],
			},
		);
	});
});
