import {Command, Flags} from "@oclif/core";
import {Dropbox} from "dropbox";
import type {files} from "dropbox";
import fs from "node:fs";
import path from "node:path";
import {compressBuffer, resolveBackupsDirectory} from "../../utils/backup-archive.js";
import {nonEmpty} from "../../utils/non-empty.js";

function formatTimestamp(): string {
	return new Date().toISOString();
}

type DropboxFolder = "Data" | "History";

const MAX_REMOTE_BACKUPS = 3;

interface DownloadResult {
	path: string;
	filename: string;
	size: number;
	modified: string;
	success: boolean;
}

interface DeletedBackup {
	filename: string;
	path: string;
}

interface DownloadAllResult {
	downloaded: DownloadResult[];
	skipped: string[];
	deleted: DeletedBackup[];
	total: number;
}

export default class DownloadBackup extends Command {
	static override enableJsonFlag = true;

	static override examples = [
		"<%= config.bin %> <%= command.id %>",
		"<%= config.bin %> <%= command.id %> --folder History",
		"<%= config.bin %> <%= command.id %> --date 2025-11-06",
		'<%= config.bin %> <%= command.id %> --json | jq -r ".downloaded[].path"',
	];

	static override description = "Download all Workflowy backups from Dropbox that are not already downloaded locally";

	static override flags = {
		folder: Flags.option({
			char: "f",
			description: "Which Dropbox folder to download from (default: downloads from both Data and History)",
			options: ["Data", "History"] as const,
		})(),
		date: Flags.string({
			char: "d",
			description: "Download backup from specific date only (YYYY-MM-DD format)",
		}),
		quiet: Flags.boolean({
			char: "q",
			description: "Suppress all output except the downloaded filenames (for scripting)",
			default: false,
		}),
	};

	public async run(): Promise<DownloadAllResult> {
		const {flags} = await this.parse(DownloadBackup);

		const dropbox = this.initializeDropbox();

		const folders: DropboxFolder[] = flags.folder ? [flags.folder] : ["Data", "History"];

		const allResults: DownloadAllResult = {
			downloaded: [],
			skipped: [],
			deleted: [],
			total: 0,
		};

		for (const folder of folders) {
			const result = await this.downloadAllFromFolder(dropbox, folder, flags.date, flags.quiet);
			allResults.downloaded.push(...result.downloaded);
			allResults.skipped.push(...result.skipped);
			allResults.deleted.push(...result.deleted);
			allResults.total += result.total;
		}

		if (!flags.quiet) {
			this.log("");
			this.log(`📊 Dropbox has ${allResults.total} backup(s) (max ${MAX_REMOTE_BACKUPS} per folder)`);
			if (allResults.downloaded.length > 0) {
				this.log(`   Downloaded:    ${allResults.downloaded.length}`);
			}
			if (allResults.skipped.length > 0) {
				this.log(`   Already local: ${allResults.skipped.length}`);
			}
			if (allResults.deleted.length > 0) {
				this.log(`   Cleaned up:    ${allResults.deleted.length} old backup(s) removed from Dropbox`);
			}
		}

		return allResults;
	}

	private initializeDropbox(): Dropbox {
		const accessToken = process.env.DROPBOX_ACCESS_TOKEN;
		const refreshToken = process.env.DROPBOX_REFRESH_TOKEN;
		const clientId = nonEmpty(process.env.DROPBOX_ACCESS_KEY) ?? process.env.DROPBOX_APP_KEY;
		const clientSecret = nonEmpty(process.env.DROPBOX_ACCESS_SECRET) ?? process.env.DROPBOX_APP_SECRET;

		if (refreshToken && clientId && clientSecret) {
			return new Dropbox({refreshToken, clientId, clientSecret});
		}

		if (accessToken) {
			return new Dropbox({accessToken});
		}

		return this.error(
			"Dropbox credentials not set. Please set either:\n" +
				"  1. DROPBOX_REFRESH_TOKEN, DROPBOX_APP_KEY, and DROPBOX_APP_SECRET, or\n" +
				"  2. DROPBOX_ACCESS_TOKEN\n\n" +
				"To generate a refresh token, visit:\n" +
				"  https://www.dropbox.com/developers/apps",
		);
	}

	private async downloadAllFromFolder(
		dropbox: Dropbox,
		folder: DropboxFolder,
		dateFilter?: string,
		quiet = false,
	): Promise<DownloadAllResult> {
		const conditionalLog = (message: string): void => {
			if (!quiet) {
				this.log(`[${formatTimestamp()}] ${message}`);
			}
		};

		const dropboxPath = `/Apps/WorkFlowy/${folder}`;
		const result: DownloadAllResult = {
			downloaded: [],
			skipped: [],
			deleted: [],
			total: 0,
		};

		try {
			conditionalLog(`Searching:   ${dropboxPath}`);

			const response = await dropbox.filesListFolder({path: dropboxPath});

			const fileExtension = folder === "Data" ? ".workflowy.backup" : ".txt";
			let backupFiles = response.result.entries
				.filter(
					(entry): entry is files.FileMetadataReference =>
						entry[".tag"] === "file" && entry.name.endsWith(fileExtension),
				)
				.toSorted((a, b) => {
					const dateA = new Date(a.client_modified).getTime();
					const dateB = new Date(b.client_modified).getTime();
					return dateA - dateB;
				});

			if (dateFilter) {
				backupFiles = backupFiles.filter((entry) => {
					const dateMatch = entry.name.match(/\.(\d{4}-\d{2}-\d{2})\.(workflowy\.backup|txt)$/u);
					return dateMatch?.[1] === dateFilter;
				});
			}

			if (backupFiles.length === 0) {
				conditionalLog(`No backup files found in ${dropboxPath}`);
				return result;
			}

			result.total = backupFiles.length;
			conditionalLog(`Found ${backupFiles.length} backup(s) in ${folder}`);

			const localDirectory = path.join(resolveBackupsDirectory(), folder);
			if (!fs.existsSync(localDirectory)) {
				fs.mkdirSync(localDirectory, {recursive: true});
			}

			for (const backupFile of backupFiles) {
				const rawPath = path.join(localDirectory, backupFile.name);
				// Backups are stored compressed; a pre-existing raw file still counts as downloaded.
				const outputPath = `${rawPath}.zst`;

				if (fs.existsSync(outputPath) || fs.existsSync(rawPath)) {
					conditionalLog(`✓ Already have: ${backupFile.name}`);
					result.skipped.push(backupFile.name);
					continue;
				}

				const sizeMB = (backupFile.size / (1024 * 1024)).toFixed(2);
				conditionalLog(`Downloading: ${backupFile.name} (${sizeMB} MB)`);

				const downloadResponse = await dropbox.filesDownload({path: backupFile.path_lower ?? ""});
				const {fileBinary} = downloadResponse.result;

				if (fileBinary === undefined) {
					this.warn(`Failed to download: ${backupFile.name}`);
					continue;
				}

				const fileContent = Buffer.from(fileBinary);
				fs.writeFileSync(outputPath, compressBuffer(fileContent));

				const fileStats = fs.statSync(outputPath);
				const downloadResult: DownloadResult = {
					path: outputPath,
					filename: `${backupFile.name}.zst`,
					size: fileStats.size,
					modified: downloadResponse.result.server_modified,
					success: true,
				};

				result.downloaded.push(downloadResult);

				if (quiet && !this.jsonEnabled()) {
					this.log(outputPath);
				} else {
					conditionalLog(`✓ Downloaded: ${backupFile.name}`);
				}
			}

			// Clean up old backups to keep only the most recent ones
			const deleted = await this.cleanupOldBackups(dropbox, dropboxPath, backupFiles, conditionalLog);
			result.deleted.push(...deleted);

			return result;
		} catch (error) {
			if (error instanceof Error) {
				if (
					error.message.includes("400") ||
					error.message.includes("unauthorized") ||
					error.message.includes("invalid_access_token")
				) {
					this.error(
						"Dropbox authentication failed. Your credentials may be missing or invalid.\n\n" +
							"To authenticate with Dropbox, run:\n" +
							"  outlinedb dropbox:auth\n\n" +
							"Alternatively, set environment variables:\n" +
							"  DROPBOX_REFRESH_TOKEN, DROPBOX_APP_KEY, and DROPBOX_APP_SECRET\n" +
							"  or DROPBOX_ACCESS_TOKEN",
					);
				}

				this.error(`Failed to download backup: ${error.message}`);
			}

			return this.error(`Failed to download backup: ${String(error)}`);
		}
	}

	private async cleanupOldBackups(
		dropbox: Dropbox,
		dropboxPath: string,
		backupFiles: files.FileMetadataReference[],
		conditionalLog: (message: string) => void,
	): Promise<DeletedBackup[]> {
		const deleted: DeletedBackup[] = [];

		if (backupFiles.length <= MAX_REMOTE_BACKUPS) {
			return deleted;
		}

		// backupFiles are sorted oldest first (ascending by client_modified)
		// Delete all but the most recent MAX_REMOTE_BACKUPS
		const filesToDelete = backupFiles.slice(0, backupFiles.length - MAX_REMOTE_BACKUPS);

		conditionalLog(`Cleaning up: removing ${filesToDelete.length} old backup(s) from Dropbox`);

		for (const file of filesToDelete) {
			const filePath = `${dropboxPath}/${file.name}`;
			conditionalLog(`Deleting:    ${file.name}`);

			await dropbox.filesDeleteV2({path: filePath});

			deleted.push({
				filename: file.name,
				path: filePath,
			});
		}

		return deleted;
	}
}
