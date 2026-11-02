import {expect, describe, it} from "vite-plus/test";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {joinContinuationLines} from "./helpers/markdown-parser.js";
import {PROJECT_ROOT, trackedFiles} from "./helpers/scan-roots.js";

/**
 * `plugins/workflowy/skills/cli-usage.md` bans `2>/dev/null` on CLI commands:
 * a suppressed error turns a failed write into a phantom success, and the
 * calling script or prompt then reports "Deleted" for a node that still
 * exists. This eval enforces that rule mechanically for the mutating
 * `node` subcommands, where the cost of a silent failure is highest.
 *
 * Read-only subcommands (`get`, `list`, `search`, `schema`, `changes`) are
 * out of scope -- they are noisy and a swallowed error costs nothing.
 *
 * Only tracked files are scanned, matching no-personal-paths.
 */

const MUTATING_INVOCATION = /\.\/bin\/run\.js node (?:complete|create|delete|move|uncomplete|update)\b/u;
const DEV_NULL_REDIRECT = /(?:[12&]?>|>&)\s*\/dev\/null/u;

describe("Structural Eval: No Suppressed Mutations", () =>
{
	it("no tracked file under plugins/ redirects a mutating node command to /dev/null", () =>
	{
		const violations: string[] = [];

		for (const relativePath of trackedFiles("plugins"))
		{
			const content = readFileSync(join(PROJECT_ROOT, relativePath), "utf8");
			for (const {text, lineNumber} of joinContinuationLines(content.split("\n")))
			{
				if (MUTATING_INVOCATION.test(text) && DEV_NULL_REDIRECT.test(text))
				{
					violations.push(`${relativePath}:${lineNumber}: ${text.trim()}`);
				}
			}
		}

		expect(violations).toStrictEqual([]);
	});
});
