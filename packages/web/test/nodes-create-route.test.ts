import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {join} from "node:path";
import {readPendingOutbox} from "@outlinedb/shared/cache";
import * as schema from "@outlinedb/shared/db";
import type {ServerContext} from "../src/server/context.js";
import {readNodeConfig} from "../src/server/config.js";
import {buildServerContext} from "../src/server/context.js";
import {LadderEventBus} from "../src/server/ladder-events.js";
import {httpAppFor} from "./http-app-for.js";

const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");
const SEEDED = 1_600_000_000;
const NOW = 1_700_000_000;
const NEW_ID = "0b6f3c1e-2d4a-4b8c-9e7f-1a2b3c4d5e6f";

let sqlite: DatabaseConstructor.Database;
let ctx: ServerContext;
let outboxWritten: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() =>
{
	vi.useFakeTimers(
		{
			toFake: ["Date"],
		},
	);
	vi.setSystemTime(SEEDED * 1000);
	sqlite = new DatabaseConstructor(":memory:");
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
	// A mirror Node host: an API key and a saved internal session.
	ctx = buildServerContext(
		{
			db,
			config: readNodeConfig(
				{
					WORKFLOWY_API_KEY: "test-key",
				},
			),
			ladderEvents: new LadderEventBus(),
			internalAuth:
			{
				sessionStore:
				{
					read: () => "sessionid=test",
					write: () =>
					{
						// No login happens in this test.
					},
					clear: () =>
					{
						// No login happens in this test.
					},
				},
			},
		},
	);
	outboxWritten = vi.fn<() => void>();
	ctx.outboxWritten = outboxWritten;
	ctx.cacheService.insertNode(
		{
			id: "p",
			name: "p",
			note: null,
			priority: 0,
			createdAt: SEEDED,
			modifiedAt: SEEDED,
			completedAt: null,
		},
		null,
	);
	// Writes start later than the seed: a unit of work may not overwrite a version from its own millisecond.
	vi.setSystemTime(NOW * 1000);
	// workflowy.com is down; a mirror write must not wait on it.
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("workflowy.com is unreachable"));
});

afterEach(() =>
{
	vi.useRealTimers();
	vi.restoreAllMocks();
	sqlite.close();
});

async function post(body: unknown): Promise<Response>
{
	return httpAppFor(ctx).fetch(
		new Request(
			"http://x/api/v1/nodes",
			{
				method: "POST",
				headers:
				{
					"content-type": "application/json",
				},
				body: JSON.stringify(body),
			},
		),
	);
}

describe("POST /api/v1/nodes", () =>
{
	it("creates a mirror-mode node locally while workflowy.com is down, leaves a pending create row and triggers a drain", async () =>
	{
		const res = await post(
			{
				parent_id: "p",
				name: "",
				id: NEW_ID,
			},
		);

		await Promise.resolve();
		expect(
			{
				status: res.status,
				body: await res.json(),
				pending: readPendingOutbox(ctx.db, 100).map(({nodeId, aspect, lastError}) => (
				{
					nodeId,
					aspect,
					lastError,
				})),
				drains: outboxWritten.mock.calls.length,
				fetches: vi.mocked(globalThis.fetch).mock.calls.length,
			},
		).toStrictEqual(
			{
				status: 201,
				body:
				{
					node:
					{
						id: NEW_ID,
						parent_id: "p",
						name: "",
						note: null,
						priority: 0,
						data:
						{
							layoutMode: null,
						},
						numberedStart: null,
						createdAt: NOW,
						modifiedAt: NOW,
						completedAt: null,
						hasChildren: false,
						hasUncompletedChildren: false,
						isMirror: false,
						hasMirrors: false,
						originalNodeId: null,
						attachment: null,
						defaultToBottom: false,
						calendar: null,
						table: null,
					},
				},
				pending: [
					{
						nodeId: NEW_ID,
						aspect: "create",
						lastError: null,
					},
					{
						nodeId: NEW_ID,
						aspect: "placement",
						lastError: null,
					},
				],
				drains: 1,
				fetches: 0,
			},
		);
	});

	it("rejects a body with no name", async () =>
	{
		const res = await post(
			{
				parent_id: "p",
			},
		);

		expect(
			{
				status: res.status,
				body: await res.json(),
				pending: readPendingOutbox(ctx.db, 100),
			},
		).toStrictEqual(
			{
				status: 400,
				body:
				{
					error: "Invalid request body",
				},
				pending: [],
			},
		);
	});
});
