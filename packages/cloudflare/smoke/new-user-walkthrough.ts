// A brand-new-user run against the hosted app (app.outlinedb.com unless OUTLINEDB_URL says otherwise), in Craig's real
// Google Chrome, in the walkthrough's own Chrome profile signed in to Google as the test email (so Gmail and 1Password
// are there; see chrome-profile.ts): sign up the test email, verify it, check the starter outline, connect and import workflowy.com, then
// delete the account so the same email is fresh next time. Craig types every password, Turnstile and 2FA code; the
// script never stores one. The test email comes from OUTLINEDB_TEST_EMAIL (set it in the gitignored .envrc), never a
// tracked file, and must be allowed to sign up (SIGNUP_MODE open, or listed in SIGNUP_INVITES). It deletes only the account this run created.
import {stdin, stdout} from "node:process";
import {createInterface} from "node:readline/promises";
import {chromium} from "playwright-core";
import type {Page} from "playwright-core";
import {walkthroughProfileFor} from "./chrome-profile.ts";
import {deletionRefusal, existingSessionRefusal} from "./test-account-guard.ts";
import type {WalkthroughSession} from "./test-account-guard.ts";

const base = (process.env.OUTLINEDB_URL ?? "https://app.outlinedb.com").replace(/\/+$/u, "");
const testEmail = process.env.OUTLINEDB_TEST_EMAIL;
const runStartedAt = new Date();

async function ask(question: string): Promise<string>
{
	const prompt = createInterface(
		{
			input: stdin,
			output: stdout,
		},
	);
	try
	{
		return (await prompt.question(question)).trim();
	}
	finally
	{
		prompt.close();
	}
}

/** Read a line without echoing it, for the password the deletion needs. */
async function askHidden(question: string): Promise<string>
{
	stdout.write(question);
	stdin.setRawMode(true);
	stdin.resume();
	stdin.setEncoding("utf8");
	let typed = "";
	try
	{
		return await new Promise<string>((resolve, reject) =>
		{
			const onData = (chunk: string) =>
			{
				for (const char of chunk)
				{
					if (char === "\r" || char === "\n")
					{
						stdin.off("data", onData);
						resolve(typed);
						return;
					}
					if (char === "\u0003")
					{
						stdin.off("data", onData);
						reject(new Error("cancelled"));
						return;
					}
					typed = char === "\u007F" ? typed.slice(0, -1) : typed + char;
				}
			};
			stdin.on("data", onData);
		});
	}
	finally
	{
		stdin.setRawMode(false);
		stdin.pause();
		stdout.write("\n");
	}
}

/** A same-origin JSON request from the page, so it carries the session cookie and passes Better Auth's origin check. */
async function call(
	page: Page,
	path: string,
	init:
	{
		method?: string;
		body?: unknown;
	} = {},
): Promise<
{
	status: number;
	body: unknown;
}>
{
	// The browser context's request client shares the page's cookies but not its JavaScript context, so a page that is
	// still navigating (the app redirecting on first load) cannot destroy the call.
	const response = await page.context().request.fetch(
		`${base}${path}`,
		{
			method: init.method ?? "GET",
			// Better Auth refuses a cookie-authenticated POST without a trusted Origin.
			headers:
			{
				origin: base,
			},
			data: init.body,
			failOnStatusCode: false,
		},
	);
	const text = await response.text();
	return {
		status: response.status(),
		body: text === "" ? null : (JSON.parse(text) as unknown),
	};
}

async function session(page: Page): Promise<WalkthroughSession | null>
{
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Better Auth's get-session answers a session or null
	return (await call(page, "/api/auth/get-session")).body as WalkthroughSession | null;
}

async function poll<T>(
	read: () => Promise<T>,
	done: (value: T) => boolean,
	what: string,
	timeoutMs: number,
): Promise<T>
{
	const deadline = Date.now() + timeoutMs;
	for (;;)
	{
		const value = await read();
		if (done(value))
		{
			return value;
		}
		if (Date.now() > deadline)
		{
			throw new Error(`timed out waiting for ${what}: ${JSON.stringify(value)}`);
		}
		await new Promise((resolve) =>
		{
			setTimeout(resolve, 2000);
		});
	}
}

/** The names in a `GET /api/v1/nodes` body, `{nodes: {name}[]}`. */
function nodeNames(body: unknown): string[]
{
	const nodes: unknown = typeof body === "object" && body !== null ? Reflect.get(body, "nodes") : undefined;
	return Array.isArray(nodes)
		? nodes.flatMap((node: unknown) =>
			{
				const name: unknown = typeof node === "object" && node !== null ? Reflect.get(node, "name") : undefined;
				return typeof name === "string" ? [name] : [];
			})
		: [];
}

function step(text: string): void
{
	stdout.write(`\n== ${text}\n`);
}

async function main(): Promise<void>
{
	if (testEmail === undefined || testEmail.trim() === "")
	{
		throw new Error(
			"Set OUTLINEDB_TEST_EMAIL to the spare test address (in the gitignored .envrc), then run again.",
		);
	}
	const profile = walkthroughProfileFor(testEmail);
	const context = await chromium.launchPersistentContext(
		profile.userDataDir,
		{
			channel: "chrome",
			headless: false,
			viewport: null,
			args: [`--profile-directory=${profile.directory}`],
			// Playwright's defaults would hide the profile's extensions (1Password) and swap in a mock keychain that cannot
			// decrypt the cookies plain Chrome saved (the Google session). Sync stays off.
			ignoreDefaultArgs: ["--disable-extensions", "--use-mock-keychain", "--enable-automation"],
		},
	);
	try
	{
		const page = await context.newPage();
		await page.goto(base);
		const before = existingSessionRefusal(
			{
				cookieNames: (await context.cookies(base)).map(({name}) => name),
				session: await session(page),
			},
		);
		if (before !== null)
		{
			throw new Error(`Stopping before signup: ${before}. The run must start as a brand-new user.`);
		}

		step("Sign up");
		await page.goto(`${base}/signup`);
		await page.locator('input[name="email"]').fill(testEmail);
		await ask(
			"In the browser, choose a password, pass the Turnstile check and press Sign up. Then press Enter here. ",
		);

		step("Verify the email");
		const link = await ask(
			`Open Gmail in a new tab of that Chrome and paste the verification link sent to ${testEmail}: `,
		);
		if (new URL(link).origin !== new URL(base).origin)
		{
			throw new Error(`That link is not on ${base}`);
		}
		await page.goto(link);
		const verified = await session(page);
		const createdUserId = verified?.user.id;
		// Checked before anything else, so an address that already had an account (Craig's, or one with real data)
		// stops the run here rather than at deletion.
		const early = deletionRefusal(
			{
				testEmail,
				session: verified,
				createdUserId,
				runStartedAt,
			},
		);
		if (early !== null)
		{
			throw new Error(`Stopping without deleting anything: ${early}.`);
		}

		step("Starter outline");
		const top = await poll(
			async () => call(page, "/api/v1/nodes"),
			({status}) => status === 200,
			"the outline",
			60_000,
		);
		const names = nodeNames(top.body);
		if (!names.includes("Inbox") || !names.includes("Welcome to OutlineDB"))
		{
			throw new Error(`The new outline lacks the starter content: ${JSON.stringify(names)}`);
		}
		stdout.write(`Top level: ${names.join(", ")}\n`);

		step("Connect workflowy.com and import");
		await ask(
			"In the browser, open Settings > Workflowy, sign in to workflowy.com (password and any code), then start the import. Press Enter once it has started. ",
		);
		await poll(
			async () => call(page, "/api/v1/workflowy-connection"),
			({body}) => typeof body === "object" && body !== null && Reflect.get(body, "connected") === true,
			"the workflowy.com connection",
			10 * 60_000,
		);
		const imported = await poll(
			async () => call(page, "/api/v1/workflowy-import"),
			({body}) =>
			{
				const run: unknown = typeof body === "object" && body !== null ? Reflect.get(body, "run") : null;
				const status: unknown =
					typeof run === "object" && run !== null ? Reflect.get(run, "status") : undefined;
				return status === "ok" || status === "error";
			},
			"the import to finish",
			60 * 60_000,
		);
		stdout.write(`Import: ${JSON.stringify(imported.body)}\n`);

		step("Delete the test account");
		const refusal = deletionRefusal(
			{
				testEmail,
				session: await session(page),
				createdUserId,
				runStartedAt,
			},
		);
		if (refusal !== null)
		{
			throw new Error(`Not deleting: ${refusal}.`);
		}
		const password = await askHidden(`Password of ${testEmail} on OutlineDB, to delete it: `);
		const deleted = await call(
			page,
			"/api/auth/delete-user",
			{
				method: "POST",
				body:
				{
					password,
				},
			},
		);
		if (deleted.status !== 200)
		{
			throw new Error(`Deletion failed: ${deleted.status} ${JSON.stringify(deleted.body)}`);
		}
		if ((await session(page)) !== null)
		{
			throw new Error("Still signed in after the deletion");
		}
		stdout.write(`Deleted. ${testEmail} can sign up again.\n`);
	}
	finally
	{
		await context.close();
	}
}

await main();
