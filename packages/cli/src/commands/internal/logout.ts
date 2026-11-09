import {Command} from "@oclif/core";
import {fileSessionStore, sessionFilePath} from "@outlinedb/shared/node";

export default class Logout extends Command {
	static override description = "Delete the saved Workflowy internal-API session cookie";

	static override examples = ["<%= config.bin %> internal logout"];

	public async run(): Promise<void> {
		await this.parse(Logout);
		const file = sessionFilePath();
		const store = fileSessionStore(file);
		if (store.read() === undefined) {
			this.log(`No Workflowy session cookie at ${file}`);
			return;
		}
		store.clear();
		this.log(`Removed Workflowy session cookie ${file}`);
	}
}
