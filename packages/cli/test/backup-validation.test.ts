import {describe, expect, it} from "vite-plus/test";
import {formatDate, getDateDifference, parseBackupFilename} from "../src/utils/backup-validation.js";

describe("Backup Validation", () =>
{
	describe("parseBackupFilename", () =>
	{
		it("parses legacy backup filename", () =>
		{
			const result = parseBackupFilename("/path/to/workflowy-backup-2025-11-18.json");
			expect(result).toStrictEqual(
				{
					filename: "workflowy-backup-2025-11-18.json",
					backupDate: new Date("2025-11-18"),
					source: "Data",
					compressed: false,
				},
			);
		});

		it("parses Data folder backup filename", () =>
		{
			const result = parseBackupFilename("/backups/Data/(alice@example.com).2025-11-18.workflowy.backup");
			expect(result).toStrictEqual(
				{
					filename: "(alice@example.com).2025-11-18.workflowy.backup",
					backupDate: new Date("2025-11-18"),
					source: "Data",
					compressed: false,
				},
			);
		});

		it("parses compressed Data folder backup filename", () =>
		{
			const result = parseBackupFilename("/backups/Data/(alice@example.com).2025-11-18.workflowy.backup.zst");
			expect(result).toStrictEqual(
				{
					filename: "(alice@example.com).2025-11-18.workflowy.backup.zst",
					backupDate: new Date("2025-11-18"),
					source: "Data",
					compressed: true,
				},
			);
		});

		it("parses compressed legacy backup filename", () =>
		{
			const result = parseBackupFilename("/path/to/workflowy-backup-2025-11-18.json.zst");
			expect(result).toStrictEqual(
				{
					filename: "workflowy-backup-2025-11-18.json.zst",
					backupDate: new Date("2025-11-18"),
					source: "Data",
					compressed: true,
				},
			);
		});

		it("returns null for Data pattern without Data directory", () =>
		{
			const result = parseBackupFilename("/backups/(alice@example.com).2025-11-18.workflowy.backup");
			expect(result).toBeNull();
		});

		it("returns null for invalid filename pattern", () =>
		{
			const result = parseBackupFilename("invalid-backup-2025-11-18.json");
			expect(result).toBeNull();
		});

		it("returns null for invalid date in filename", () =>
		{
			const result = parseBackupFilename("/backups/Data/(alice@example.com).2025-13-40.workflowy.backup");
			expect(result).toBeNull();
		});
	});

	describe("getDateDifference", () =>
	{
		it("returns 0 for same dates", () =>
		{
			const date = new Date("2025-11-18");
			expect(getDateDifference(date, date)).toBe(0);
		});

		it("returns 1 for consecutive dates", () =>
		{
			const date1 = new Date("2025-11-17");
			const date2 = new Date("2025-11-18");
			expect(getDateDifference(date1, date2)).toBe(1);
		});

		it("returns -1 for dates in reverse order", () =>
		{
			const date1 = new Date("2025-11-18");
			const date2 = new Date("2025-11-17");
			expect(getDateDifference(date1, date2)).toBe(-1);
		});

		it("returns correct difference for dates multiple days apart", () =>
		{
			const date1 = new Date("2025-11-10");
			const date2 = new Date("2025-11-15");
			expect(getDateDifference(date1, date2)).toBe(5);
		});

		it("handles month boundaries correctly", () =>
		{
			const date1 = new Date("2025-10-30");
			const date2 = new Date("2025-11-02");
			expect(getDateDifference(date1, date2)).toBe(3);
		});

		it("handles year boundaries correctly", () =>
		{
			const date1 = new Date("2024-12-30");
			const date2 = new Date("2025-01-02");
			expect(getDateDifference(date1, date2)).toBe(3);
		});
	});

	describe("formatDate", () =>
	{
		it("formats date in ISO format", () =>
		{
			const date = new Date("2025-11-18");
			expect(formatDate(date)).toBe("2025-11-18");
		});

		it("formats date with single-digit month", () =>
		{
			const date = new Date("2025-01-05");
			expect(formatDate(date)).toBe("2025-01-05");
		});

		it("formats date with single-digit day", () =>
		{
			const date = new Date("2025-11-05");
			expect(formatDate(date)).toBe("2025-11-05");
		});
	});
});
