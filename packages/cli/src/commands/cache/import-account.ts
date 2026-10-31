import {WorkflowyInternalClient} from "@workflowy/shared/api";
import {WorkflowyInternalAdapter} from "@workflowy/shared/internal";
import {readInternalAuth} from "@workflowy/shared/node";
import {Command} from "@oclif/core";
import {createDatabase} from "../../db/index.js";

export interface ImportAccountResult {
	/** Each account table's live row count after the refresh. */
	tables: Record<string, number>;
}

export default class ImportAccount extends Command {
	static override enableJsonFlag = true;

	static override description =
		"Fetch the account state (account incl. entropy key, root metadata incl. tag colors and stars, settings, visible features) from the internal API into the typed temporal account tables";

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
		const tables = await adapter.refreshAccountState();
		this.log(
			`Account state: ${Object.entries(tables)
				.map(([table, rows]) => `${table} ${rows}`)
				.join(", ")}`,
		);
		return {tables};
	}
}
