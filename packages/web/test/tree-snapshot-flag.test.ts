import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {join} from "node:path";
import {afterEach, describe, expect, it} from "vite-plus/test";
import type {Hono} from "hono";
import * as schema from "@outlinedb/shared/db";
import {mirrors, nodeContent, nodeMetadata} from "@outlinedb/shared/db";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import {nodeTreeHost} from "../src/server/node-host.js";
import type {ServerContext} from "../src/server/context.js";
import {httpAppFor} from "./http-app-for.js";
import {bindTreeHost, peekTreeSnapshotRows} from "../src/server/tree-snapshot.js";

const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");
const SEEDED_AT = "2026-01-01 00:00:00.000";

const TREE: [id: string, parentId: string | null, name: string][] = [
	["root", null, "Root #project"],
	["a", "root", "Alpha needle @bob"],
	["a1", "a", "Alpha child needle"],
	["m", "root", "stale"],
	["b", "root", "Beta"],
	["other", null, "Other needle #tag"],
];

const open: DatabaseConstructor.Database[] = [];
afterEach(() =>
{
	for (const sqlite of open.splice(0))
	{
		sqlite.close();
	}
});

function seededDb(withHost: boolean)
{
	const sqlite = new DatabaseConstructor(":memory:");
	open.push(sqlite);
	const db = drizzle(
		sqlite,
		{
			schema,
		},
	);
	if (withHost)
	{
		bindTreeHost(db, nodeTreeHost(sqlite));
	}
	migrate(
		db,
		{
			migrationsFolder,
		},
	);
	TREE.forEach(([id, parentId, name], priority) =>
	{
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
					priority,
					systemFrom: SEEDED_AT,
					systemTo: FAR_FUTURE_DATE,
				},
			)
			.run();
	});
	db.insert(mirrors)
		.values(
			{
				mirrorId: "m",
				originalId: "other",
				systemFrom: SEEDED_AT,
				systemTo: FAR_FUTURE_DATE,
			},
		)
		.run();
	return db;
}

function appFor(db: ReturnType<typeof seededDb>, treeSnapshot: boolean)
{
	const ctx =
	{
		db,
		config:
		{
			features:
			{
				embeddings: false,
				treeSnapshot,
			},
		},
	} as unknown as ServerContext;
	return httpAppFor(ctx);
}

async function call(app: Hono, method: string, path: string, body?: unknown): Promise<unknown>
{
	const res = await app.fetch(
		new Request(
			`http://x${path}`,
			{
				method,
				headers:
				{
					"content-type": "application/json",
				},
				...(body === undefined
					? {}
					:
						{
							body: JSON.stringify(body),
						}),
			},
		),
	);
	return {
		status: res.status,
		body: await res.json(),
	};
}

const REQUESTS: [string, string, unknown?][] = [
	[
		"POST",
		"/api/search/tree",
		{
			query: "needle",
			rootId: null,
		},
	],
	[
		"POST",
		"/api/search/tree",
		{
			query: "needle",
			rootId: "root",
		},
	],
	[
		"POST",
		"/api/search/tree",
		{
			query: "is:backlink",
			rootId: null,
		},
	],
	[
		"POST",
		"/api/search/switcher",
		{
			query: "alp",
			limit: 10,
		},
	],
	[
		"POST",
		"/api/search/locations",
		{
			query: "needle",
			limit: 10,
		},
	],
	["GET", "/api/search/helpers?rootId="],
	["GET", "/api/search/helpers?rootId=root"],
];

describe("features.treeSnapshot", () =>
{
	it("serves the same search results from SQL as from the snapshot", async () =>
	{
		const withSnapshot = appFor(seededDb(true), true);
		const withoutSnapshot = appFor(seededDb(false), false);
		for (const [method, path, body] of REQUESTS)
		{
			const expected = await call(withSnapshot, method, path, body);
			const actual = await call(withoutSnapshot, method, path, body);
			expect(
				{
					path,
					body,
					result: actual,
				},
			).toStrictEqual(
				{
					path,
					body,
					result: expected,
				},
			);
		}
	});

	it("never builds a snapshot while the flag is off", async () =>
	{
		const db = seededDb(true);
		const app = appFor(db, false);
		for (const [method, path, body] of REQUESTS)
		{
			await call(app, method, path, body);
		}
		expect(peekTreeSnapshotRows(db)).toBeUndefined();
	});
});
