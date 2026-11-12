import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {sql} from "drizzle-orm";
import {join} from "node:path";
import {describe, expect, it} from "vite-plus/test";
import * as schema from "@outlinedb/shared/db";
import type {ServerContext} from "../src/server/context.js";
import {httpAppFor} from "./http-app-for.js";

/** No internal adapter: our What's New read state lives only in our own database, never in upstream's root metadata. */
function setup()
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
			migrationsFolder: join(import.meta.dirname, "../../shared/src/db/migrations"),
		},
	);
	const ctx =
	{
		db,
		internalAdapter: () =>
		{
		},
	} as unknown as ServerContext;
	const app = httpAppFor(ctx);
	const request = async (method: string, path: string, body?: unknown) =>
	{
		const res = await app.fetch(
			new Request(
				`http://x/api/v1/whats-new${path}`,
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
			body: (await res.json()) as unknown,
		};
	};
	const rows = () =>
		db.all<
		{
			entry: string;
			open: number;
		}>(
			sql`SELECT entry, system_to = '9999-12-31 23:59:59' AS open FROM whats_new_reads ORDER BY entry, system_from`,
		);
	return {
		request,
		rows,
	};
}

describe("/api/v1/whats-new", () =>
{
	it("GET answers no read entries on a fresh database", async () =>
	{
		const {request} = setup();

		await expect(request("GET", "")).resolves.toStrictEqual(
			{
				status: 200,
				body:
				{
					read: [],
				},
			},
		);
	});

	it("POST /read stores each entry once as a live temporal row and answers every read entry, sorted", async () =>
	{
		const {request, rows} = setup();

		const first = await request(
			"POST",
			"/read",
			{
				entries: ["b_entry", "a_entry"],
			},
		);
		const second = await request(
			"POST",
			"/read",
			{
				entries: ["a_entry", "c_entry"],
			},
		);
		const read = await request("GET", "");

		expect(
			{
				first,
				second,
				read,
				rows: rows(),
			},
		).toStrictEqual(
			{
				first:
				{
					status: 200,
					body:
					{
						read: ["a_entry", "b_entry"],
					},
				},
				second:
				{
					status: 200,
					body:
					{
						read: ["a_entry", "b_entry", "c_entry"],
					},
				},
				read:
				{
					status: 200,
					body:
					{
						read: ["a_entry", "b_entry", "c_entry"],
					},
				},
				rows: [
					{
						entry: "a_entry",
						open: 1,
					},
					{
						entry: "b_entry",
						open: 1,
					},
					{
						entry: "c_entry",
						open: 1,
					},
				],
			},
		);
	});

	it("POST /read rejects a malformed body or entry id without writing", async () =>
	{
		const {request, rows} = setup();

		const statuses = await Promise.all([
			request("POST", "/read", {}),
			request(
				"POST",
				"/read",
				{
					entries: ["Not An Id"],
				},
			),
			request(
				"POST",
				"/read",
				{
					entries: "a_entry",
				},
			),
		]);

		expect(
			{
				statuses: statuses.map((response) => response.status),
				rows: rows(),
			},
		).toStrictEqual(
			{
				statuses: [400, 400, 400],
				rows: [],
			},
		);
	});
});
