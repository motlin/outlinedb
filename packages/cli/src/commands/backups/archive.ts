import {Command, Flags} from "@oclif/core";
import fs from "node:fs";
import path from "node:path";
import {buildMonthArchive, compressFileInPlace, resolveBackupsDirectory} from "../../utils/backup-archive.js";

const BACKUP_SOURCES = ["Data", "History"] as const;
type BackupSource = (typeof BACKUP_SOURCES)[number];

interface LooseBackup
{
	filename: string;
	filePath: string;
	backupDate: Date;
	month: string;
	compressed: boolean;
}

export default class BackupsArchive extends Command
{
	static override description =
		"Compress local backups: keep recent days as per-file .zst, fold older days into solid monthly archives";

	static override examples = [
		"<%= config.bin %> backups:archive",
		"<%= config.bin %> backups:archive --keep-days 60",
		"<%= config.bin %> backups:archive --source Data",
	];

	static override flags =
	{
		"keep-days": Flags.integer(
			{
				description:
					"Days of backups to keep as individually compressed files before folding into monthly archives",
				default: 30,
			},
		),
		source: Flags.option(
			{
				description: "Limit to a single backup source",
				options: BACKUP_SOURCES,
			},
		)(),
	};

	public async run(): Promise<void>
	{
		const {flags} = await this.parse(BackupsArchive);

		const backupsDirectory = resolveBackupsDirectory();
		if (!fs.existsSync(backupsDirectory))
		{
			this.error(`No backups directory found at ${backupsDirectory}`);
		}

		const cutoff = new Date();
		cutoff.setDate(cutoff.getDate() - flags["keep-days"]);

		const sources = flags.source ? [flags.source] : [...BACKUP_SOURCES];
		const sizeBefore = directorySize(backupsDirectory);

		for (const source of sources)
		{
			this.archiveSource(backupsDirectory, source, cutoff);
		}

		const sizeAfter = directorySize(backupsDirectory);
		this.log(`\n📦 backups/: ${formatBytes(sizeBefore)} → ${formatBytes(sizeAfter)}`);
	}

	private archiveSource(backupsDirectory: string, source: BackupSource, cutoff: Date): void
	{
		const sourceDir = path.join(backupsDirectory, source);
		if (!fs.existsSync(sourceDir))
		{
			return;
		}

		const looseBackups = scanLooseBackups(sourceDir);
		if (looseBackups.length === 0)
		{
			this.log(`${source}: nothing to do`);
			return;
		}

		const recent = looseBackups.filter((backup) => backup.backupDate >= cutoff);
		const old = looseBackups.filter((backup) => backup.backupDate < cutoff);

		let compressedCount = 0;
		for (const backup of recent)
		{
			if (!backup.compressed)
			{
				compressFileInPlace(backup.filePath);
				compressedCount++;
			}
		}

		const byMonth = new Map<string, LooseBackup[]>();
		for (const backup of old)
		{
			const monthBackups = byMonth.get(backup.month) ?? [];
			monthBackups.push(backup);
			byMonth.set(backup.month, monthBackups);
		}

		const archiveDir = path.join(sourceDir, "archive");
		const monthsAscending = [...byMonth.entries()].toSorted(([a], [b]) => a.localeCompare(b));
		for (const [month, monthBackups] of monthsAscending)
		{
			const archivePath = path.join(archiveDir, `${month}.tar.zst`);
			buildMonthArchive(
				archivePath,
				monthBackups.map((backup) => backup.filePath),
			);
			for (const backup of monthBackups)
			{
				fs.rmSync(backup.filePath);
			}
			this.log(`${source}: archived ${monthBackups.length} file(s) → archive/${month}.tar.zst`);
		}

		this.log(`${source}: compressed ${compressedCount} recent file(s), ${recent.length} kept loose`);
	}
}

/** Extract the backup date from a Data, History, or legacy filename (ignoring a `.zst` suffix). */
function parseDate(filename: string): Date | null
{
	const base = filename.replace(/\.zst$/u, "");
	const match = base.match(/(\d{4}-\d{2}-\d{2})\.(?:workflowy\.backup|txt|json)$/u);
	const dateText = match?.[1];
	if (dateText === undefined)
	{
		return null;
	}

	const date = new Date(dateText);
	return Number.isNaN(date.getTime()) ? null : date;
}

function scanLooseBackups(sourceDir: string): LooseBackup[]
{
	const backups: LooseBackup[] = [];

	for (const filename of fs.readdirSync(sourceDir))
	{
		const filePath = path.join(sourceDir, filename);
		if (!fs.statSync(filePath).isFile())
		{
			continue;
		}

		const backupDate = parseDate(filename);
		if (!backupDate)
		{
			continue;
		}

		backups.push(
			{
				filename,
				filePath,
				backupDate,
				month: backupDate.toISOString().slice(0, 7),
				compressed: filename.endsWith(".zst"),
			},
		);
	}

	return backups;
}

function directorySize(directory: string): number
{
	let total = 0;
	for (const entry of fs.readdirSync(
		directory,
		{
			withFileTypes: true,
		},
	))
	{
		const entryPath = path.join(directory, entry.name);
		if (entry.isDirectory())
		{
			total += directorySize(entryPath);
		}
		else if (entry.isFile())
		{
			total += fs.statSync(entryPath).size;
		}
	}

	return total;
}

function formatBytes(bytes: number): string
{
	const units = ["B", "KB", "MB", "GB"];
	let value = bytes;
	let unitIndex = 0;
	while (value >= 1024 && unitIndex < units.length - 1)
	{
		value /= 1024;
		unitIndex++;
	}

	return `${value.toFixed(1)} ${units[unitIndex]}`;
}
