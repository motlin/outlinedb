import {beforeEach, vi, afterEach, describe, expect, it} from "vite-plus/test";
import {backupImports, mirrors, nodeContent, nodeMetadata, referencesRoots} from "@outlinedb/shared/db";
import {z} from "zod";
import {formatTemporalTimestamp} from "@outlinedb/shared/temporal";
import type {NewNodeContent, NewNodeMetadata} from "@outlinedb/shared/db";
import {captureOutput} from "@oclif/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {MockInstance} from "vite-plus/test";
import Status from "../../../src/commands/cache/status.js";
import {cleanupTestDatabase, createTestDatabase} from "../../db/migration-helper.js";
import type {TestDatabase} from "../../db/migration-helper.js";

describe("cache:status command", () =>
{
	let fsExistsSyncStub: MockInstance;
	let fsStatSyncStub: MockInstance;
	let tempDir: string;
	let testDbPath: string;
	let testDatabase: TestDatabase;
	let originalDbPath: string | undefined;

	beforeEach(() =>
	{
		vi.useFakeTimers(
			{
				shouldAdvanceTime: true,
			},
		);
		vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));

		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "outlinedb-test-"));
		testDbPath = path.join(tempDir, "test.sqlite");
		testDatabase = createTestDatabase(testDbPath);

		originalDbPath = process.env.OUTLINEDB_DB_PATH;
		process.env.OUTLINEDB_DB_PATH = testDbPath;

		testDatabase.db.run("PRAGMA foreign_keys = OFF");
		testDatabase.db.delete(nodeContent).run();
		testDatabase.db.delete(nodeMetadata).run();
		testDatabase.db.run("PRAGMA foreign_keys = ON");

		fsExistsSyncStub = vi.spyOn(fs, "existsSync");
		fsStatSyncStub = vi.spyOn(fs, "statSync");
	});

	afterEach(() =>
	{
		vi.useRealTimers();
		cleanupTestDatabase(testDatabase);

		if (originalDbPath === undefined)
		{
			delete process.env.OUTLINEDB_DB_PATH;
		}
		else
		{
			process.env.OUTLINEDB_DB_PATH = originalDbPath;
		}

		if (fs.existsSync(tempDir))
		{
			try
			{
				if (fs.existsSync(testDatabase.path))
				{
					fs.unlinkSync(testDatabase.path);
				}
				fs.rmdirSync(tempDir);
			}
			catch
			{
				// Ignore cleanup errors
			}
		}
	});

	describe("with empty database", () =>
	{
		it("displays zero counts for empty database", async () =>
		{
			fsExistsSyncStub.mockReturnValue(true);
			fsStatSyncStub.mockReturnValue(
				{
					size: 1024,
				},
			);

			const {stdout} = await captureOutput(async () =>
			{
				await Status.run([]);
			});

			expect(stdout).toBe(
				`📊 Cache Status\n\n📁 Cached Nodes: 0\n\n🔄 Last Sync:\n  No data cached\n\n💾 Backup Import:\n  No backup data imported\n\n💿 Database:\n  File: ${
					testDbPath
				}\n  Size: 1.00 KB\n`,
			);
		});
	});

	describe("with cached nodes", () =>
	{
		beforeEach(() =>
		{
			const testNodeContent: NewNodeContent[] = [
				{
					id: "root-1",
					name: "Root Node 1",
					note: null,
					parentId: null,
					systemFrom: "2024-01-01 00:00:00",
					systemTo: "9999-12-31 23:59:59",
				},
				{
					id: "child-1",
					name: "Child Node 1",
					note: null,
					parentId: "root-1",
					systemFrom: "2024-01-01 00:00:00",
					systemTo: "9999-12-31 23:59:59",
				},
				{
					id: "child-2",
					name: "Child Node 2",
					note: null,
					parentId: "root-1",
					systemFrom: "2024-01-01 00:00:00",
					systemTo: "9999-12-31 23:59:59",
				},
			];

			const testNodeMetadata: NewNodeMetadata[] = [
				{
					nodeId: "root-1",
					createdAt: new Date(1_700_000_000 * 1000),
					modifiedAt: new Date(1_700_000_100 * 1000),
					completedAt: null,
					layoutMode: "bullets",
					systemFrom: "2024-01-01 00:00:00",
					systemTo: "9999-12-31 23:59:59",
				},
				{
					nodeId: "child-1",
					createdAt: new Date(1_700_000_200 * 1000),
					modifiedAt: new Date(1_700_000_300 * 1000),
					completedAt: new Date(1_700_000_400 * 1000),
					layoutMode: "todo",
					systemFrom: "2024-01-01 00:00:00",
					systemTo: "9999-12-31 23:59:59",
				},
				{
					nodeId: "child-2",
					createdAt: new Date(1_700_000_500 * 1000),
					modifiedAt: new Date(1_700_000_600 * 1000),
					completedAt: null,
					layoutMode: "bullets",
					systemFrom: "2024-01-01 00:00:00",
					systemTo: "9999-12-31 23:59:59",
				},
			];

			for (const content of testNodeContent)
			{
				testDatabase.db.insert(nodeContent).values(content).run();
			}
			for (const metadata of testNodeMetadata)
			{
				testDatabase.db.insert(nodeMetadata).values(metadata).run();
			}
		});

		it("displays correct node counts", async () =>
		{
			fsExistsSyncStub.mockReturnValue(true);
			fsStatSyncStub.mockReturnValue(
				{
					size: 2048,
				},
			);

			const {stdout} = await captureOutput(async () =>
			{
				await Status.run([]);
			});

			const seededSync = new Date("2024-01-01T00:00:00Z").toLocaleString();

			expect(stdout).toBe(
				`📊 Cache Status\n\n📁 Cached Nodes: 3\n\n🔄 Last Sync:\n  Time: ${
					seededSync
				}\n  Age: 2 years ago\n\n💾 Backup Import:\n  No backup data imported\n\n💿 Database:\n  File: ${
					testDbPath
				}\n  Size: 2.00 KB\n`,
			);
		});

		it("displays last sync from most recent node systemFrom", async () =>
		{
			const now = new Date();
			const tenSecondsAgo = new Date(now.getTime() - 10_000);
			const systemFromStr = formatTemporalTimestamp(tenSecondsAgo);

			testDatabase.db
				.insert(nodeContent)
				.values(
					{
						id: "recent-node",
						name: "Recent Node",
						note: null,
						parentId: null,
						systemFrom: systemFromStr,
						systemTo: "9999-12-31 23:59:59",
					},
				)
				.run();

			fsExistsSyncStub.mockReturnValue(true);
			fsStatSyncStub.mockReturnValue(
				{
					size: 3072,
				},
			);

			const {stdout} = await captureOutput(async () =>
			{
				await Status.run([]);
			});

			expect(stdout).toBe(
				`📊 Cache Status\n\n📁 Cached Nodes: 4\n\n🔄 Last Sync:\n  Time: ${tenSecondsAgo.toLocaleString()}\n  Age: 10 seconds ago\n\n💾 Backup Import:\n  No backup data imported\n\n💿 Database:\n  File: ${
					testDbPath
				}\n  Size: 3.00 KB\n`,
			);
		});

		it("displays backup import information when backup imports exist", async () =>
		{
			testDatabase.db
				.insert(backupImports)
				.values(
					{
						backupDate: "2024-01-15",
						filename: "test-backup.json",
						systemFrom: "2024-01-15 10:00:00",
						systemTo: "9999-12-31 23:59:59",
					},
				)
				.run();

			fsExistsSyncStub.mockReturnValue(true);
			fsStatSyncStub.mockReturnValue(
				{
					size: 4096,
				},
			);

			const {stdout} = await captureOutput(async () =>
			{
				await Status.run([]);
			});

			const seededSync = new Date("2024-01-01T00:00:00Z").toLocaleString();

			expect(stdout).toBe(
				`📊 Cache Status\n\n📁 Cached Nodes: 3\n\n🔄 Last Sync:\n  Time: ${
					seededSync
				}\n  Age: 2 years ago\n\n💾 Backup Import:\n  Last backup date: 2024-01-15\n\n💿 Database:\n  File: ${
					testDbPath
				}\n  Size: 4.00 KB\n`,
			);
		});
	});

	describe("with stranded relationship rows", () =>
	{
		beforeEach(() =>
		{
			const seeded =
			{
				systemFrom: "2024-01-01 00:00:00",
				systemTo: "9999-12-31 23:59:59",
			};
			for (const [id, parentId] of [
				["target", null],
				["refs", "target"],
				["item", "refs"],
			] as const)
			{
				testDatabase.db
					.insert(nodeContent)
					.values(
						{
							id,
							name: "",
							note: null,
							parentId,
							...seeded,
						},
					)
					.run();
			}
			testDatabase.db
				.insert(referencesRoots)
				.values(
					{
						nodeId: "refs",
						...seeded,
					},
				)
				.run();
			testDatabase.db
				.insert(mirrors)
				.values(
					{
						mirrorId: "item",
						originalId: "gone",
						...seeded,
					},
				)
				.run();
			fsExistsSyncStub.mockReturnValue(true);
			fsStatSyncStub.mockReturnValue(
				{
					size: 1024,
				},
			);
		});

		it("lists the stranded rows a delete or import left", async () =>
		{
			const {stdout} = await captureOutput(async () =>
			{
				await Status.run([]);
			});

			const seededSync = new Date("2024-01-01T00:00:00Z").toLocaleString();
			expect(stdout).toBe(
				`📊 Cache Status\n\n📁 Cached Nodes: 3\n\n🔄 Last Sync:\n  Time: ${
					seededSync
				}\n  Age: 2 years ago\n\n💾 Backup Import:\n  No backup data imported\n\n⚠️ Stranded Rows:\n  Backlink items without an original: 1\n  Mirror rows without both nodes: 1\n  References roots without a node: 0\n\n💿 Database:\n  File: ${
					testDbPath
				}\n  Size: 1.00 KB\n`,
			);
		});

		it("returns the stranded counts as JSON", async () =>
		{
			const {stdout} = await captureOutput(async () =>
			{
				await Status.run(["--json"]);
			});

			expect(
				z
					.object(
						{
							stranded: z.unknown(),
						},
					)
					.parse(JSON.parse(stdout)).stranded,
			).toStrictEqual(
				{
					backlinkItems: 1,
					mirrors: 1,
					referencesRoots: 0,
				},
			);
		});
	});

	describe("database file size formatting", () =>
	{
		it("formats bytes correctly", async () =>
		{
			fsExistsSyncStub.mockReturnValue(true);
			fsStatSyncStub.mockReturnValue(
				{
					size: 512,
				},
			);

			const {stdout} = await captureOutput(async () =>
			{
				await Status.run([]);
			});

			expect(stdout).toBe(
				`📊 Cache Status\n\n📁 Cached Nodes: 0\n\n🔄 Last Sync:\n  No data cached\n\n💾 Backup Import:\n  No backup data imported\n\n💿 Database:\n  File: ${
					testDbPath
				}\n  Size: 512 bytes\n`,
			);
		});

		it("formats kilobytes correctly", async () =>
		{
			fsExistsSyncStub.mockReturnValue(true);
			fsStatSyncStub.mockReturnValue(
				{
					size: 10_240,
				},
			);

			const {stdout} = await captureOutput(async () =>
			{
				await Status.run([]);
			});

			expect(stdout).toBe(
				`📊 Cache Status\n\n📁 Cached Nodes: 0\n\n🔄 Last Sync:\n  No data cached\n\n💾 Backup Import:\n  No backup data imported\n\n💿 Database:\n  File: ${
					testDbPath
				}\n  Size: 10.00 KB\n`,
			);
		});

		it("formats megabytes correctly", async () =>
		{
			fsExistsSyncStub.mockReturnValue(true);
			fsStatSyncStub.mockReturnValue(
				{
					size: 5 * 1024 * 1024,
				},
			);

			const {stdout} = await captureOutput(async () =>
			{
				await Status.run([]);
			});

			expect(stdout).toBe(
				`📊 Cache Status\n\n📁 Cached Nodes: 0\n\n🔄 Last Sync:\n  No data cached\n\n💾 Backup Import:\n  No backup data imported\n\n💿 Database:\n  File: ${
					testDbPath
				}\n  Size: 5.00 MB\n`,
			);
		});
	});

	describe("time formatting", () =>
	{
		it("formats recent times as seconds ago", async () =>
		{
			const now = new Date();
			const tenSecondsAgo = new Date(now.getTime() - 10_000);
			const systemFromStr = formatTemporalTimestamp(tenSecondsAgo);

			testDatabase.db
				.insert(nodeContent)
				.values(
					{
						id: "test-1",
						name: "Test",
						note: null,
						parentId: null,
						systemFrom: systemFromStr,
						systemTo: "9999-12-31 23:59:59",
					},
				)
				.run();

			fsExistsSyncStub.mockReturnValue(true);
			fsStatSyncStub.mockReturnValue(
				{
					size: 1024,
				},
			);

			const {stdout} = await captureOutput(async () =>
			{
				await Status.run([]);
			});

			expect(stdout).toBe(
				`📊 Cache Status\n\n📁 Cached Nodes: 1\n\n🔄 Last Sync:\n  Time: ${tenSecondsAgo.toLocaleString()}\n  Age: 10 seconds ago\n\n💾 Backup Import:\n  No backup data imported\n\n💿 Database:\n  File: ${
					testDbPath
				}\n  Size: 1.00 KB\n`,
			);
		});

		it("formats times as minutes ago", async () =>
		{
			const now = new Date();
			const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
			const systemFromStr = formatTemporalTimestamp(fiveMinutesAgo);

			testDatabase.db
				.insert(nodeContent)
				.values(
					{
						id: "test-2",
						name: "Test",
						note: null,
						parentId: null,
						systemFrom: systemFromStr,
						systemTo: "9999-12-31 23:59:59",
					},
				)
				.run();

			fsExistsSyncStub.mockReturnValue(true);
			fsStatSyncStub.mockReturnValue(
				{
					size: 1024,
				},
			);

			const {stdout} = await captureOutput(async () =>
			{
				await Status.run([]);
			});

			expect(stdout).toBe(
				`📊 Cache Status\n\n📁 Cached Nodes: 1\n\n🔄 Last Sync:\n  Time: ${fiveMinutesAgo.toLocaleString()}\n  Age: 5 minutes ago\n\n💾 Backup Import:\n  No backup data imported\n\n💿 Database:\n  File: ${
					testDbPath
				}\n  Size: 1.00 KB\n`,
			);
		});
	});
});
