import {Command} from "@oclif/core";
import {findInbox, PathBuilder} from "@outlinedb/shared/cache";
import {createDatabase} from "../../../db/index.js";

interface AccountInboxOutput {
	id: string;
	name: string;
	path: string;
	source: "inbox_id" | "name";
}

/** Print the account Inbox: the node root metadata `inbox_id` names, else the Home child named Inbox. */
export default class AccountInbox extends Command {
	static override description =
		"Print the account Inbox (the node root metadata inbox_id names, else the top-level node named Inbox)";

	static override examples = ["<%= config.bin %> <%= command.id %>"];

	public async run(): Promise<AccountInboxOutput> {
		await this.parse(AccountInbox);
		const database = createDatabase();
		const inbox = findInbox(database);
		if (!inbox) {
			this.error("No Inbox found: root metadata inbox_id is unset or deleted and Home has no node named Inbox");
		}
		const output = {
			id: inbox.id,
			name: inbox.name,
			path: new PathBuilder(database).buildFullPathsBatch([inbox.id]).get(inbox.id) ?? "",
			source: inbox.source,
		};
		this.log(JSON.stringify(output));
		return output;
	}
}
