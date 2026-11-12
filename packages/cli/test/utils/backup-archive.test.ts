import {assert, beforeEach, afterEach, describe, expect, it} from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import
{
	buildMonthArchive,
	compressBuffer,
	compressFileInPlace,
	createMonthArchive,
	decompressBuffer,
	extractArchive,
	listArchiveEntries,
	listBackups,
	materializeBackup,
	readArchiveEntry,
	readBackupBytes,
	readBackupContent,
	readBackupFile,
	resolveBackupsDirectory,
} from "../../src/utils/backup-archive.js";

const dataName = (date: string): string => `(alice@example.com).${date}.workflowy.backup`;

describe("backup-archive", () =>
{
	let tmpDir: string;

	beforeEach(() =>
	{
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "backup-archive-test-"));
	});

	afterEach(() =>
	{
		fs.rmSync(
			tmpDir,
			{
				recursive: true,
				force: true,
			},
		);
	});

	describe("compressBuffer / decompressBuffer", () =>
	{
		it("round-trips an arbitrary buffer", () =>
		{
			const original = Buffer.from('{"hello":"world","nodes":[1,2,3]}');
			const restored = decompressBuffer(compressBuffer(original));
			expect(restored).toStrictEqual(original);
		});

		it("shrinks highly repetitive content", () =>
		{
			const original = Buffer.from("repeat ".repeat(10_000));
			expect(compressBuffer(original).length).toBeLessThan(original.length);
		});
	});

	describe("compressFileInPlace", () =>
	{
		it("creates a .zst file and removes the original", () =>
		{
			const filePath = path.join(tmpDir, dataName("2025-11-18"));
			fs.writeFileSync(filePath, '{"node":"value"}');

			const zstPath = compressFileInPlace(filePath);

			expect(zstPath).toBe(`${filePath}.zst`);
			expect(fs.existsSync(filePath)).toBe(false);
			expect(fs.existsSync(zstPath)).toBe(true);
			expect(readBackupFile(zstPath)).toBe('{"node":"value"}');
		});
	});

	describe("readBackupFile", () =>
	{
		it("reads a raw file unchanged", () =>
		{
			const filePath = path.join(tmpDir, dataName("2025-11-18"));
			fs.writeFileSync(filePath, '{"raw":true}');
			expect(readBackupFile(filePath)).toBe('{"raw":true}');
		});

		it("decompresses a .zst file", () =>
		{
			const filePath = path.join(tmpDir, `${dataName("2025-11-18")}.zst`);
			fs.writeFileSync(filePath, compressBuffer(Buffer.from('{"raw":false}')));
			expect(readBackupFile(filePath)).toBe('{"raw":false}');
		});
	});

	describe("month archives", () =>
	{
		it("creates, lists, and reads entries from a solid archive", () =>
		{
			const day1 = dataName("2025-09-04");
			const day2 = dataName("2025-09-05");
			fs.writeFileSync(path.join(tmpDir, day1), '{"day":1}');
			fs.writeFileSync(path.join(tmpDir, day2), '{"day":2}');

			const archivePath = path.join(tmpDir, "archive", "2025-09.tar.zst");
			createMonthArchive(archivePath, tmpDir, [day1, day2]);

			expect(fs.existsSync(archivePath)).toBe(true);
			expect(listArchiveEntries(archivePath).toSorted()).toStrictEqual([day1, day2].toSorted());
			expect(readArchiveEntry(archivePath, day1).toString("utf8")).toBe('{"day":1}');
			expect(readArchiveEntry(archivePath, day2).toString("utf8")).toBe('{"day":2}');
		});
	});

	describe("readBackupBytes", () =>
	{
		it("reads raw bytes unchanged", () =>
		{
			const filePath = path.join(tmpDir, dataName("2025-11-18"));
			fs.writeFileSync(filePath, '{"raw":1}');
			expect(readBackupBytes(filePath).toString("utf8")).toBe('{"raw":1}');
		});

		it("decompresses .zst bytes", () =>
		{
			const filePath = path.join(tmpDir, `${dataName("2025-11-18")}.zst`);
			fs.writeFileSync(filePath, compressBuffer(Buffer.from('{"raw":0}')));
			expect(readBackupBytes(filePath).toString("utf8")).toBe('{"raw":0}');
		});
	});

	describe("extractArchive", () =>
	{
		it("extracts every member of an archive", () =>
		{
			const day = dataName("2025-09-04");
			fs.writeFileSync(path.join(tmpDir, day), '{"day":1}');
			const archivePath = path.join(tmpDir, "archive", "2025-09.tar.zst");
			createMonthArchive(archivePath, tmpDir, [day]);

			const destDir = path.join(tmpDir, "extracted");
			extractArchive(archivePath, destDir);
			expect(fs.readFileSync(path.join(destDir, day), "utf8")).toBe('{"day":1}');
		});
	});

	describe("buildMonthArchive", () =>
	{
		it("archives raw and .zst loose files together", () =>
		{
			const rawDay = path.join(tmpDir, dataName("2025-09-04"));
			const zstDay = path.join(tmpDir, `${dataName("2025-09-05")}.zst`);
			fs.writeFileSync(rawDay, '{"day":4}');
			fs.writeFileSync(zstDay, compressBuffer(Buffer.from('{"day":5}')));

			const archivePath = path.join(tmpDir, "archive", "2025-09.tar.zst");
			buildMonthArchive(archivePath, [rawDay, zstDay]);

			// Members are stored uncompressed under their raw filenames.
			expect(listArchiveEntries(archivePath).toSorted()).toStrictEqual(
				[dataName("2025-09-04"), dataName("2025-09-05")].toSorted(),
			);
			expect(readArchiveEntry(archivePath, dataName("2025-09-05")).toString("utf8")).toBe('{"day":5}');
		});

		it("merges new files into an existing archive", () =>
		{
			const archivePath = path.join(tmpDir, "archive", "2025-09.tar.zst");
			const first = path.join(tmpDir, dataName("2025-09-04"));
			fs.writeFileSync(first, '{"day":4}');
			buildMonthArchive(archivePath, [first]);

			const second = path.join(tmpDir, dataName("2025-09-05"));
			fs.writeFileSync(second, '{"day":5}');
			buildMonthArchive(archivePath, [second]);

			expect(listArchiveEntries(archivePath).toSorted()).toStrictEqual(
				[dataName("2025-09-04"), dataName("2025-09-05")].toSorted(),
			);
		});
	});

	describe("readBackupContent", () =>
	{
		it("reads a loose location", () =>
		{
			const filePath = path.join(tmpDir, dataName("2025-11-18"));
			fs.writeFileSync(filePath, '{"loose":true}');
			expect(
				readBackupContent(
					{
						kind: "loose",
						filePath,
					},
				),
			).toBe('{"loose":true}');
		});

		it("reads an archive location", () =>
		{
			const day = dataName("2025-09-04");
			fs.writeFileSync(path.join(tmpDir, day), '{"archived":true}');
			const archivePath = path.join(tmpDir, "archive", "2025-09.tar.zst");
			createMonthArchive(archivePath, tmpDir, [day]);

			expect(
				readBackupContent(
					{
						kind: "archive",
						archivePath,
						entryName: day,
					},
				),
			).toBe('{"archived":true}');
		});
	});

	describe("materializeBackup", () =>
	{
		it("returns the path unchanged for loose locations", () =>
		{
			const filePath = path.join(tmpDir, dataName("2025-11-18"));
			fs.writeFileSync(filePath, "{}");
			const materialized = materializeBackup(
				{
					kind: "loose",
					filePath,
				},
			);
			expect(materialized.filePath).toBe(filePath);
			materialized.cleanup();
			expect(fs.existsSync(filePath)).toBe(true);
		});

		it("extracts an archive entry into a Data directory and cleans up", () =>
		{
			const day = dataName("2025-09-04");
			fs.writeFileSync(path.join(tmpDir, day), '{"archived":true}');
			const archivePath = path.join(tmpDir, "archive", "2025-09.tar.zst");
			createMonthArchive(archivePath, tmpDir, [day]);

			const materialized = materializeBackup(
				{
					kind: "archive",
					archivePath,
					entryName: day,
				},
			);

			expect(path.basename(materialized.filePath)).toBe(day);
			expect(path.basename(path.dirname(materialized.filePath))).toBe("Data");
			expect(readBackupFile(materialized.filePath)).toBe('{"archived":true}');

			materialized.cleanup();
			expect(fs.existsSync(materialized.filePath)).toBe(false);
		});
	});

	describe("listBackups", () =>
	{
		it("merges loose and archived Data backups sorted by date", () =>
		{
			const dataDir = path.join(tmpDir, "Data");
			const archiveDir = path.join(dataDir, "archive");
			fs.mkdirSync(
				archiveDir,
				{
					recursive: true,
				},
			);

			// Loose: one raw, one compressed.
			fs.writeFileSync(path.join(dataDir, dataName("2026-05-17")), '{"d":"17"}');
			fs.writeFileSync(
				path.join(dataDir, `${dataName("2026-05-16")}.zst`),
				compressBuffer(Buffer.from('{"d":"16"}')),
			);

			// Archived: an older month folded into a solid archive.
			const archived = dataName("2025-09-04");
			fs.writeFileSync(path.join(dataDir, archived), '{"d":"04"}');
			createMonthArchive(path.join(archiveDir, "2025-09.tar.zst"), dataDir, [archived]);
			fs.rmSync(path.join(dataDir, archived));

			const entries = listBackups(tmpDir);

			expect(entries.map((entry) => entry.filename)).toStrictEqual([
				dataName("2025-09-04"),
				`${dataName("2026-05-16")}.zst`,
				dataName("2026-05-17"),
			]);
			const [archivedEntry, compressedEntry, looseEntry] = entries;
			assert(archivedEntry && compressedEntry && looseEntry);
			expect(archivedEntry.location).toStrictEqual(
				{
					kind: "archive",
					archivePath: path.join(archiveDir, "2025-09.tar.zst"),
					entryName: dataName("2025-09-04"),
				},
			);
			expect(looseEntry.location).toStrictEqual(
				{
					kind: "loose",
					filePath: path.join(dataDir, dataName("2026-05-17")),
				},
			);
			expect(readBackupContent(archivedEntry.location)).toBe('{"d":"04"}');
			expect(readBackupContent(compressedEntry.location)).toBe('{"d":"16"}');
		});

		it("returns an empty list when no backups directory exists", () =>
		{
			expect(listBackups(path.join(tmpDir, "missing"))).toStrictEqual([]);
		});
	});

	describe("resolveBackupsDirectory", () =>
	{
		let originalEnv: string | undefined;

		beforeEach(() =>
		{
			originalEnv = process.env.OUTLINEDB_BACKUPS_DIR;
		});

		afterEach(() =>
		{
			if (originalEnv === undefined)
			{
				delete process.env.OUTLINEDB_BACKUPS_DIR;
			}
			else
			{
				process.env.OUTLINEDB_BACKUPS_DIR = originalEnv;
			}
		});

		it("defaults to the backups directory under the working directory", () =>
		{
			delete process.env.OUTLINEDB_BACKUPS_DIR;

			expect(resolveBackupsDirectory()).toBe(path.join(process.cwd(), "backups"));
		});

		it("honors OUTLINEDB_BACKUPS_DIR so tests never touch the real backups", () =>
		{
			process.env.OUTLINEDB_BACKUPS_DIR = tmpDir;

			expect(resolveBackupsDirectory()).toBe(tmpDir);
		});

		it("ignores an empty OUTLINEDB_BACKUPS_DIR", () =>
		{
			process.env.OUTLINEDB_BACKUPS_DIR = "";

			expect(resolveBackupsDirectory()).toBe(path.join(process.cwd(), "backups"));
		});
	});
});
