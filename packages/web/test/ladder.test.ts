import {describe, expect, it, vi} from "vite-plus/test";
import {LadderEventBus, parseLadderEvent} from "../src/server/ladder-events.js";
import type {LadderEvent, LadderListener} from "../src/server/ladder-events.js";
import {tierCapacity, toLadder, planTierMove} from "../src/server/ladder-model.js";
import type {RawNode, Ladder} from "../src/server/ladder-model.js";
import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {join} from "node:path";
import {CacheService} from "@outlinedb/shared/cache";
import * as schema from "@outlinedb/shared/db";
import {nodeContent, nodeMetadata} from "@outlinedb/shared/db";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import type {ServerContext} from "../src/server/context.js";
import {httpAppFor} from "./http-app-for.js";
import {createHttpApp} from "../src/server/http/app.js";
import {createLadderOps} from "../src/server/ops/ladder.js";
import type {LadderOperations} from "../src/server/ops/ladder.js";
import {inProcessStore} from "../src/server/store.js";
import type {LadderServiceOptions} from "../src/server/ladder-service.js";
import {checkOpOutputs} from "./helpers/check-op-outputs.js";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {LadderService} from "../src/server/ladder-service.js";
import {ladderSocketHandlers} from "../src/server/ladder-socket.js";
import {
	applyLadderEvent,
	ladderMoveSelection,
	moveWithin,
	selectLadderRange,
	stepBeforeId,
	tierOf,
} from "../src/client/ladder-state.js";

describe("ladder events", () => {
	function evt(partial: Partial<LadderEvent> = {}): LadderEvent {
		return {
			verb: "move",
			nodeId: "n1",
			name: "A task",
			fromTier: "6th",
			toTier: "5th",
			at: "2026-09-13T00:00:00Z",
			...partial,
		};
	}

	describe("LadderEventBus", () => {
		it("delivers an event to every subscriber", () => {
			const bus = new LadderEventBus();
			const a = vi.fn<LadderListener>();
			const b = vi.fn<LadderListener>();
			bus.subscribe(a);
			bus.subscribe(b);
			bus.publish(evt());
			expect(a).toHaveBeenCalledWith(evt());
			expect(b).toHaveBeenCalledWith(evt());
		});

		it("stops delivering after unsubscribe, so a closed socket is not written to", () => {
			const bus = new LadderEventBus();
			const listener = vi.fn<LadderListener>();
			const off = bus.subscribe(listener);
			off();
			bus.publish(evt());
			expect(listener).not.toHaveBeenCalled();
		});

		it("one throwing subscriber does not stop the others", () => {
			const bus = new LadderEventBus();
			const good = vi.fn<LadderListener>();
			bus.subscribe(() => {
				throw new Error("socket already closed");
			});
			bus.subscribe(good);
			expect(() => {
				bus.publish(evt());
			}).not.toThrow();
			expect(good).toHaveBeenCalledOnce();
		});

		it("replays recent events so a watcher that connects late does not miss writes", () => {
			const bus = new LadderEventBus();
			bus.publish(evt({nodeId: "n1"}));
			bus.publish(evt({nodeId: "n2"}));
			const late = vi.fn<LadderListener>();
			bus.subscribe(late, {replay: true});
			expect(late).toHaveBeenCalledTimes(2);
			expect(late.mock.calls.map((c) => c[0].nodeId)).toStrictEqual(["n1", "n2"]);
		});

		it("caps the replay buffer so a long session does not grow without bound", () => {
			const bus = new LadderEventBus({bufferSize: 3});
			for (const nodeId of ["n1", "n2", "n3", "n4"]) {
				bus.publish(evt({nodeId}));
			}
			const late = vi.fn<LadderListener>();
			bus.subscribe(late, {replay: true});
			expect(late.mock.calls.map((c) => c[0].nodeId)).toStrictEqual(["n2", "n3", "n4"]);
		});

		it("serialises an event as one line, because Monitor treats each frame as one notification", () => {
			const bus = new LadderEventBus();
			const line = bus.format(evt({name: "A task\nwith a newline"}));
			expect(line).not.toContain("\n");
			expect(JSON.parse(line)).toMatchObject({verb: "move", nodeId: "n1", toTier: "5th"});
		});
	});

	describe("parseLadderEvent", () => {
		it("reads back a frame the bus formatted", () => {
			const event = evt({beforeNodeId: "n2"});

			expect(parseLadderEvent(new LadderEventBus().format(event))).toStrictEqual(event);
		});

		it("drops a frame that is not a ladder event", () => {
			expect(parseLadderEvent(JSON.stringify({verb: "explode", nodeId: "n1"}))).toBeNull();
		});

		it("drops a frame that is not JSON", () => {
			expect(parseLadderEvent("not json")).toBeNull();
		});
	});
});

describe("ladder model", () => {
	const node = (id: string, name: string, children: RawNode[] = []): RawNode => ({
		id,
		name,
		children,
		completedAt: null,
	});

	describe("tierCapacity", () => {
		it("doubles with each tier, so 1st holds 2 and 6th holds 64", () => {
			expect([1, 2, 3, 4, 5, 6].map(tierCapacity)).toStrictEqual([2, 4, 8, 16, 32, 64]);
		});
	});

	describe("toLadder", () => {
		const bucket = {
			id: "bucket",
			name: "📌 Tasks (asap) (work)",
			children: [
				node("t1", "1st", [node("a", "Task A"), node("b", "Task B")]),
				node("t2", "2nd", []),
				node("t3", "3rd", [node("c", "Task C")]),
			],
		};

		it("reads tiers in order with their capacities", () => {
			const ladder = toLadder("work", bucket);
			expect(ladder.tiers.map((t) => [t.label, t.capacity, t.items.length])).toStrictEqual([
				["1st", 2, 2],
				["2nd", 4, 0],
				["3rd", 8, 1],
			]);
		});

		it("keeps an empty tier, because pulling an item up into one is the main repair", () => {
			const ladder = toLadder("work", bucket);
			expect(ladder.tiers.find((t) => t.label === "2nd")?.items).toStrictEqual([]);
		});

		it("marks each tier over, exact or room so the client does not recompute it", () => {
			const ladder = toLadder("work", bucket);
			expect(ladder.tiers.map((t) => t.state)).toStrictEqual(["exact", "room", "room"]);
		});

		it("drops completed tasks rather than showing work already done", () => {
			const withDone = {
				...bucket,
				children: [
					{
						id: "t1",
						name: "1st",
						completedAt: null,
						children: [
							node("a", "Task A"),
							{id: "z", name: "Done", children: [], completedAt: "2026-09-01"},
						],
					},
				],
			};
			expect(toLadder("work", withDone).tiers[0].items.map((i) => i.id)).toStrictEqual(["a"]);
		});
	});

	describe("planTierMove", () => {
		const ladder = toLadder("work", {
			id: "bucket",
			name: "📌",
			children: [node("t1", "1st", [node("a", "A")]), node("t2", "2nd", [node("b", "B")])],
		});

		it("resolves a tier label to the parent id the move endpoint needs", () => {
			expect(planTierMove(ladder, "a", "2nd")).toStrictEqual({
				nodeId: "a",
				parentId: "t2",
				fromTier: "1st",
				toTier: "2nd",
			});
		});

		it("refuses a tier that does not exist rather than guessing", () => {
			expect(() => planTierMove(ladder, "a", "9th")).toThrow(/9th/u);
		});

		it("refuses a node that is not on this ladder", () => {
			expect(() => planTierMove(ladder, "nope", "2nd")).toThrow(/nope/u);
		});
	});

	describe("toLadder subtrees", () => {
		const bucket: RawNode = {
			id: "bucket",
			name: "📌",
			children: [
				node("t1", "1st", [
					node("a", "Apply to magnet schools", [
						node("a1", "Request transcripts", [node("a1a", "Email the registrar")]),
						{id: "a2", name: "Old step", completedAt: "2026-09-01", children: []},
						node("a3", "Book the tour"),
					]),
					node("b", "Plain row"),
				]),
			],
		};

		it("carries each row subtree, so the page can show it without another request", () => {
			const [tier] = toLadder("work", bucket).tiers;
			const [withKids] = tier.items;
			expect(withKids.children.map((child) => child.name)).toStrictEqual([
				"Request transcripts",
				"Book the tour",
			]);
			expect(withKids.children[0].children.map((child) => child.name)).toStrictEqual(["Email the registrar"]);
		});

		it("leaves completed children out, the same as completed rows", () => {
			const [tier] = toLadder("work", bucket).tiers;
			expect(tier.items[0].children.some((child) => child.name === "Old step")).toBe(false);
		});

		it("gives a childless row an empty list rather than undefined", () => {
			const [tier] = toLadder("work", bucket).tiers;
			expect(tier.items[1].children).toStrictEqual([]);
		});

		it("counts the whole subtree, so a row can say how much is hidden under it", () => {
			const [tier] = toLadder("work", bucket).tiers;
			expect(tier.items[0].descendantCount).toBe(3);
			expect(tier.items[1].descendantCount).toBe(0);
		});
	});

	it("keeps the tree affordance when a task has only completed descendants", () => {
		const ladder = toLadder(
			"personal",
			node("bucket", "Tasks", [
				node("tier", "1st", [
					node("alice", "Alice", [{id: "bob", name: "Bob", completedAt: "2000-01-01", children: []}]),
				]),
			]),
		);
		expect(ladder.tiers[0].items).toStrictEqual([
			{id: "alice", name: "Alice", children: [], hasChildren: true, descendantCount: 0},
		]);
	});
});

describe("ladder route events", () => {
	const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");
	const SEEDED_AT = "2026-01-01 00:00:00.000";

	let counter = 0;
	function seed(db: ReturnType<typeof drizzle<typeof schema>>, name: string, parentId: string | null): string {
		counter += 1;
		const id = `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
		db.insert(nodeContent)
			.values({id, name, note: null, parentId, systemFrom: SEEDED_AT, systemTo: FAR_FUTURE_DATE})
			.run();
		db.insert(nodeMetadata)
			.values({
				nodeId: id,
				shortId: id.slice(-12),
				priority: counter,
				systemFrom: SEEDED_AT,
				systemTo: FAR_FUTURE_DATE,
			})
			.run();
		return id;
	}

	describe("ladder route event bus", () => {
		it("publishes a move on the bus injected through the context, once", async () => {
			const db = drizzle(new DatabaseConstructor(":memory:"), {schema});
			migrate(db, {migrationsFolder});
			let row = "";
			let secondTier = "";
			for (const [root, bucket] of [
				["Work", "📌 Tasks (asap) (work)"],
				["Personal", "📌 Tasks (asap) (personal)"],
			] as const) {
				const next = seed(db, `☑️ Next (${root})`, seed(db, root, null));
				const bucketId = seed(db, bucket, seed(db, "✅ Tasks", next));
				const first = seed(db, "1st", bucketId);
				const second = seed(db, "2nd", bucketId);
				if (root === "Work") {
					row = seed(db, "Write report", first);
					secondTier = second;
				}
			}
			const events = new LadderEventBus();
			const received: LadderEvent[] = [];
			events.subscribe((event) => {
				received.push(event);
			});
			const moveTo = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
			const ctx = {
				db,
				cacheService: new CacheService(db),
				config: {},
				apiKey: "key",
				ladderEvents: events,
				internalAdapter: () => ({moveTo}),
			} as unknown as ServerContext;
			const app = httpAppFor(ctx);

			const res = await app.fetch(
				new Request("http://x/api/v1/ladder/move", {
					method: "POST",
					headers: {"content-type": "application/json"},
					body: JSON.stringify({root: "work", node_id: row, to_tier: "2nd"}),
				}),
			);

			expect(res.status).toBe(200);
			expect(moveTo).toHaveBeenCalledWith({ids: [row], parentId: secondTier, index: 0});
			expect(received).toStrictEqual([
				expect.objectContaining({
					verb: "move",
					nodeId: row,
					name: "Write report",
					fromTier: "1st",
					toTier: "2nd",
				}),
			]);
		});
	});
});

describe("ladder route", () => {
	/** A router over a service that answers only the operations a test supplies. */
	function makeApp(operations: Partial<LadderOperations>) {
		const unexpected = async (): Promise<never> => Promise.reject(new Error("unexpected ladder service call"));
		const service: LadderOperations = {read: unexpected, move: unexpected, complete: unexpected, ...operations};
		const store = inProcessStore({} as unknown as ServerContext, checkOpOutputs(createLadderOps(() => service)));
		return createHttpApp({resolveStore: () => store});
	}

	const ladders: Record<string, Ladder> = {
		work: {
			root: "work",
			bucketId: "wb",
			tiers: [{tier: 1, label: "1st", id: "w1", capacity: 2, state: "room", items: []}],
		},
	};

	describe("GET /api/v1/ladder", () => {
		it("returns both ladders as JSON", async () => {
			const app = makeApp({read: async () => Promise.resolve(ladders)});
			const res = await app.fetch(new Request("http://x/api/v1/ladder"));
			expect(res.status).toBe(200);
			await expect(res.json()).resolves.toStrictEqual({ladders});
		});
	});

	describe("POST /api/v1/ladder/move", () => {
		it("passes root, node and destination tier through to the service", async () => {
			const move = vi.fn<LadderService["move"]>().mockResolvedValue({
				verb: "move",
				nodeId: "a",
				name: "A",
				fromTier: "1st",
				toTier: "2nd",
				at: "T",
			});
			const app = makeApp({move});
			const res = await app.fetch(
				new Request("http://x/api/v1/ladder/move", {
					method: "POST",
					headers: {"content-type": "application/json"},
					body: JSON.stringify({root: "work", node_id: "a", to_tier: "2nd"}),
				}),
			);
			expect(res.status).toBe(200);
			expect(move).toHaveBeenCalledWith({root: "work", nodeId: "a", toTier: "2nd"});
			await expect(res.json()).resolves.toMatchObject({event: {verb: "move", toTier: "2nd"}});
		});

		it("rejects a body missing to_tier instead of guessing a destination", async () => {
			const move = vi.fn<LadderService["move"]>();
			const app = makeApp({move});
			const res = await app.fetch(
				new Request("http://x/api/v1/ladder/move", {
					method: "POST",
					headers: {"content-type": "application/json"},
					body: JSON.stringify({root: "work", node_id: "a"}),
				}),
			);
			expect(res.status).toBe(400);
			expect(move).not.toHaveBeenCalled();
		});

		it("rejects a non-string node_id instead of passing it to the service", async () => {
			const move = vi.fn<LadderService["move"]>();
			const app = makeApp({move});
			const res = await app.fetch(
				new Request("http://x/api/v1/ladder/move", {
					method: "POST",
					headers: {"content-type": "application/json"},
					body: JSON.stringify({root: "work", node_id: 42, to_tier: "2nd"}),
				}),
			);
			expect(res.status).toBe(400);
			await expect(res.json()).resolves.toStrictEqual({
				error: "root, node_id and to_tier are required strings, and before_id must be a string when given",
			});
			expect(move).not.toHaveBeenCalled();
		});

		it("rejects a non-string before_id instead of guessing an insertion point", async () => {
			const move = vi.fn<LadderService["move"]>();
			const app = makeApp({move});
			const res = await app.fetch(
				new Request("http://x/api/v1/ladder/move", {
					method: "POST",
					headers: {"content-type": "application/json"},
					body: JSON.stringify({root: "work", node_id: "a", to_tier: "2nd", before_id: 7}),
				}),
			);
			expect(res.status).toBe(400);
			await expect(res.json()).resolves.toStrictEqual({
				error: "root, node_id and to_tier are required strings, and before_id must be a string when given",
			});
			expect(move).not.toHaveBeenCalled();
		});

		it("reports a rejected move as 400 with the reason, not a 500", async () => {
			const app = makeApp({
				move: async () => Promise.reject(new Error("no tier 9th on the work ladder")),
			});
			const res = await app.fetch(
				new Request("http://x/api/v1/ladder/move", {
					method: "POST",
					headers: {"content-type": "application/json"},
					body: JSON.stringify({root: "work", node_id: "a", to_tier: "9th"}),
				}),
			);
			expect(res.status).toBe(400);
			await expect(res.json()).resolves.toStrictEqual({error: "no tier 9th on the work ladder", reconcile: true});
		});
	});

	describe("POST /api/v1/ladder/complete", () => {
		it("completes through the service", async () => {
			const complete = vi.fn<LadderService["complete"]>().mockResolvedValue({
				verb: "complete",
				nodeId: "a",
				name: "A",
				fromTier: "1st",
				toTier: null,
				at: "T",
			});
			const app = makeApp({complete});
			const res = await app.fetch(
				new Request("http://x/api/v1/ladder/complete", {
					method: "POST",
					headers: {"content-type": "application/json"},
					body: JSON.stringify({root: "work", node_id: "a"}),
				}),
			);
			expect(res.status).toBe(200);
			expect(complete).toHaveBeenCalledWith({root: "work", nodeId: "a"});
		});
	});
});

describe("ladder row layout", () => {
	const css = readFileSync(fileURLToPath(new URL("../src/client/ladder.css", import.meta.url)), "utf8");
	const tsx = readFileSync(
		fileURLToPath(new URL("../src/client/components/ladder-view.tsx", import.meta.url)),
		"utf8",
	);

	function rowTracks(): string[] {
		const rule = /\.ladder-row \{([^}]*)\}/u.exec(css);
		if (!rule) {
			throw new Error("no .ladder-row rule");
		}
		const declaration = /grid-template-columns:\s*([^;]+);/u.exec(rule[1]);
		if (!declaration) {
			throw new Error("no grid-template-columns on .ladder-row");
		}
		// Split on spaces that are not inside minmax(...).
		return declaration[1].trim().split(/\s+(?![^(]*\))/u);
	}

	describe("ladder row layout", () => {
		// Fewer tracks than children wraps the last child (Done) onto a second grid row, doubling
		// every row's height, and slides the 1fr track off the text onto the rank number.
		it("gives every row child its own column so nothing wraps to a second line", () => {
			const children = ["grip", "rank", "txt", "step", "done"];
			expect(rowTracks()).toHaveLength(children.length);
		});

		it("spends the flexible column on the task text, not the rank", () => {
			const tracks = rowTracks();
			const flexible = tracks.findIndex((track) => track.includes("1fr"));
			expect(flexible).toBe(2);
		});

		it("renders the row children in the order the columns assume", () => {
			const row = /className=\{\[\s*["']ladder-row["'][\s\S]*?\n\t\t\t\t\t<\/div>/u.exec(tsx);
			expect(row).not.toBeNull();
			const order = [...row![0].matchAll(/className="(grip|rank|txt|step|done)"/gu)].map((match) => match[1]);
			expect(order).toStrictEqual(["grip", "rank", "txt", "step", "done"]);
		});

		// The subtree preview floats in its own layer, so it never changes a row's height or moves its buttons.
		it("layers the subtree preview above the list instead of expanding rows", () => {
			const rule = /\.ladder-preview \{([^}]*)\}/u.exec(css);
			expect({
				position: /position:\s*([^;]+);/u.exec(rule?.[1] ?? "")?.[1],
				layered: /z-index:\s*\d+;/u.test(rule?.[1] ?? ""),
				inlineChildren: css.includes(".ladder-children"),
			}).toStrictEqual({position: "fixed", layered: true, inlineChildren: false});
		});
	});
});

describe("ladder service", () => {
	const tier = (id: string, label: string, items: {id: string; name: string}[]) => ({
		id,
		name: label,
		completedAt: null,
		children: items.map((i) => ({id: i.id, name: i.name, completedAt: null, children: []})),
	});

	function makeService(overrides: Partial<ConstructorParameters<typeof LadderService>[0]> = {}) {
		const buckets = {
			work: {
				id: "wb",
				name: "📌 work",
				children: [tier("w1", "1st", [{id: "a", name: "A"}]), tier("w2", "2nd", [])],
			},
			personal: {id: "pb", name: "📌 personal", children: [tier("p1", "1st", [{id: "x", name: "X"}])]},
		};
		const moveNode = vi.fn<LadderServiceOptions["moveNode"]>(async () => {});
		const completeNode = vi.fn<LadderServiceOptions["completeNode"]>(async () => {});
		const events = new LadderEventBus();
		const service = new LadderService({
			readBuckets: async () => Promise.resolve(buckets),
			moveNode,
			completeNode,
			events,
			...overrides,
		});
		return {service, moveNode, completeNode, events};
	}

	describe("LadderService.read", () => {
		it("returns both ladders with tiers and capacity state", async () => {
			const {service} = makeService();
			const ladders = await service.read();
			expect(Object.keys(ladders)).toStrictEqual(["work", "personal"]);
			expect(ladders.work.tiers.map((t) => t.label)).toStrictEqual(["1st", "2nd"]);
			expect(ladders.work.tiers[0].state).toBe("room");
		});
	});

	describe("LadderService.move", () => {
		it("writes the move to Workflowy with the destination tier as parent", async () => {
			const {service, moveNode} = makeService();
			await service.move({root: "work", nodeId: "a", toTier: "2nd"});
			expect(moveNode).toHaveBeenCalledWith("a", "w2", -1);
		});

		it("publishes one event per write, so a watcher is woken per edit", async () => {
			const {service, events} = makeService();
			const seen: unknown[] = [];
			events.subscribe((e) => {
				seen.push(e);
			});
			await service.move({root: "work", nodeId: "a", toTier: "2nd"});
			expect(seen).toHaveLength(1);
			expect(seen[0]).toMatchObject({verb: "move", nodeId: "a", fromTier: "1st", toTier: "2nd", name: "A"});
		});

		it("does not publish an event when the write fails", async () => {
			const {service, events} = makeService({
				moveNode: vi.fn<LadderServiceOptions["moveNode"]>(async () =>
					Promise.reject(new Error("upstream 500")),
				),
			});
			const seen: unknown[] = [];
			events.subscribe((e) => {
				seen.push(e);
			});
			await expect(service.move({root: "work", nodeId: "a", toTier: "2nd"})).rejects.toThrow("upstream 500");
			expect(seen).toStrictEqual([]);
		});

		it("answers once the move lands, without waiting for the tier refresh", async () => {
			const refreshTier = vi.fn<NonNullable<LadderServiceOptions["refreshTier"]>>(
				async () => new Promise<void>(() => {}),
			);
			const {service} = makeService({refreshTier});
			const answered = await Promise.race([
				service.move({root: "work", nodeId: "a", toTier: "2nd"}).then(() => "answered"),
				new Promise((resolve) => {
					setImmediate(() => {
						resolve("blocked");
					});
				}),
			]);
			expect({answered, refreshed: refreshTier.mock.calls}).toStrictEqual({
				answered: "answered",
				refreshed: [["w2"]],
			});
		});

		it("keeps a landed move when the tier refresh fails", async () => {
			const failure = vi.spyOn(console, "error").mockImplementation(() => {});
			const {service} = makeService({
				refreshTier: vi.fn<NonNullable<LadderServiceOptions["refreshTier"]>>(async () =>
					Promise.reject(new Error("Test refresh throttled")),
				),
			});
			await expect(service.move({root: "work", nodeId: "a", toTier: "2nd"})).resolves.toMatchObject({
				nodeId: "a",
			});
			await new Promise((resolve) => {
				setImmediate(resolve);
			});
			expect(failure.mock.calls.map(([message]): unknown => message)).toStrictEqual([
				"ladder: could not refresh tier w2 after a move: Test refresh throttled",
			]);
			failure.mockRestore();
		});

		it("rejects an unknown root instead of writing somewhere plausible", async () => {
			const {service, moveNode} = makeService();
			await expect(service.move({root: "nope", nodeId: "a", toTier: "2nd"})).rejects.toThrow(/nope/u);
			expect(moveNode).not.toHaveBeenCalled();
		});

		it("rejects a node from the other ladder rather than moving it across roots", async () => {
			const {service, moveNode} = makeService();
			await expect(service.move({root: "work", nodeId: "x", toTier: "2nd"})).rejects.toThrow(/x/u);
			expect(moveNode).not.toHaveBeenCalled();
		});
	});

	describe("LadderService.complete", () => {
		it("completes the node and publishes a complete event", async () => {
			const {service, completeNode, events} = makeService();
			const seen: unknown[] = [];
			events.subscribe((e) => {
				seen.push(e);
			});
			await service.complete({root: "work", nodeId: "a"});
			expect(completeNode).toHaveBeenCalledWith("a");
			expect(seen[0]).toMatchObject({verb: "complete", nodeId: "a", fromTier: "1st", name: "A"});
		});
	});

	describe("exact placement using top/bottom writes", () => {
		it("persists a middle insertion in order and broadcasts each successful write", async () => {
			const buckets = {
				work: {
					id: "bucket",
					children: [
						tier("first", "1st", [
							{id: "alice", name: "Alice"},
							{id: "bob", name: "Bob"},
							{id: "charlie", name: "Charlie"},
						]),
					],
				},
			};
			const {service, moveNode, events} = makeService({
				readBuckets: async () => Promise.resolve(buckets),
				now: () => new Date("2000-01-01T00:00:00.000Z"),
			});
			const seen: unknown[] = [];
			events.subscribe((event) => {
				seen.push(event);
			});
			await service.move({root: "work", nodeId: "alice", toTier: "1st", beforeNodeId: "charlie"});
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

		it("rejects a stale insertion target without moving anything", async () => {
			const {service, moveNode} = makeService();
			await expect(
				service.move({root: "work", nodeId: "a", toTier: "2nd", beforeNodeId: "missing"}),
			).rejects.toThrow(new Error("node missing is not a destination row"));
			expect(moveNode.mock.calls).toStrictEqual([]);
		});
	});

	describe("exact placement using one internal-API move", () => {
		const node = (id: string, completedAt: string | null = null) => ({id, name: id, completedAt, children: []});
		const buckets = {
			work: {
				id: "bucket",
				children: [
					{id: "first", name: "1st", completedAt: null, children: [node("zed")]},
					{
						id: "second",
						name: "2nd",
						completedAt: null,
						children: [
							node("done", "2026-01-01T00:00:00.000Z"),
							node("alice"),
							node("bob"),
							node("charlie"),
						],
					},
				],
			},
		};

		function exactService() {
			const moveTo = vi.fn<NonNullable<LadderServiceOptions["moveTo"]>>(async () => {});
			const made = makeService({
				readBuckets: async () => Promise.resolve(buckets),
				moveTo,
				now: () => new Date("2000-01-01T00:00:00.000Z"),
			});
			const seen: unknown[] = [];
			made.events.subscribe((event) => {
				seen.push(event);
			});
			return {...made, moveTo, seen};
		}

		const landed = (nodeId: string, fromTier: string, beforeNodeId: string) => ({
			verb: "move",
			nodeId,
			name: nodeId,
			fromTier,
			toTier: "2nd",
			beforeNodeId,
			at: "2000-01-01T00:00:00.000Z",
		});

		it("lands a step-down mid-tier with one move indexed over every child, completed rows included", async () => {
			const {service, moveTo, moveNode, seen} = exactService();
			await service.move({root: "work", nodeId: "zed", toTier: "2nd", beforeNodeId: "bob"});
			expect({moveTo: moveTo.mock.calls, moveNode: moveNode.mock.calls, seen}).toStrictEqual({
				moveTo: [["zed", "second", 2]],
				moveNode: [],
				seen: [landed("zed", "1st", "bob")],
			});
		});

		it("lands a step-down at the top of the tier just before its first open row", async () => {
			const {service, moveTo, moveNode, seen} = exactService();
			await service.move({root: "work", nodeId: "zed", toTier: "2nd", beforeNodeId: "alice"});
			expect({moveTo: moveTo.mock.calls, moveNode: moveNode.mock.calls, seen}).toStrictEqual({
				moveTo: [["zed", "second", 1]],
				moveNode: [],
				seen: [landed("zed", "1st", "alice")],
			});
		});

		it("lands a row at the bottom of the tier after every child", async () => {
			const {service, moveTo, moveNode, seen} = exactService();
			await service.move({root: "work", nodeId: "zed", toTier: "2nd"});
			expect({moveTo: moveTo.mock.calls, moveNode: moveNode.mock.calls, seen}).toStrictEqual({
				moveTo: [["zed", "second", 4]],
				moveNode: [],
				seen: [landed("zed", "1st", "")],
			});
		});

		it("reorders within a tier with one move and no writes to the other rows", async () => {
			const {service, moveTo, moveNode, seen} = exactService();
			await service.move({root: "work", nodeId: "alice", toTier: "2nd", beforeNodeId: "charlie"});
			expect({moveTo: moveTo.mock.calls, moveNode: moveNode.mock.calls, seen}).toStrictEqual({
				moveTo: [["alice", "second", 3]],
				moveNode: [],
				seen: [landed("alice", "2nd", "charlie")],
			});
		});
	});
});

describe("ladder socket", () => {
	const event = (nodeId: string) => ({
		verb: "move" as const,
		nodeId,
		name: "A",
		fromTier: "1st",
		toTier: "2nd",
		at: "2026-09-13T00:00:00.000Z",
	});

	function connect(bus: LadderEventBus, options?: {replay?: boolean}) {
		const ws = {send: vi.fn<(data: string) => void>(), close: vi.fn<() => void>()};
		const handlers = ladderSocketHandlers(bus, options);
		handlers.onOpen?.({}, ws);
		return {ws, handlers};
	}

	describe("ladderSocketHandlers", () => {
		it("sends one frame per write so Monitor raises one notification per edit", () => {
			const bus = new LadderEventBus();
			const {ws} = connect(bus);
			bus.publish(event("a"));
			bus.publish(event("b"));
			expect(ws.send).toHaveBeenCalledTimes(2);
			expect(JSON.parse(ws.send.mock.calls[0][0])).toMatchObject({nodeId: "a", verb: "move"});
		});

		it("replays buffered writes to a watcher that connects late", () => {
			const bus = new LadderEventBus();
			bus.publish(event("earlier"));
			const {ws} = connect(bus, {replay: true});
			expect(JSON.parse(ws.send.mock.calls[0][0])).toMatchObject({nodeId: "earlier"});
		});

		it("stops sending after the socket closes", () => {
			const bus = new LadderEventBus();
			const {ws, handlers} = connect(bus);
			handlers.onClose?.({}, ws);
			bus.publish(event("a"));
			expect(ws.send).not.toHaveBeenCalled();
		});
	});
});

describe("ladder state", () => {
	const ladder = (): Record<string, Ladder> => ({
		work: {
			root: "work",
			bucketId: "wb",
			tiers: [
				{
					tier: 1,
					label: "1st",
					id: "w1",
					capacity: 2,
					state: "exact",
					items: [
						{id: "a", name: "A", children: [], descendantCount: 0},
						{id: "b", name: "B", children: [], descendantCount: 0},
					],
				},
				{tier: 2, label: "2nd", id: "w2", capacity: 4, state: "room", items: []},
			],
		},
	});

	describe("moveWithin", () => {
		it("relocates the row and recomputes both tiers capacity state", () => {
			const next = moveWithin(ladder(), "work", "a", "2nd");
			expect(next.work.tiers[0].items.map((i) => i.id)).toStrictEqual(["b"]);
			expect(next.work.tiers[0].state).toBe("room");
			expect(next.work.tiers[1].items.map((i) => i.id)).toStrictEqual(["a"]);
		});

		it("flags the destination as over once it passes its cap", () => {
			const start = ladder();
			start.work.tiers[1] = {
				...start.work.tiers[1],
				capacity: 1,
				items: [{id: "c", name: "C", children: [], descendantCount: 0}],
			};
			const next = moveWithin(start, "work", "a", "2nd");
			expect(next.work.tiers[1].state).toBe("over");
		});

		it("leaves the ladder untouched when the row is not on it", () => {
			const start = ladder();
			expect(moveWithin(start, "work", "missing", "2nd")).toBe(start);
		});
	});

	describe("applyLadderEvent", () => {
		it("applies a move announced over the socket", () => {
			const next = applyLadderEvent(ladder(), {
				verb: "move",
				nodeId: "a",
				name: "A",
				fromTier: "1st",
				toTier: "2nd",
				at: "T",
			});
			expect(next.work.tiers[1].items.map((i) => i.id)).toStrictEqual(["a"]);
		});

		it("drops a completed row off the ladder", () => {
			const next = applyLadderEvent(ladder(), {
				verb: "complete",
				nodeId: "a",
				name: "A",
				fromTier: "1st",
				toTier: null,
				at: "T",
			});
			expect(next.work.tiers[0].items.map((i) => i.id)).toStrictEqual(["b"]);
			expect(next.work.tiers[0].state).toBe("room");
		});

		it("ignores an event for a node it has never seen rather than inventing a row", () => {
			const start = ladder();
			expect(
				applyLadderEvent(start, {
					verb: "move",
					nodeId: "zz",
					name: "Z",
					fromTier: "1st",
					toTier: "2nd",
					at: "T",
				}),
			).toBe(start);
		});
	});

	describe("tierOf", () => {
		it("names the tier a row currently sits in", () => {
			expect(tierOf(ladder(), "work", "b")).toBe("1st");
		});

		it("returns undefined for a row that is not on that ladder", () => {
			expect(tierOf(ladder(), "work", "nope")).toBeUndefined();
			expect(tierOf(ladder(), "missing-root", "a")).toBeUndefined();
		});
	});

	describe("selectLadderRange", () => {
		it("includes both endpoints in either direction across tiers", () => {
			const input = ladder().work;
			input.tiers[1].items = [{id: "c", name: "Charlie", children: [], descendantCount: 0}];
			expect(selectLadderRange(input, "c", "a")).toStrictEqual(new Set(["a", "b", "c"]));
		});

		it("drops a stale selection anchor after a completion", () => {
			expect(selectLadderRange(ladder().work, "completed", "b")).toStrictEqual(new Set(["b"]));
		});
	});

	describe("ladderMoveSelection", () => {
		it("uses display order and drops completed rows from a selected group", () => {
			expect(ladderMoveSelection(ladder().work, new Set(["b", "completed", "a"]), "b")).toStrictEqual(["a", "b"]);
		});
		it("moves only the dragged row when it is outside the selection", () => {
			expect(ladderMoveSelection(ladder().work, new Set(["b"]), "a")).toStrictEqual(["a"]);
		});
	});

	describe("precise row placement", () => {
		it("reorders within a tier and applies the confirming event idempotently", () => {
			const moved = moveWithin(ladder(), "work", "b", "1st", "a");
			const event = {
				verb: "move" as const,
				nodeId: "b",
				name: "B",
				fromTier: "1st",
				toTier: "1st",
				beforeNodeId: "a",
				at: "2000-01-01T00:00:00.000Z",
			};
			expect(moved.work.tiers.map((tier) => tier.items.map((item) => item.id))).toStrictEqual([["b", "a"], []]);
			expect(applyLadderEvent(moved, event)).toStrictEqual(moved);
		});

		it("appends within the same tier when dropped after its last row", () => {
			const moved = moveWithin(ladder(), "work", "a", "1st", "");
			expect(moved.work.tiers.map((tier) => tier.items.map((item) => item.id))).toStrictEqual([["b", "a"], []]);
		});
	});

	describe("stepBeforeId", () => {
		const three = (): Record<string, Ladder> => ({
			work: {
				root: "work",
				bucketId: "wb",
				tiers: [
					{
						tier: 1,
						label: "1st",
						id: "w1",
						capacity: 2,
						state: "exact",
						items: [
							{id: "a", name: "A", children: [], descendantCount: 0},
							{id: "b", name: "B", children: [], descendantCount: 0},
						],
					},
					{
						tier: 2,
						label: "2nd",
						id: "w2",
						capacity: 4,
						state: "room",
						items: [
							{id: "c", name: "C", children: [], descendantCount: 0},
							{id: "d", name: "D", children: [], descendantCount: 0},
						],
					},
					{tier: 3, label: "3rd", id: "w3", capacity: 8, state: "room", items: []},
				],
			},
		});
		const step = (ladders: Record<string, Ladder>, ids: string[], toTier: string, direction: "up" | "down") => {
			const before = stepBeforeId(ladders.work, toTier, direction, ids);
			return ids.reduce((current, id) => moveWithin(current, "work", id, toTier, before), ladders);
		};
		const order = (ladders: Record<string, Ladder>) =>
			ladders.work.tiers.map((tier) => tier.items.map((item) => item.id));

		it("lands a row stepped down at the top of the next tier", () => {
			expect(stepBeforeId(three().work, "2nd", "down", ["b"])).toBe("c");
			expect(order(step(three(), ["b"], "2nd", "down"))).toStrictEqual([["a"], ["b", "c", "d"], []]);
		});

		it("lands a row stepped up at the bottom of the previous tier", () => {
			expect(stepBeforeId(three().work, "1st", "up", ["c"])).toBeUndefined();
			expect(order(step(three(), ["c"], "1st", "up"))).toStrictEqual([["a", "b", "c"], ["d"], []]);
		});

		it("appends when stepping down into an empty tier", () => {
			expect(stepBeforeId(three().work, "3rd", "down", ["c"])).toBeUndefined();
			expect(order(step(three(), ["c"], "3rd", "down"))).toStrictEqual([["a", "b"], ["d"], ["c"]]);
		});

		it("keeps a multi-row selection in display order in both directions", () => {
			expect(order(step(three(), ["a", "b"], "2nd", "down"))).toStrictEqual([[], ["a", "b", "c", "d"], []]);
			expect(order(step(three(), ["c", "d"], "1st", "up"))).toStrictEqual([["a", "b", "c", "d"], [], []]);
		});

		it("skips selected rows already in the destination when picking the anchor", () => {
			expect(stepBeforeId(three().work, "2nd", "down", ["b", "c"])).toBe("d");
		});
	});
});
