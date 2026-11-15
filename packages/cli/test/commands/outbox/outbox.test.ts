import {it, vi, afterEach, expect, describe, beforeEach} from "vite-plus/test";
import {captureOutput} from "@oclif/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {MockInstance} from "vite-plus/test";
import Update from "../../../src/commands/node/update.js";
import Drain from "../../../src/commands/outbox/drain.js";
import Status from "../../../src/commands/outbox/status.js";
import type {OutboxStatusReport} from "../../../src/commands/outbox/status.js";
import {cleanupTestDatabase, createTestDatabase, nodeFixtures, seedTestData} from "../../db/migration-helper.js";
import type {TestDatabase} from "../../db/migration-helper.js";
import {createTestNode} from "../../helpers/node-fixtures.js";
import {fakeUpstream, isolateInternalAuth, pendingOutbox} from "../../helpers/upstream-outbox.js";

describe("outbox commands", () =>
{
	let originalEnv: typeof process.env;
	let fetchStub: MockInstance<typeof fetch>;
	let tempDir: string;
	let testDatabase: TestDatabase;

	beforeEach(() =>
	{
		originalEnv =
		{
			...process.env,
		};
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "outlinedb-outbox-test-"));
		const testDbPath = path.join(tempDir, "test.sqlite");
		testDatabase = createTestDatabase(testDbPath);
		process.env.OUTLINEDB_DB_PATH = testDbPath;
		process.env.WORKFLOWY_API_KEY = "test-api-key";
		isolateInternalAuth(tempDir);
		fetchStub = vi.spyOn(globalThis, "fetch");
		seedTestData(
			testDatabase,
			nodeFixtures([
				createTestNode(
					{
						id: "node-id",
						name: "Old",
						parentId: null,
					},
				),
			]),
		);
	});

	afterEach(() =>
	{
		vi.restoreAllMocks();
		process.env = originalEnv;
		cleanupTestDatabase(testDatabase);
		fs.rmSync(
			tempDir,
			{
				recursive: true,
				force: true,
			},
		);
	});

	it("status reports a failed write's pending rows, and drain delivers them", async () =>
	{
		fakeUpstream(
			fetchStub,
			testDatabase,
			tempDir,
			{
				failPush: true,
			},
		);
		await captureOutput(async () =>
		{
			await Update.run(["--id", "node-id", "--name", "New"]);
		});
		let failed: OutboxStatusReport | undefined;
		await captureOutput(async () =>
		{
			failed = await Status.run(["--json"]);
		});
		const failedText = await captureOutput(async () =>
		{
			await Status.run([]);
		});

		const upstream = fakeUpstream(fetchStub, testDatabase, tempDir);
		const drain = await captureOutput(async () =>
		{
			await Drain.run([]);
		});
		const drained = await captureOutput(async () =>
		{
			await Status.run([]);
		});

		expect(
			{
				failed: failed &&
				{
					...failed,
					oldestEnqueuedAt: typeof failed.oldestEnqueuedAt,
					rows: failed.rows.map((row) => (
					{
						...row,
						enqueuedAt: row.enqueuedAt === failed?.oldestEnqueuedAt,
					})),
				},
				failedText: failedText.stdout.replaceAll(failed?.oldestEnqueuedAt ?? "", "<enqueued>"),
				drain: drain.stdout,
				drainError: drain.error,
				drained: drained.stdout,
				pushes: upstream.pushes,
				pending: pendingOutbox(testDatabase),
			},
		).toStrictEqual(
			{
				failed:
				{
					pending: 1,
					oldestEnqueuedAt: "string",
					lastError: "Workflowy rejected the operations: upstream_rejected",
					rows: [
						{
							nodeId: "node-id",
							name: "New",
							aspect: "name",
							enqueuedAt: true,
							lastError: "Workflowy rejected the operations: upstream_rejected",
						},
					],
				},
				failedText: [
					"Pending: 1",
					"Oldest: <enqueued>",
					"Last error: Workflowy rejected the operations: upstream_rejected",
					"node-id  name  <enqueued>  New",
					"  last error: Workflowy rejected the operations: upstream_rejected",
					"",
				].join("\n"),
				drain: "Outbox drained: nothing pending\n",
				drainError: undefined,
				drained: "Pending: 0\n",
				pushes: [
					[
						{
							type: "edit",
							data:
							{
								projectid: "node-id",
								name: "New",
								metadataPatches: [],
								metadataInversePatches: [],
							},
						},
					],
				],
				pending: [],
			},
		);
	});
});
