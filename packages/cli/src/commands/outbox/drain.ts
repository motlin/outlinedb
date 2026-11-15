import {Command} from "@oclif/core";
import {WorkflowyApiClient} from "@outlinedb/shared/api";
import {WorkflowyWriteThroughClient} from "@outlinedb/shared/cache";
import {createDatabase} from "../../db/index.js";
import {CacheService} from "../../services/cache.js";
import {drainAfterWrite, openLocalWrites} from "../../services/local-writes.js";
import {logger} from "../../services/logger.js";

export default class Drain extends Command
{
	static override description =
		"Deliver the pending mirror-mode outbox to workflowy.com; a failure keeps the rows pending and exits non-zero";

	static override examples = ["<%= config.bin %> <%= command.id %>"];

	public async run(): Promise<void>
	{
		await this.parse(Drain);

		const apiKey = process.env.WORKFLOWY_API_KEY;
		if (!apiKey)
		{
			this.error("WORKFLOWY_API_KEY environment variable is required");
		}

		const database = createDatabase();
		const client = new WorkflowyWriteThroughClient(
			new WorkflowyApiClient(apiKey, logger, process.env.WORKFLOWY_API_URL),
			new CacheService(database),
		);
		await drainAfterWrite(this, openLocalWrites(database, client));
		this.log("Outbox drained: nothing pending");
	}
}
