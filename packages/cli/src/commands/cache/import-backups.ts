import {backupImports} from "@outlinedb/shared/db";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import {Command, Flags} from "@oclif/core";
import {desc, eq} from "drizzle-orm";
import {createDatabase} from "../../db/index.js";
import {logger} from "../../services/logger.js";
import {listBackups, materializeBackup, resolveBackupsDirectory} from "../../utils/backup-archive.js";
import type {BackupEntry} from "../../utils/backup-archive.js";
import {formatDate, getDateDifference} from "../../utils/backup-validation.js";

export default class ImportBackups extends Command {
	static override description = "Import all missing backups from Dropbox into cache";

	static override examples = [
		"<%= config.bin %> cache:import-backups",
		"<%= config.bin %> cache:import-backups --no-embeddings",
		"<%= config.bin %> cache:import-backups --batch-size 50",
		"<%= config.bin %> cache:import-backups --no-download --no-archive --backup-system-time",
		"<%= config.bin %> cache:import-backups --backup-system-time --force",
	];

	static override flags = {
		embeddings: Flags.boolean({
			description: "Generate embeddings after import",
			default: true,
			allowNo: true,
		}),
		"batch-size": Flags.integer({
			char: "b",
			description: "Number of nodes to process in each embedding batch",
			default: 20,
		}),
		download: Flags.boolean({
			description: "Download missing backups from Dropbox first",
			default: true,
			allowNo: true,
		}),
		archive: Flags.boolean({
			description: "Compress and archive local backups before importing",
			default: true,
			allowNo: true,
		}),
		"backup-system-time": Flags.boolean({
			description: "Stamp each import with a system time taken from its backup (see cache:import-backup)",
			default: false,
		}),
		force: Flags.boolean({
			description:
				"Take each snapshot verbatim: do not protect cached nodes newer than it, tombstoning anything it omits (see cache:import-backup)",
			default: false,
		}),
	};

	public async run(): Promise<void> {
		const {flags} = await this.parse(ImportBackups);

		const db = createDatabase();
		const backupsDirectory = resolveBackupsDirectory();

		const mostRecentImport = db
			.select()
			.from(backupImports)
			.where(eq(backupImports.systemTo, FAR_FUTURE_DATE))
			.orderBy(desc(backupImports.backupDate))
			.limit(1)
			.get();
		logger.logSqlResult("import-backups.mostRecentImport", mostRecentImport);

		if (flags.download) {
			this.log("📥 Downloading any missing backups from Dropbox...");
			await this.runCommand(import("../dropbox/download-backup.js"), []);
		}

		if (flags.archive) {
			this.log("🗜️  Compressing and archiving local backups...");
			await this.runCommand(import("../backups/archive.js"), []);
		}

		const localBackups = listBackups(backupsDirectory);

		if (localBackups.length === 0) {
			this.log("❌ No backup files found");
			return;
		}

		const lastImportDate = mostRecentImport ? new Date(mostRecentImport.backupDate) : null;
		if (lastImportDate) {
			this.log(`📅 Last import: ${formatDate(lastImportDate)}`);
		}

		const unimportedBackups = lastImportDate
			? localBackups.filter((backup) => backup.backupDate > lastImportDate)
			: localBackups;

		if (unimportedBackups.length === 0) {
			this.log("✅ Already up to date!");
			if (flags.embeddings) {
				this.log("\n🤖 Generating embeddings for any nodes without them...");
				await this.runCommand(import("../ai/embed.js"), ["--batch-size", flags["batch-size"].toString()]);
			}
			return;
		}

		const [firstUnimported] = unimportedBackups;
		if (lastImportDate && firstUnimported) {
			const daysDiff = getDateDifference(lastImportDate, firstUnimported.backupDate);
			if (daysDiff > 1) {
				this.log(
					`⚠️  Gap: ${daysDiff - 1} day(s) between last import (${formatDate(lastImportDate)}) and first unimported backup (${formatDate(firstUnimported.backupDate)})`,
				);
			}
		}

		this.log(`\n📦 Importing ${unimportedBackups.length} backup(s)...\n`);

		for (const backup of unimportedBackups) {
			this.log(`📦 Importing: ${formatDate(backup.backupDate)}`);
			await this.importBackup(backup, flags);
		}

		this.log("\n✅ Import complete!");
	}

	private async importBackup(
		backup: BackupEntry,
		flags: {embeddings: boolean; "batch-size": number; "backup-system-time": boolean; force: boolean},
	): Promise<void> {
		// Archived backups live inside a solid `.tar.zst`; materializeBackup extracts
		// them to a temp file so the path-based cache:import-backup command can run.
		const {filePath, cleanup} = materializeBackup(backup.location);

		try {
			const importArgs = ["--file", filePath, "--yes", "--batch-size", flags["batch-size"].toString()];
			if (!flags.embeddings) {
				importArgs.push("--no-embeddings");
			}
			if (flags["backup-system-time"]) {
				importArgs.push("--backup-system-time");
			}
			if (flags.force) {
				importArgs.push("--force");
			}
			await this.runCommand(import("./import-backup.js"), importArgs);
		} finally {
			cleanup();
		}
	}

	private async runCommand(module: Promise<{default: Command.Class}>, args: string[]): Promise<void> {
		const {default: SubCommand} = await module;
		await SubCommand.run(args);
	}
}
