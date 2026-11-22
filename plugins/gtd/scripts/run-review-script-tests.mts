#!/usr/bin/env node
// Runs the tests that compute-llm-dag --files-dir wrote from `Test: <name>` nodes.
// Usage: node run-review-script-tests.mts [scripts-dir]   (default .llm/gtd/review/scripts)
import {spawnSync} from "node:child_process";
import {existsSync, mkdtempSync, readdirSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {isMain} from "./is-main.mts";
import {TESTS_SUBDIRECTORY} from "./compute-llm-dag.mts";

export interface ScriptTestResult
{
	name: string;
	passed: boolean;
	output: string;
}

/**
 * Runs every file in `<scriptsDirectory>/tests` in name order. Each runs as its own executable in a
 * fresh scratch directory, so fixtures it creates never land in the repo, with REVIEW_SCRIPTS_DIR
 * set to the absolute scripts directory. Exit code 0 passes; output is stdout then stderr.
 */
export function runScriptTests(scriptsDirectory: string): ScriptTestResult[]
{
	const scripts = resolve(scriptsDirectory);
	const testsDirectory = join(scripts, TESTS_SUBDIRECTORY);
	if (!existsSync(testsDirectory))
	{
		return [];
	}
	return readdirSync(testsDirectory)
		.toSorted()
		.map((name) =>
		{
			const scratch = mkdtempSync(join(tmpdir(), "review-script-test-"));
			try
			{
				const result = spawnSync(
					join(testsDirectory, name),
					[],
					{
						cwd: scratch,
						encoding: "utf8",
						env:
						{
							...process.env,
							REVIEW_SCRIPTS_DIR: scripts,
						},
					},
				);
				return {
					name,
					passed: result.status === 0,
					output: `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? `${result.error.message}\n` : ""}`,
				};
			}
			finally
			{
				rmSync(
					scratch,
					{
						recursive: true,
						force: true,
					},
				);
			}
		});
}

if (isMain(import.meta.url))
{
	const results = runScriptTests(process.argv[2] ?? ".llm/gtd/review/scripts");
	for (const {name, passed, output} of results)
	{
		process.stdout.write(`${passed ? "ok" : "FAIL"} ${name}\n`);
		if (!passed)
		{
			process.stdout.write(output);
		}
	}
	const failed = results.filter((result) => !result.passed).length;
	process.stdout.write(`${results.length - failed} passed, ${failed} failed\n`);
	process.exitCode = failed > 0 ? 1 : 0;
}
