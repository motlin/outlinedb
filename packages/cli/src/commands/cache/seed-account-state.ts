import {Command, Flags} from "@oclif/core";
import {accountRowTotal, readAccountState} from "@outlinedb/shared/cache";
import {createDatabase} from "../../db/index.js";

export interface SeedAccountStateResult
{
	/** Live rows sent, summed over the account tables. */
	rows: number;
	/** Expanded keys sent; null while the local cache has none seeded. */
	expandedKeys: number | null;
}

export default class SeedAccountState extends Command
{
	static override enableJsonFlag = true;

	static override description =
		"Read the account state (every account table's live rows plus the expanded keys) from the local cache and PUT it to /api/admin/account-state under the given Worker URL, seeding a Cloudflare deployment";

	static override examples = ["<%= config.bin %> cache:seed-account-state --url http://localhost:8787"];

	static override flags =
	{
		url: Flags.string(
			{
				description: "Worker base URL to seed",
				required: true,
			},
		),
		"access-client-id": Flags.string(
			{
				description: "Cloudflare Access service token client id (sent as CF-Access-Client-Id)",
				env: "CF_ACCESS_CLIENT_ID",
			},
		),
		"access-client-secret": Flags.string(
			{
				description: "Cloudflare Access service token client secret (sent as CF-Access-Client-Secret)",
				env: "CF_ACCESS_CLIENT_SECRET",
			},
		),
	};

	public async run(): Promise<SeedAccountStateResult>
	{
		const {flags} = await this.parse(SeedAccountState);
		const state = readAccountState(createDatabase());

		const headers: Record<string, string> =
		{
			"content-type": "application/json",
		};
		const clientId = flags["access-client-id"];
		const clientSecret = flags["access-client-secret"];
		if (clientId && clientSecret)
		{
			headers["CF-Access-Client-Id"] = clientId;
			headers["CF-Access-Client-Secret"] = clientSecret;
		}
		const response = await fetch(
			new URL("/api/admin/account-state", flags.url),
			{
				method: "PUT",
				headers,
				body: JSON.stringify(state),
				// Access answers a missing or unaccepted service token with a 302 to its login page, which 404s a PUT.
				redirect: "manual",
			},
		);
		if (response.status >= 300 && response.status < 400)
		{
			this.error(
				`Seeding failed: ${response.status} redirect to the Cloudflare Access login, so no service token was accepted. Set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET (or pass --access-client-id and --access-client-secret) to an Access service token allowed by the Worker's ALLOWED_SERVICE_TOKENS.`,
			);
		}
		if (!response.ok)
		{
			this.error(`Seeding failed: ${response.status} ${await response.text()}`);
		}
		const result =
		{
			rows: accountRowTotal(state.rows),
			expandedKeys: state.expandedKeys?.length ?? null,
		};
		this.log(
			`Seeded ${result.rows} account-table rows and ${result.expandedKeys ?? "no"} expanded keys to ${flags.url}`,
		);
		return result;
	}
}
