// A guided brand-new-user run against the hosted app (app.outlinedb.com unless OUTLINEDB_URL says otherwise). It
// automates no browser: Turnstile blocks automated Chrome by design, so Craig clicks through every step himself in his
// everyday Google Chrome, in the profile whose Gmail receives the test email. Each step prints what to do, waits for
// Enter, then checks the production AUTH_DB read-only (SELECTs through `wrangler d1 execute --remote`): the test email
// has no user before signup, then exactly one created during this run, verified, provisioned, and none after Craig
// deletes it in Settings. The script never writes to D1 and deletes nothing itself. The test email comes from
// OUTLINEDB_TEST_EMAIL (set it in the gitignored .envrc), never a tracked file, and must be allowed to sign up
// (SIGNUP_MODE open, or listed in SIGNUP_INVITES).
import {execFileSync} from "node:child_process";
import {dirname} from "node:path";
import {stdin, stdout} from "node:process";
import {createInterface} from "node:readline/promises";
import {parseTestUserRows, testUserQuery, walkthroughRefusal} from "./test-account-guard.ts";
import type {TestUserRow, WalkthroughStage} from "./test-account-guard.ts";

const base = (process.env.OUTLINEDB_URL ?? "https://app.outlinedb.com").replace(/\/+$/u, "");
const testEmail = process.env.OUTLINEDB_TEST_EMAIL ?? "";
const runStartedAt = new Date();
// wrangler reads packages/cloudflare/wrangler.jsonc for the AUTH_DB binding.
const packageDir = dirname(import.meta.dirname);
const prompt = createInterface(
	{
		input: stdin,
		output: stdout,
	},
);
const outcomes: string[] = [];

function testUserRows(): TestUserRow[]
{
	const output = execFileSync(
		"vp",
		["exec", "wrangler", "d1", "execute", "AUTH_DB", "--remote", "--json", "--command", testUserQuery(testEmail)],
		{
			cwd: packageDir,
			encoding: "utf8",
		},
	);
	return parseTestUserRows(output);
}

/**
 * Print what Craig should do, wait for Enter, then check D1 against the stage. When the check fails he can finish the
 * step and press Enter to check again, or type `skip` to record the failure and go on.
 */
async function step(title: string, instructions: readonly string[], stage: WalkthroughStage | null): Promise<void>
{
	stdout.write(`\n== ${title}\n${instructions.map((line) => `   ${line}\n`).join("")}`);
	let answer = await prompt.question("Press Enter when done. ");
	if (stage === null)
	{
		outcomes.push(`${title}: done`);
		return;
	}
	for (;;)
	{
		const refusal = walkthroughRefusal(stage, testUserRows(), runStartedAt);
		if (refusal === null)
		{
			stdout.write(`   D1 check passed (${stage}).\n`);
			outcomes.push(`${title}: ok`);
			return;
		}
		stdout.write(`   D1 check failed: ${refusal}.\n`);
		if (answer.trim().toLowerCase() === "skip")
		{
			outcomes.push(`${title}: FAILED (${refusal})`);
			return;
		}
		answer = await prompt.question("Press Enter to check again, or type skip to record the failure and go on. ");
	}
}

/** Ask Craig what the UI shows, for what D1 cannot tell without a session, and record his answer. */
async function note(title: string, question: string): Promise<void>
{
	const answer = (await prompt.question(`   ${question} `)).trim();
	outcomes.push(`${title}: ${answer === "" ? "(no answer)" : answer}`);
}

async function main(): Promise<void>
{
	if (testEmail.trim() === "")
	{
		throw new Error(
			"Set OUTLINEDB_TEST_EMAIL to the spare test address (in the gitignored .envrc), then run again.",
		);
	}
	stdout.write(`New-user walkthrough of ${base} as ${testEmail}, started ${runStartedAt.toISOString()}.\n`);
	const before = walkthroughRefusal("before signup", testUserRows(), runStartedAt);
	if (before !== null)
	{
		throw new Error(`Stopping before signup: ${before}.`);
	}
	stdout.write("No user has the test email yet.\n");

	await step(
		"Sign up",
		[
			`In your everyday Google Chrome, switch to the profile whose Gmail receives ${testEmail}.`,
			`Open ${base}/signup, enter ${testEmail}, choose a password, pass the Turnstile check and press Sign up.`,
		],
		"signed up",
	);
	await step(
		"Verify the email",
		[`In Gmail in that profile, open the OutlineDB verification email to ${testEmail} and click its link.`],
		"verified",
	);
	await step(
		"Starter outline",
		[`The app opens on the new outline. Check it shows Inbox and "Welcome to OutlineDB" at the top level.`],
		"provisioned",
	);
	await note("Starter outline as seen", "What does the top level show (anything missing or odd)?");
	await step(
		"Connect workflowy.com and import",
		[
			"Open Settings > Workflowy, sign in to workflowy.com (password and any code), then start the import.",
			"Wait for it to finish or fail; this script cannot read its progress without a session.",
		],
		null,
	);
	await note("Workflowy import", "What does the import show when it ends (status, node count, any error)?");
	await step(
		"Delete the test account",
		[`Open Settings > Account > Delete account and confirm with the password, so ${testEmail} is fresh next time.`],
		"deleted",
	);

	stdout.write(`\n== Summary\n${outcomes.map((line) => `   ${line}\n`).join("")}`);
	if (outcomes.some((line) => line.includes(": FAILED")))
	{
		process.exitCode = 1;
	}
}

try
{
	await main();
}
finally
{
	prompt.close();
}
