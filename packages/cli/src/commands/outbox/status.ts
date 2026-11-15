import {Command} from "@oclif/core";
import {outboxStatus} from "@outlinedb/shared/cache";
import type {OutboxStatus} from "@outlinedb/shared/cache";
import {createDatabase} from "../../db/index.js";

export default class Status extends Command
{
	static override enableJsonFlag = true;

	static override description =
		"Show the mirror-mode outbox: writes saved locally that workflowy.com does not have yet";

	static override examples = ["<%= config.bin %> <%= command.id %>", "<%= config.bin %> <%= command.id %> --json"];

	public async run(): Promise<OutboxStatus>
	{
		await this.parse(Status);

		const status = outboxStatus(createDatabase());
		this.log(`Pending: ${status.pending}`);
		if (status.oldestEnqueuedAt !== null)
		{
			this.log(`Oldest: ${status.oldestEnqueuedAt}`);
		}
		if (status.lastError !== null)
		{
			this.log(`Last error: ${status.lastError}`);
		}
		return status;
	}
}
