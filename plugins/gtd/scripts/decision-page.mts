// Agent side of a decision page: print its URL for the user, then read back what they chose.
//
// `url` health-checks before printing: it fetches the page and its staged document from the web app and
// exits 1 on a non-2xx status or a network error, so a dead dev server never reaches the user as a 502.
//
// The review stages `.llm/gtd/review/decisions/<slug>.json`; the web app saves each answer to
// `<slug>.answers.json` beside it. OUTLINEDB_DECISIONS_DIR overrides the directory, as it does for the server.

import {existsSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {parseJson} from "./json.mts";
import {webAppUrl} from "./web-app-url.mts";

const USAGE = "Usage: decision-page.mts url <slug> | answers <slug>";
const SLUG = /^[a-z0-9-]+$/u;

function decisionsDirectory(): string
{
	return process.env.OUTLINEDB_DECISIONS_DIR ?? join(import.meta.dirname, "../../../.llm/gtd/review/decisions");
}

function fail(status: number, message: string): never
{
	process.stderr.write(`${message}\n`);
	process.exit(status);
}

/** The web app's `{"error": "..."}` explanation of a failed response, when it sent one. */
async function errorMessage(response: Response): Promise<string | undefined>
{
	try
	{
		const body: unknown = await response.json();
		return typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
			? body.error
			: undefined;
	}
	catch
	{
		return undefined;
	}
}

/** Why `url` is not serving, or undefined when it answers 2xx. */
async function probe(url: URL): Promise<string | undefined>
{
	try
	{
		const response = await fetch(
			url,
			{
				signal: AbortSignal.timeout(10_000),
			},
		);
		if (response.ok)
		{
			return undefined;
		}
		const reason = await errorMessage(response);
		return reason === undefined ? `HTTP ${response.status}` : `HTTP ${response.status} (${reason})`;
	}
	catch (error)
	{
		const cause = error instanceof Error ? error.cause : undefined;
		const code = cause instanceof Error && "code" in cause ? cause.code : undefined;
		return typeof code === "string" ? code : String(error);
	}
}

async function checkServing(url: URL): Promise<void>
{
	const problem = await probe(url);
	if (problem !== undefined)
	{
		fail(
			1,
			`Decision page ${url.href} is not serving: ${problem}. Restart the web app (just web) if it is down or fix the staged document, then run this again before giving the user the URL.`,
		);
	}
}

async function main(): Promise<void>
{
	const [command, slug, ...rest] = process.argv.slice(2);
	if ((command !== "url" && command !== "answers") || slug === undefined || rest.length > 0)
	{
		fail(2, USAGE);
	}
	if (!SLUG.test(slug))
	{
		fail(2, `Decision slug must match [a-z0-9-]+, got "${slug}"`);
	}
	if (command === "url")
	{
		const page = webAppUrl(`/decisions/${slug}`);
		await checkServing(page);
		await checkServing(webAppUrl(`/api/v1/decisions/${slug}`));
		process.stdout.write(`${page.href}\n`);
		return;
	}
	const file = join(decisionsDirectory(), `${slug}.answers.json`);
	if (!existsSync(file))
	{
		fail(1, `No answers saved for decision page ${slug} (${file})`);
	}
	process.stdout.write(`${JSON.stringify(parseJson(readFileSync(file, "utf8")), null, 2)}\n`);
}

await main();
