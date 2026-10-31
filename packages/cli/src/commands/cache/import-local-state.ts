import DatabaseConstructor from "better-sqlite3";
import {Command, Flags} from "@oclif/core";
import * as schema from "@workflowy/shared/db";
import {fileBlobs, localSettings} from "@workflowy/shared/db";
import {sql} from "drizzle-orm";
import {drizzle} from "drizzle-orm/better-sqlite3";
import fs from "node:fs";
import {createDatabase} from "../../db/index.js";

export interface ImportLocalStateResult {
	localSettings: number;
	fileBlobs: number;
}

export default class ImportLocalState extends Command {
	static override enableJsonFlag = true;

	static override description =
		"Copy the local-only state no Workflowy source can rebuild (local_settings, file_blobs) from an old cache database, opened read-only, into this one";

	static override examples = ["<%= config.bin %> cache:import-local-state --from workflowy.pre-rebuild.sqlite"];

	static override flags = {
		from: Flags.string({description: "Old cache database to copy from (opened read-only)", required: true}),
	};

	public async run(): Promise<ImportLocalStateResult> {
		const {flags} = await this.parse(ImportLocalState);
		if (!fs.existsSync(flags.from)) {
			this.error(`Old database not found: ${flags.from}`);
		}

		const sqlite = new DatabaseConstructor(flags.from, {readonly: true, fileMustExist: true});
		let settingsRows: (typeof localSettings.$inferSelect)[];
		let blobRows: (typeof fileBlobs.$inferSelect)[];
		try {
			const old = drizzle(sqlite, {schema});
			settingsRows = old.select().from(localSettings).all();
			blobRows = old.select().from(fileBlobs).all();
		} finally {
			sqlite.close();
		}

		const database = createDatabase();
		database.transaction((tx) => {
			for (const row of settingsRows) {
				tx.insert(localSettings)
					.values(row)
					.onConflictDoUpdate({
						target: localSettings.key,
						set: {json: sql`excluded.json`, updatedAt: sql`excluded.updated_at`},
					})
					.run();
			}
			for (const row of blobRows) {
				tx.insert(fileBlobs)
					.values(row)
					.onConflictDoUpdate({
						target: fileBlobs.nodeId,
						set: {
							status: sql`excluded.status`,
							sha256: sql`excluded.sha256`,
							size: sql`excluded.size`,
							contentType: sql`excluded.content_type`,
							localPath: sql`excluded.local_path`,
							error: sql`excluded.error`,
							fetchedAt: sql`excluded.fetched_at`,
						},
					})
					.run();
			}
		});

		const result = {localSettings: settingsRows.length, fileBlobs: blobRows.length};
		this.log(`Carried over ${result.localSettings} local_settings and ${result.fileBlobs} file_blobs rows`);
		return result;
	}
}
