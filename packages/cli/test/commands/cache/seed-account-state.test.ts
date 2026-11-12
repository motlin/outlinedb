import {afterEach, beforeEach, describe, expect, it} from "vite-plus/test";
import {readAccountState, replaceExpansion, runUnitOfWork, writeAccountSnapshot} from "@outlinedb/shared/cache";
import {captureOutput} from "@oclif/test";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import SeedAccountState from "../../../src/commands/cache/seed-account-state.js";
import {cleanupTestDatabase, createTestDatabase} from "../../db/migration-helper.js";
import type {TestDatabase} from "../../db/migration-helper.js";

describe("cache:seed-account-state command", () =>
{
	let tempDir: string;
	let testDatabase: TestDatabase;
	let originalDbPath: string | undefined;
	let server: http.Server;
	let received:
	{
		method?: string;
		url?: string;
		body: string;
	}[];
	let receivedHeaders: http.IncomingHttpHeaders[];

	beforeEach(async () =>
	{
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "outlinedb-seed-test-"));
		const testDbPath = path.join(tempDir, "test.sqlite");
		testDatabase = createTestDatabase(testDbPath);
		originalDbPath = process.env.OUTLINEDB_DB_PATH;
		process.env.OUTLINEDB_DB_PATH = testDbPath;
		received = [];
		receivedHeaders = [];
		server = http.createServer((request, response) =>
		{
			let body = "";
			request.on("data", (chunk: Buffer) =>
			{
				body += chunk.toString();
			});
			request.on("end", () =>
			{
				receivedHeaders.push(request.headers);
				received.push(
					{
						method: request.method,
						url: request.url,
						body,
					},
				);
				response.setHeader("content-type", "application/json");
				response.end(
					JSON.stringify(
						{
							rows: 4,
							expandedKeys: 1,
						},
					),
				);
			});
		});
		await new Promise<void>((resolve) =>
		{
			server.listen(0, "127.0.0.1", () =>
			{
				resolve();
			});
		});
	});

	afterEach(async () =>
	{
		await new Promise<void>((resolve) =>
		{
			server.close(() =>
			{
				resolve();
			});
		});
		cleanupTestDatabase(testDatabase);
		if (originalDbPath === undefined)
		{
			delete process.env.OUTLINEDB_DB_PATH;
		}
		else
		{
			process.env.OUTLINEDB_DB_PATH = originalDbPath;
		}
		fs.rmSync(
			tempDir,
			{
				recursive: true,
				force: true,
			},
		);
	});

	it("PUTs the account state (every account table's live rows and the expanded keys) to the admin route", async () =>
	{
		runUnitOfWork(testDatabase.db, (unitOfWork) =>
		{
			writeAccountSnapshot(
				unitOfWork,
				{
					account:
					{
						userId: "1",
						dateJoinedSec: 2,
					},
					rootMetadata:
					{
						color:
						{
							tags:
							{
								"#a": 1,
							},
						},
					},
					settings:
					{
						theme: "dark",
					},
					visibleFeatures: [],
				},
			);
			replaceExpansion(unitOfWork, ["aaaaaaaa"], 1000);
		});
		const address = server.address();
		const port = typeof address === "object" && address ? address.port : 0;

		const {stdout} = await captureOutput(async () =>
			SeedAccountState.run(["--url", `http://127.0.0.1:${port}`, "--json"]),
		);

		expect(
			{
				received: received.map(({method, url, body}) => (
				{
					method,
					url,
					body: JSON.parse(body) as unknown,
				})),
				result: JSON.parse(stdout) as unknown,
			},
		).toStrictEqual(
			{
				received: [
					{
						method: "PUT",
						url: "/api/admin/account-state",
						body: structuredClone(readAccountState(testDatabase.db)),
					},
				],
				result:
				{
					rows: 4,
					expandedKeys: 1,
				},
			},
		);
	});

	async function seed(...extra: string[]): Promise<void>
	{
		const address = server.address();
		const port = typeof address === "object" && address ? address.port : 0;
		await captureOutput(async () =>
			SeedAccountState.run(["--url", `http://127.0.0.1:${port}`, "--json", ...extra]),
		);
	}

	it("sends no Access headers by default", async () =>
	{
		await seed();
		expect(receivedHeaders[0]?.["cf-access-client-id"]).toBeUndefined();
		expect(receivedHeaders[0]?.["cf-access-client-secret"]).toBeUndefined();
	});

	it("sends Access service-token headers from flags", async () =>
	{
		await seed("--access-client-id", "id-1.access", "--access-client-secret", "secret-1");
		expect(receivedHeaders[0]?.["cf-access-client-id"]).toBe("id-1.access");
		expect(receivedHeaders[0]?.["cf-access-client-secret"]).toBe("secret-1");
	});

	it("sends Access service-token headers from CF_ACCESS_* env vars", async () =>
	{
		process.env.CF_ACCESS_CLIENT_ID = "env-id.access";
		process.env.CF_ACCESS_CLIENT_SECRET = "env-secret";
		try
		{
			await seed();
		}
		finally
		{
			delete process.env.CF_ACCESS_CLIENT_ID;
			delete process.env.CF_ACCESS_CLIENT_SECRET;
		}
		expect(receivedHeaders[0]?.["cf-access-client-id"]).toBe("env-id.access");
		expect(receivedHeaders[0]?.["cf-access-client-secret"]).toBe("env-secret");
	});
});
