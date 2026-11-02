import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {join} from "node:path";
import {describe, expect, it, vi} from "vite-plus/test";
import {CacheService} from "@outlinedb/shared/cache";
import * as schema from "@outlinedb/shared/db";
import {nodeContent, nodeMetadata} from "@outlinedb/shared/db";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import type {ServerContext} from "../src/server/context.js";
import {LadderEventBus} from "../src/server/ladder-events.js";
import type {LadderEvent} from "../src/server/ladder-events.js";
import {httpAppFor} from "./http-app-for.js";

const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");
const SEEDED_AT = "2026-01-01 00:00:00.000";

let counter = 0;
function seed(db: ReturnType<typeof drizzle<typeof schema>>, name: string, parentId: string | null): string
{
	counter += 1;
	const id = `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
	db.insert(nodeContent)
		.values(
			{
				id,
				name,
				note: null,
				parentId,
				systemFrom: SEEDED_AT,
				systemTo: FAR_FUTURE_DATE,
			},
		)
		.run();
	db.insert(nodeMetadata)
		.values(
			{
				nodeId: id,
				shortId: id.slice(-12),
				priority: counter,
				systemFrom: SEEDED_AT,
				systemTo: FAR_FUTURE_DATE,
			},
		)
		.run();
	return id;
}

describe("ladder route event bus", () =>
{
	it("publishes a move on the bus injected through the context, once", async () =>
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
		let row = "";
		let secondTier = "";
		for (const [root, bucket] of [
			["Work", "📌 Tasks (asap) (work)"],
			["Personal", "📌 Tasks (asap) (personal)"],
		] as const)
		{
			const next = seed(db, `☑️ Next (${root})`, seed(db, root, null));
			const bucketId = seed(db, bucket, seed(db, "✅ Tasks", next));
			const first = seed(db, "1st", bucketId);
			const second = seed(db, "2nd", bucketId);
			if (root === "Work")
			{
				row = seed(db, "Write report", first);
				secondTier = second;
			}
		}
		const events = new LadderEventBus();
		const received: LadderEvent[] = [];
		events.subscribe((event) =>
		{
			received.push(event);
		});
		const moveTo = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
		const ctx =
		{
			db,
			cacheService: new CacheService(db),
			config: {},
			apiKey: "key",
			ladderEvents: events,
			internalAdapter: () => (
			{
				moveTo,
			}),
		} as unknown as ServerContext;
		const app = httpAppFor(ctx);

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
							node_id: row,
							to_tier: "2nd",
						},
					),
				},
			),
		);

		expect(res.status).toBe(200);
		expect(moveTo).toHaveBeenCalledWith(
			{
				ids: [row],
				parentId: secondTier,
				index: 0,
			},
		);
		expect(received).toStrictEqual([
			expect.objectContaining(
				{
					verb: "move",
					nodeId: row,
					name: "Write report",
					fromTier: "1st",
					toTier: "2nd",
				},
			),
		]);
	});
});
