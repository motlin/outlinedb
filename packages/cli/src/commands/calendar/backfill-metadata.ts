import {WorkflowyApiClient} from "@outlinedb/shared/api";
import {backfillCalendarMetadata, WorkflowyWriteThroughClient} from "@outlinedb/shared/cache";
import type {CalendarBackfillResult} from "@outlinedb/shared/cache";
import {Command, Flags} from "@oclif/core";
import {createDatabase} from "../../db/index.js";
import {CacheService} from "../../services/cache.js";
import {drainAfterWrite, localAccount, openLocalWrites} from "../../services/local-writes.js";
import {logger} from "../../services/logger.js";

function nodes(count: number): string
{
	return `${count} ${count === 1 ? "node" : "nodes"}`;
}

export default class CalendarBackfillMetadata extends Command
{
	static override description =
		"Run workflowy.com's one-time calendar migrations locally, then deliver them: add calendar.timestamp, then calendar.dateId, to 📆 Calendar level nodes missing them, each only while root metadata lacks its calendar.ts_added_v2 / calendar.dateId_added_v1 flag, which is set after";

	static override examples = [
		"<%= config.bin %> <%= command.id %>",
		"<%= config.bin %> <%= command.id %> --force --json",
	];

	static override flags =
	{
		force: Flags.boolean(
			{
				description: "Run both backfills even when their flags are already set",
				default: false,
			},
		),
		json: Flags.boolean(
			{
				char: "j",
				description: "Output {timestamps, dateIds} (the ids changed) as JSON",
				default: false,
			},
		),
	};

	public async run(): Promise<CalendarBackfillResult>
	{
		const {flags} = await this.parse(CalendarBackfillMetadata);
		const apiKey = process.env.WORKFLOWY_API_KEY;
		if (!apiKey)
		{
			this.error("WORKFLOWY_API_KEY environment variable is required");
		}
		const database = createDatabase();
		const writes = openLocalWrites(
			database,
			new WorkflowyWriteThroughClient(
				new WorkflowyApiClient(apiKey, logger, process.env.WORKFLOWY_API_URL),
				new CacheService(database),
			),
		);
		const result = await backfillCalendarMetadata(
			{
				db: database,
				writer: writes.local,
				account: await localAccount(writes),
				force: flags.force,
			},
		);
		if (flags.json)
		{
			this.log(JSON.stringify(result));
		}
		else
		{
			this.log(
				`Added calendar.timestamp to ${nodes(result.timestamps.length)} and calendar.dateId to ${nodes(result.dateIds.length)}`,
			);
		}
		await drainAfterWrite(this, writes);
		return result;
	}
}
