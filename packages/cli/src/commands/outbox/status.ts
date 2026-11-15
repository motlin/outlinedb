import {Command} from "@oclif/core";
import {listPendingOutbox, outboxStatus} from "@outlinedb/shared/cache";
import type {OutboxStatus, PendingOutboxListing} from "@outlinedb/shared/cache";
import {stripHtmlTags} from "@outlinedb/shared/html";
import {createDatabase} from "../../db/index.js";

const SHORT_NAME_LENGTH = 40;

/** The outbox summary plus each pending node row, with the node's name shortened to plain text. */
export interface OutboxStatusReport extends OutboxStatus
{
	rows: PendingOutboxListing[];
}

function shortName(name: string | null): string | null
{
	if (name === null)
	{
		return null;
	}
	const plain = stripHtmlTags(name);
	return plain.length > SHORT_NAME_LENGTH ? `${plain.slice(0, SHORT_NAME_LENGTH - 3)}...` : plain;
}

export default class Status extends Command
{
	static override enableJsonFlag = true;

	static override description =
		"Show the mirror-mode outbox: writes saved locally that workflowy.com does not have yet";

	static override examples = ["<%= config.bin %> <%= command.id %>", "<%= config.bin %> <%= command.id %> --json"];

	public async run(): Promise<OutboxStatusReport>
	{
		await this.parse(Status);

		const database = createDatabase();
		const status = outboxStatus(database);
		const rows = listPendingOutbox(database).map((row) => (
		{
			...row,
			name: shortName(row.name),
		}));
		this.log(`Pending: ${status.pending}`);
		if (status.oldestEnqueuedAt !== null)
		{
			this.log(`Oldest: ${status.oldestEnqueuedAt}`);
		}
		if (status.lastError !== null)
		{
			this.log(`Last error: ${status.lastError}`);
		}
		for (const row of rows)
		{
			this.log(`${row.nodeId}  ${row.aspect}  ${row.enqueuedAt}  ${row.name ?? "(no current name)"}`);
			if (row.lastError !== null)
			{
				this.log(`  last error: ${row.lastError}`);
			}
		}
		return {
			...status,
			rows,
		};
	}
}
