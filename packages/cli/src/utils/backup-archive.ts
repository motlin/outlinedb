import {execFileSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {constants as zlibConstants, zstdCompressSync, zstdDecompressSync} from "node:zlib";
import {parseBackupFilename} from "./backup-validation.js";
import {nonEmpty} from "./non-empty.js";

const ZSTD_LEVEL = 19;
const ZSTD_WINDOW_LOG = 27;

/** zstd CLI invocation used as tar's compressor for solid monthly archives. */
const ZSTD_COMPRESS_PROGRAM = `zstd -${ZSTD_LEVEL} --long=30`;
const ZSTD_DECOMPRESS_PROGRAM = "zstd -d --long=31";

/** Decompressed backup files can exceed 64 MB; give tar/exec room. */
const EXEC_MAX_BUFFER = 256 * 1024 * 1024;

export type BackupLocation =
	|
	  {
			kind: "loose";
			filePath: string;
	  }
	|
	  {
			kind: "archive";
			archivePath: string;
			entryName: string;
	  };

export interface BackupEntry
{
	filename: string;
	backupDate: Date;
	location: BackupLocation;
}

export function compressBuffer(data: Buffer): Buffer
{
	return zstdCompressSync(
		data,
		{
			params:
			{
				[zlibConstants.ZSTD_c_compressionLevel]: ZSTD_LEVEL,
				[zlibConstants.ZSTD_c_enableLongDistanceMatching]: 1,
				[zlibConstants.ZSTD_c_windowLog]: ZSTD_WINDOW_LOG,
			},
		},
	);
}

export function decompressBuffer(data: Buffer): Buffer
{
	return zstdDecompressSync(data);
}

/** Compress a file to `<path>.zst`, delete the original, and return the new path. */
export function compressFileInPlace(filePath: string): string
{
	const zstPath = `${filePath}.zst`;
	fs.writeFileSync(zstPath, compressBuffer(fs.readFileSync(filePath)));
	fs.rmSync(filePath);
	return zstPath;
}

/** Read a backup file's raw bytes, decompressing it when the path ends in `.zst`. */
export function readBackupBytes(filePath: string): Buffer
{
	const raw = fs.readFileSync(filePath);
	return filePath.endsWith(".zst") ? decompressBuffer(raw) : raw;
}

/** Read a backup file as text, transparently decompressing it when the path ends in `.zst`. */
export function readBackupFile(filePath: string): string
{
	return readBackupBytes(filePath).toString("utf8");
}

/** Build a solid `archive/<month>.tar.zst` from raw files located in `dir`. */
export function createMonthArchive(archivePath: string, dir: string, filenames: string[]): void
{
	fs.mkdirSync(
		path.dirname(archivePath),
		{
			recursive: true,
		},
	);
	execFileSync(
		"tar",
		["--use-compress-program", ZSTD_COMPRESS_PROGRAM, "-cf", archivePath, "-C", dir, ...filenames],
		{
			maxBuffer: EXEC_MAX_BUFFER,
		},
	);
}

/** Extract every member of a `.tar.zst` archive into `destDir`. */
export function extractArchive(archivePath: string, destDir: string): void
{
	fs.mkdirSync(
		destDir,
		{
			recursive: true,
		},
	);
	execFileSync(
		"tar",
		["--use-compress-program", ZSTD_DECOMPRESS_PROGRAM, "-xf", archivePath, "-C", destDir],
		{
			maxBuffer: EXEC_MAX_BUFFER,
		},
	);
}

/**
 * Build (or rebuild) a solid `<month>.tar.zst` archive containing the raw, uncompressed
 * contents of `looseFiles`. When the archive already exists its current members are
 * preserved and merged. `.zst` inputs are decompressed so the solid pass can dedupe.
 */
export function buildMonthArchive(archivePath: string, looseFiles: string[]): void
{
	const staging = fs.mkdtempSync(path.join(os.tmpdir(), "wf-month-"));
	try
	{
		if (fs.existsSync(archivePath))
		{
			extractArchive(archivePath, staging);
		}

		for (const looseFile of looseFiles)
		{
			const rawName = path.basename(looseFile).replace(/\.zst$/u, "");
			fs.writeFileSync(path.join(staging, rawName), readBackupBytes(looseFile));
		}

		const tempArchive = `${archivePath}.tmp`;
		createMonthArchive(tempArchive, staging, fs.readdirSync(staging));
		fs.renameSync(tempArchive, archivePath);
	}
	finally
	{
		fs.rmSync(
			staging,
			{
				recursive: true,
				force: true,
			},
		);
	}
}

/** List the member filenames inside a `.tar.zst` archive. */
export function listArchiveEntries(archivePath: string): string[]
{
	const output = execFileSync(
		"tar",
		["--use-compress-program", ZSTD_DECOMPRESS_PROGRAM, "-tf", archivePath],
		{
			encoding: "utf8",
			maxBuffer: EXEC_MAX_BUFFER,
		},
	);
	return output.split("\n").filter((line) => line.length > 0);
}

/** Extract a single member from a `.tar.zst` archive as a buffer. */
export function readArchiveEntry(archivePath: string, entryName: string): Buffer
{
	return execFileSync(
		"tar",
		["--use-compress-program", ZSTD_DECOMPRESS_PROGRAM, "-xOf", archivePath, entryName],
		{
			maxBuffer: EXEC_MAX_BUFFER,
		},
	);
}

/** Read the decoded text content of a backup, whether loose or archived. */
export function readBackupContent(location: BackupLocation): string
{
	if (location.kind === "loose")
	{
		return readBackupFile(location.filePath);
	}

	return readArchiveEntry(location.archivePath, location.entryName).toString("utf8");
}

export interface MaterializedBackup
{
	filePath: string;
	cleanup: () => void;
}

/**
 * Materialize a backup into a real file path so path-based importers can consume it.
 * Loose files are returned as-is. Archived entries are extracted into a temporary
 * `Data/` directory so {@link parseBackupFilename} still recognizes them; the caller
 * must invoke `cleanup()` when finished.
 */
export function materializeBackup(location: BackupLocation): MaterializedBackup
{
	if (location.kind === "loose")
	{
		return {
			filePath: location.filePath,
			cleanup: () =>
			{
			},
		};
	}

	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-backup-"));
	const dataDir = path.join(tempDir, "Data");
	fs.mkdirSync(
		dataDir,
		{
			recursive: true,
		},
	);
	const filePath = path.join(dataDir, location.entryName);
	fs.writeFileSync(filePath, readArchiveEntry(location.archivePath, location.entryName));
	return {
		filePath,
		cleanup: () =>
		{
			fs.rmSync(
				tempDir,
				{
					recursive: true,
					force: true,
				},
			);
		},
	};
}

/**
 * Where backups live. Defaults to `backups/` under the working directory, but
 * `OUTLINEDB_BACKUPS_DIR` overrides it so tests can point at a scratch directory
 * instead of decompressing the developer's real monthly archives.
 */
export function resolveBackupsDirectory(): string
{
	return nonEmpty(process.env.OUTLINEDB_BACKUPS_DIR) ?? path.join(process.cwd(), "backups");
}

/**
 * Enumerate every Data backup under `backupsDir`, including those folded into
 * monthly archives. History backups are storage-only and intentionally excluded.
 */
export function listBackups(backupsDir: string): BackupEntry[]
{
	const entries: BackupEntry[] = [];
	const dataDir = path.join(backupsDir, "Data");

	if (fs.existsSync(dataDir))
	{
		for (const file of fs.readdirSync(dataDir))
		{
			const filePath = path.join(dataDir, file);
			if (!fs.statSync(filePath).isFile())
			{
				continue;
			}

			const info = parseBackupFilename(filePath);
			if (info)
			{
				entries.push(
					{
						filename: info.filename,
						backupDate: info.backupDate,
						location:
						{
							kind: "loose",
							filePath,
						},
					},
				);
			}
		}
	}

	const archiveDir = path.join(dataDir, "archive");
	if (fs.existsSync(archiveDir))
	{
		for (const archive of fs.readdirSync(archiveDir))
		{
			if (!archive.endsWith(".tar.zst"))
			{
				continue;
			}

			const archivePath = path.join(archiveDir, archive);
			for (const entryName of listArchiveEntries(archivePath))
			{
				const info = parseBackupFilename(path.join("Data", entryName));
				if (info)
				{
					entries.push(
						{
							filename: info.filename,
							backupDate: info.backupDate,
							location:
							{
								kind: "archive",
								archivePath,
								entryName,
							},
						},
					);
				}
			}
		}
	}

	entries.sort((a, b) => a.backupDate.getTime() - b.backupDate.getTime());
	return entries;
}
