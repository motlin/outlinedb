import {Command} from "@oclif/core";
import {readWorkflowyCredentials, WorkflowyInternalClient} from "@outlinedb/shared/api";
import {fileSessionStore, sessionFilePath} from "@outlinedb/shared/node";

export default class Login extends Command
{
	static override description =
		"Log in to Workflowy's internal API once and save the session cookie (mode 0600) so later live work needs no password";

	static override examples = ["<%= config.bin %> internal login"];

	public async run(): Promise<void>
	{
		await this.parse(Login);
		const credentials = readWorkflowyCredentials();
		if (!credentials)
		{
			this.error("WORKFLOWY_USERNAME and WORKFLOWY_PASSWORD must be set in the environment (e.g. from .envrc)");
		}
		const file = sessionFilePath();
		await new WorkflowyInternalClient(
			{
				credentials,
				sessionStore: fileSessionStore(file),
			},
		).login();
		this.log(`Saved Workflowy session cookie to ${file}`);
	}
}
