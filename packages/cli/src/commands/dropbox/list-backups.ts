import {Command, Flags} from "@oclif/core";
import {Dropbox} from "dropbox";
import type {files} from "dropbox";
import {nonEmpty} from "../../utils/non-empty.js";

export default class ListBackups extends Command {
	static override description =
		"List all available Workflowy backup files in Dropbox from both Data and History folders";

	static override examples = ["<%= config.bin %> <%= command.id %>"];

	static override flags = {
		all: Flags.boolean({
			char: "a",
			description: "List backups from all folders (Data and History)",
			default: true,
		}),
	};

	public async run(): Promise<void> {
		await this.parse(ListBackups);

		const dropbox = this.initializeDropbox();

		const allBackups: {date: string; filename: string; sizeMB: string; source: string}[] = [];

		for (const folder of ["Data", "History"]) {
			const dropboxPath = `/Apps/WorkFlowy/${folder}`;

			try {
				const response = await dropbox.filesListFolder({path: dropboxPath});

				const fileExtension = folder === "Data" ? ".workflowy.backup" : ".txt";
				const backupFiles = response.result.entries
					.filter(
						(entry): entry is files.FileMetadataReference =>
							entry[".tag"] === "file" && entry.name.endsWith(fileExtension),
					)
					.toSorted((a, b) => {
						const dateA = new Date(a.client_modified).getTime();
						const dateB = new Date(b.client_modified).getTime();
						return dateB - dateA;
					});

				for (const file of backupFiles) {
					const dateMatch = file.name.match(/\.(\d{4}-\d{2}-\d{2})\.(workflowy\.backup|txt)$/u);
					const date = dateMatch?.[1] ?? "unknown";
					const sizeMB = (file.size / (1024 * 1024)).toFixed(2);

					allBackups.push({date, filename: file.name, sizeMB, source: folder});
				}
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

					this.warn(`Failed to list backups from ${folder}: ${error.message}`);
				}
			}
		}

		if (allBackups.length === 0) {
			this.error("No backup files found in any folder");
		}

		allBackups.sort((a, b) => b.date.localeCompare(a.date));

		this.log("\nAvailable backups:\n");

		for (const backup of allBackups) {
			this.log(`${backup.date}  ${backup.source.padEnd(7)}  ${backup.sizeMB.padStart(6)} MB  ${backup.filename}`);
		}
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
}
