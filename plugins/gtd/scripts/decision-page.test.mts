// Run: node --test plugins/gtd/scripts/decision-page.test.mts
/* eslint-disable @typescript-eslint/no-floating-promises -- node:test test() calls are fire-and-forget by design */
import {test} from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

const script = new URL("decision-page.mts", import.meta.url).pathname;

function run(args: string[], env: Record<string, string> = {})
{
	const result = spawnSync(
		process.execPath,
		[script, ...args],
		{
			encoding: "utf8",
			env:
			{
				...process.env,
				REBALANCE_WEB_APP_URL: "https://example.test",
				...env,
			},
		},
	);
	return {
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
	};
}

function withDirectory(body: (directory: string) => void): void
{
	const directory = mkdtempSync(join(tmpdir(), "decision-page-test-"));
	try
	{
		body(directory);
	}
	finally
	{
		rmSync(
			directory,
			{
				recursive: true,
				force: true,
			},
		);
	}
}

test("url prints the decision page under the web app base URL", () =>
{
	assert.deepStrictEqual(
		run(["url", "meetings"]),
		{
			status: 0,
			stdout: "https://example.test/decisions/meetings\n",
			stderr: "",
		},
	);
});

test("url defaults to the ladder's web app host", () =>
{
	const {REBALANCE_WEB_APP_URL: _ignored, ...env} = process.env;
	const result = spawnSync(
		process.execPath,
		[script, "url", "meetings"],
		{
			encoding: "utf8",
			env,
		},
	);
	assert.deepStrictEqual(
		{
			status: result.status,
			stdout: result.stdout,
		},
		{
			status: 0,
			stdout: "https://workflowy.m4.notlin.com/decisions/meetings\n",
		},
	);
});

test("answers prints the saved answers JSON", () =>
{
	withDirectory((directory) =>
	{
		const answers =
		{
			"a-1":
			{
				choice: "inbox",
				note: "",
				answeredAt: "2026-10-27T15:00:00.000Z",
			},
			submittedAt: "2026-10-27T15:05:00.000Z",
		};
		writeFileSync(join(directory, "meetings.answers.json"), JSON.stringify(answers));
		assert.deepStrictEqual(
			run(
				["answers", "meetings"],
				{
					OUTLINEDB_DECISIONS_DIR: directory,
				},
			),
			{
				status: 0,
				stdout: `${JSON.stringify(answers, null, 2)}\n`,
				stderr: "",
			},
		);
	});
});

test("answers exits non-zero naming the missing file when nothing was answered", () =>
{
	withDirectory((directory) =>
	{
		assert.deepStrictEqual(
			run(
				["answers", "meetings"],
				{
					OUTLINEDB_DECISIONS_DIR: directory,
				},
			),
			{
				status: 1,
				stdout: "",
				stderr: `No answers saved for decision page meetings (${join(directory, "meetings.answers.json")})\n`,
			},
		);
	});
});

test("a slug outside [a-z0-9-] is refused", () =>
{
	assert.deepStrictEqual(
		run(["url", "../x"]),
		{
			status: 2,
			stdout: "",
			stderr: 'Decision slug must match [a-z0-9-]+, got "../x"\n',
		},
	);
});

test("an unknown subcommand prints usage", () =>
{
	assert.deepStrictEqual(
		run(["open", "meetings"]),
		{
			status: 2,
			stdout: "",
			stderr: "Usage: decision-page.mts url <slug> | answers <slug>\n",
		},
	);
});
