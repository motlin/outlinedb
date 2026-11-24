import {Command} from "@oclif/core";
import {continueWorkflowyLogin, startWorkflowyLogin} from "@outlinedb/shared/api";
import type {LoginStepOutcome} from "@outlinedb/shared/api";
import {fileSessionStore, sessionFilePath} from "@outlinedb/shared/node";
import {ask} from "../../services/prompt.js";

export default class Login extends Command
{
	static override description =
		"Log in to workflowy.com through its login form, answering each step it asks for (password, then an authenticator code), and save the session cookie (mode 0600); the email comes from WORKFLOWY_USERNAME";

	static override examples = ["<%= config.bin %> internal login"];

	public async run(): Promise<void>
	{
		await this.parse(Login);
		const email = process.env.WORKFLOWY_USERNAME;
		if (!email)
		{
			this.error("WORKFLOWY_USERNAME must be set to the account's email (e.g. from .envrc)");
		}
		const file = sessionFilePath();
		// The answers live only in this process, for the next step to resend a field the form echoes back.
		const answers: Record<string, string> = {};
		let step: LoginStepOutcome = await startWorkflowyLogin(email);
		while (step.kind === "fields")
		{
			for (const error of step.errors)
			{
				this.log(`workflowy.com: ${error}`);
			}
			for (const field of step.fields)
			{
				answers[field.name] = await ask(`${field.label}: `, field.type === "password");
			}
			step = await continueWorkflowyLogin(email, step.state, answers);
		}
		if (step.kind === "captcha")
		{
			this.error(
				"workflowy.com asked for a captcha, which this login cannot answer; log in at https://workflowy.com in a browser, then try again later",
			);
		}
		if (step.kind === "refused")
		{
			this.error(`${step.message} (${step.detail})`);
		}
		if (step.kind === "unverified")
		{
			this.error(
				`Login failed: workflowy.com accepted the form, but the session it set does not read /get_initialization_data (${step.detail})`,
			);
		}
		fileSessionStore(file).write(step.cookie);
		this.log(`Saved Workflowy session cookie to ${file}`);
	}
}
