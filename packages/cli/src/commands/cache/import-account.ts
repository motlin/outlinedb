import {WorkflowyInternalClient} from "@workflowy/shared/api";
import {WorkflowyInternalAdapter} from "@workflowy/shared/internal";
import {readInternalAuth} from "@workflowy/shared/node";
import {Command} from "@oclif/core";
import {createDatabase} from "../../db/index.js";

export interface ImportAccountResult {
	keys: string[];
}

export default class ImportAccount extends Command {
	static override enableJsonFlag = true;

	static override description =
		"Fetch the account state (account, root metadata incl. tag colors, settings, visible features, entropy key) from the internal API into account_state";

	static override examples = ["<%= config.bin %> cache:import-account"];

	public async run(): Promise<ImportAccountResult> {
		await this.parse(ImportAccount);
		const auth = readInternalAuth();
		if (!auth) {
			this.error(
				"Importing account state needs the internal API: set WORKFLOWY_USERNAME and WORKFLOWY_PASSWORD (e.g. via op run)",
			);
		}
		const adapter = new WorkflowyInternalAdapter({client: new WorkflowyInternalClient(auth), db: createDatabase()});
		const keys = await adapter.refreshAccountState();
		this.log(`Account state: ${keys.join(", ")}`);
		return {keys};
	}
}
