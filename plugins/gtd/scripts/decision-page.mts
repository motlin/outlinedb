// Agent side of a decision page: print its URL for the user, then read back what they chose.
//
// The review stages `.llm/gtd/review/decisions/<slug>.json`; the web app saves each answer to
// `<slug>.answers.json` beside it. OUTLINEDB_DECISIONS_DIR overrides the directory, as it does for the server.

import {existsSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {parseJson} from "./json.mts";
import {webAppUrl} from "./web-app-url.mts";

const USAGE = "Usage: decision-page.mts url <slug> | answers <slug>";
const SLUG = /^[a-z0-9-]+$/u;

function decisionsDirectory(): string {
	return process.env.OUTLINEDB_DECISIONS_DIR ?? join(import.meta.dirname, "../../../.llm/gtd/review/decisions");
}

function fail(status: number, message: string): never {
	process.stderr.write(`${message}\n`);
	process.exit(status);
}

function main(): void {
	const [command, slug, ...rest] = process.argv.slice(2);
	if ((command !== "url" && command !== "answers") || slug === undefined || rest.length > 0) {
		fail(2, USAGE);
	}
	if (!SLUG.test(slug)) {
		fail(2, `Decision slug must match [a-z0-9-]+, got "${slug}"`);
	}
	if (command === "url") {
		process.stdout.write(`${webAppUrl(`/decisions/${slug}`).href}\n`);
		return;
	}
	const file = join(decisionsDirectory(), `${slug}.answers.json`);
	if (!existsSync(file)) {
		fail(1, `No answers saved for decision page ${slug} (${file})`);
	}
	process.stdout.write(`${JSON.stringify(parseJson(readFileSync(file, "utf8")), null, 2)}\n`);
}

main();
