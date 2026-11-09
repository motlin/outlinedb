import {WorkflowyApiClient} from "@outlinedb/shared/api";
import {WorkflowyWriteThroughClient} from "@outlinedb/shared/cache";
import {internalAdapter} from "@outlinedb/shared/node";
import {Command, Flags} from "@oclif/core";
import {createDatabase} from "../../db/index.js";
import {CacheService} from "../../services/cache.js";
import {logger} from "../../services/logger.js";

export interface CalendarBackfillResult {
	timestamps: string[];
	dateIds: string[];
}

function nodes(count: number): string {
	return `${count} ${count === 1 ? "node" : "nodes"}`;
}

export default class CalendarBackfillMetadata extends Command {
	static override description =
		"Run workflowy.com's one-time calendar migrations: add calendar.timestamp, then calendar.dateId, to 📆 Calendar level nodes missing them, each only while root metadata lacks its calendar.ts_added_v2 / calendar.dateId_added_v1 flag, which is set after";

	static override examples = [
		"<%= config.bin %> <%= command.id %>",
		"<%= config.bin %> <%= command.id %> --force --json",
	];

	static override flags = {
		force: Flags.boolean({description: "Run both backfills even when their flags are already set", default: false}),
		json: Flags.boolean({
			char: "j",
			description: "Output {timestamps, dateIds} (the ids changed) as JSON",
			default: false,
		}),
	};

	public async run(): Promise<CalendarBackfillResult> {
		const {flags} = await this.parse(CalendarBackfillMetadata);
		const apiKey = process.env.WORKFLOWY_API_KEY;
		if (!apiKey) {
			this.error("WORKFLOWY_API_KEY environment variable is required");
		}
		const database = createDatabase();
		const writeThrough = new WorkflowyWriteThroughClient(
			new WorkflowyApiClient(apiKey, logger, process.env.WORKFLOWY_API_URL),
			new CacheService(database),
		);
		const adapter = internalAdapter(database, writeThrough);
		if (adapter === undefined) {
			this.error(
				"calendar backfill-metadata needs the internal API: set WORKFLOWY_USERNAME and WORKFLOWY_PASSWORD in the environment (e.g. from .envrc)",
			);
		}
		const result = await adapter.backfillCalendarMetadata({force: flags.force});
		if (flags.json) {
			this.log(JSON.stringify(result));
		} else {
			this.log(
				`Added calendar.timestamp to ${nodes(result.timestamps.length)} and calendar.dateId to ${nodes(result.dateIds.length)}`,
			);
		}
		return result;
	}
}
