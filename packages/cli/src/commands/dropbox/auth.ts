import {Command} from "@oclif/core";
import {DropboxAuth} from "dropbox";
import {createServer} from "node:http";
import {log} from "../../services/logger.js";
import {nonEmpty} from "../../utils/non-empty.js";

export default class DropboxAuthCommand extends Command
{
	static override description = "Authenticate with Dropbox to get a refresh token";

	static override examples = ["<%= config.bin %> <%= command.id %>"];

	public async run(): Promise<void>
	{
		await this.parse(DropboxAuthCommand);

		const clientId = nonEmpty(process.env.DROPBOX_ACCESS_KEY) ?? process.env.DROPBOX_APP_KEY;
		const clientSecret = nonEmpty(process.env.DROPBOX_ACCESS_SECRET) ?? process.env.DROPBOX_APP_SECRET;

		if (!clientId || !clientSecret)
		{
			this.error(
				"DROPBOX_ACCESS_KEY and DROPBOX_ACCESS_SECRET environment variables must be set.\n" +
					"Run with: op run -- ./bin/dev.js dropbox:auth",
			);
		}

		// Use PKCE flow (without clientSecret) - Dropbox supports this for installed/mobile apps
		const dbxAuth = new DropboxAuth(
			{
				clientId,
			},
		);

		const redirectUri = "http://localhost:8912/callback";

		// Request read + write scopes for downloading backups and deleting old ones
		const scopes = ["files.content.read", "files.content.write"];

		const authUrl = await dbxAuth.getAuthenticationUrl(
			redirectUri,
			undefined,
			"code",
			"offline",
			scopes,
			undefined,
			true,
		);

		const codeVerifier = dbxAuth.getCodeVerifier();
		log.general.debug(
			{
				present: Boolean(codeVerifier),
			},
			"Code verifier generated",
		);
		if (codeVerifier)
		{
			log.general.debug(
				{
					length: codeVerifier.length,
				},
				"Code verifier length",
			);
		}

		this.log("\n🔐 Dropbox OAuth2 Authentication\n");
		this.log("Opening browser for authentication...\n");

		const {exec} = await import("node:child_process");
		exec(`open "${authUrl}"`);

		let authCode = "";
		const server = createServer((req, res) =>
		{
			const url = new URL(req.url ?? "", `http://localhost:8912`);
			if (url.pathname === "/callback")
			{
				authCode = url.searchParams.get("code") ?? "";
				res.writeHead(
					200,
					{
						"Content-Type": "text/html",
					},
				);
				res.end(
					"<html><body><h1>✅ Authentication successful!</h1><p>You can close this window and return to the terminal.</p></body></html>",
				);
				server.close();
			}
		});

		await new Promise<void>((resolve) =>
		{
			server.listen(8912, () =>
			{
				this.log("Waiting for authentication...");
				resolve();
			});
		});

		await new Promise<void>((resolve) =>
		{
			server.on("close", () =>
			{
				resolve();
			});
		});

		if (!authCode)
		{
			this.error("Failed to receive authorization code");
		}

		try
		{
			this.log("\nExchanging code for token...");
			const verifierCheck = dbxAuth.getCodeVerifier();
			log.general.debug(
				{
					present: Boolean(verifierCheck),
				},
				"Code verifier still present",
			);

			const response = await dbxAuth.getAccessTokenFromCode(redirectUri, authCode);
			const result = response.result as
			{
				refresh_token?: string;
				access_token?: string;
			};
			const refreshToken = result.refresh_token;

			if (!refreshToken)
			{
				this.log("\nResponse from Dropbox:");
				this.log(JSON.stringify(result, null, 2));
				this.error("Failed to get refresh token from Dropbox");
			}

			this.log("\n✅ Authentication successful!\n");
			this.log('Add this to 1Password as a new field "Refresh token":\n');
			this.log(`${refreshToken}\n`);
			this.log('Then set: export DROPBOX_REFRESH_TOKEN="op://Private/dropbox.com/Refresh token"');
		}
		catch (error)
		{
			if (error instanceof Error)
			{
				this.log("\nError details:");
				this.log(JSON.stringify(error, null, 2));
				this.error(`Authentication failed: ${error.message}`);
			}

			this.error(`Authentication failed: ${JSON.stringify(error)}`);
		}
	}
}
