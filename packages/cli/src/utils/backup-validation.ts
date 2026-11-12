import path from "node:path";

export interface BackupFileInfo
{
	filename: string;
	backupDate: Date;
	source: "Data";
	compressed: boolean;
}

export function parseBackupFilename(filePath: string): BackupFileInfo | null
{
	const filename = path.basename(filePath);
	const dirname = path.basename(path.dirname(filePath));
	const compressed = filename.endsWith(".zst");

	const dataPattern = /\(.*?\)\.(\d{4}-\d{2}-\d{2})\.workflowy\.backup(?:\.zst)?$/u;
	const legacyPattern = /^workflowy-backup-(\d{4}-\d{2}-\d{2})\.json(?:\.zst)?$/u;

	const dataDate = filename.match(dataPattern)?.[1];
	if (dataDate !== undefined && dirname === "Data")
	{
		const backupDate = new Date(dataDate);
		if (Number.isNaN(backupDate.getTime()))
		{
			return null;
		}
		return {
			filename,
			backupDate,
			source: "Data",
			compressed,
		};
	}

	const legacyDate = filename.match(legacyPattern)?.[1];
	if (legacyDate !== undefined)
	{
		const backupDate = new Date(legacyDate);
		if (Number.isNaN(backupDate.getTime()))
		{
			return null;
		}
		return {
			filename,
			backupDate,
			source: "Data",
			compressed,
		};
	}

	return null;
}

export function getDateDifference(date1: Date, date2: Date): number
{
	const msPerDay = 24 * 60 * 60 * 1000;
	const utc1 = Date.UTC(date1.getFullYear(), date1.getMonth(), date1.getDate());
	const utc2 = Date.UTC(date2.getFullYear(), date2.getMonth(), date2.getDate());
	return Math.floor((utc2 - utc1) / msPerDay);
}

export function formatDate(date: Date): string
{
	return date.toISOString().slice(0, "YYYY-MM-DD".length);
}
