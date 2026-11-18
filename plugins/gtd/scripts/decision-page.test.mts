// Run: node --test plugins/gtd/scripts/decision-page.test.mts
/* eslint-disable @typescript-eslint/no-floating-promises -- node:test test() calls are fire-and-forget by design */
import {test} from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {createServer} from "node:http";
import {mkdtempSync, realpathSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

const script = new URL("decision-page.mts", import.meta.url).pathname;

interface RunResult
{
	status: number | null;
	stdout: string;
	stderr: string;
}

// Async, not spawnSync: the in-process web app stub must keep answering while the script runs.
async function run(args: string[], env: Record<string, string> = {}, cwd?: string): Promise<RunResult>
{
	const child = spawn(
		process.execPath,
		[script, ...args],
		{
			cwd,
			env:
			{
				...process.env,
				REBALANCE_WEB_APP_URL: "https://example.test",
				...env,
			},
		},
	);
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8").on("data", (chunk: string) =>
	{
		stdout += chunk;
	});
	child.stderr.setEncoding("utf8").on("data", (chunk: string) =>
	{
		stderr += chunk;
	});
	const status = await new Promise<number | null>((resolve) =>
	{
		child.on("close", resolve);
	});
	return {
		status,
		stdout,
		stderr,
	};
}

/** Serve `responses[path]` (a bare 404 otherwise) on a local port while `body` runs against its origin. */
async function withWebApp(
	responses: Record<
		string,
		| number
		|
		  {
				status: number;
				json: unknown;
		  }
	>,
	body: (origin: string) => Promise<void> | void,
): Promise<void>
{
	const server = createServer((request, response) =>
	{
		const answer = responses[request.url ?? ""] ?? 404;
		if (typeof answer === "number")
		{
			response.statusCode = answer;
			response.end();
			return;
		}
		response.statusCode = answer.status;
		response.setHeader("content-type", "application/json");
		response.end(JSON.stringify(answer.json));
	});
	await new Promise<void>((resolve) =>
	{
		server.listen(0, "127.0.0.1", resolve);
	});
	try
	{
		const address = server.address();
		assert.ok(typeof address === "object" && address !== null);
		await body(`http://127.0.0.1:${address.port}`);
	}
	finally
	{
		server.close();
	}
}

async function withDirectory(body: (directory: string) => Promise<void>): Promise<void>
{
	const directory = mkdtempSync(join(tmpdir(), "decision-page-test-"));
	try
	{
		await body(directory);
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

test("url prints the decision page URL once the page and its staged document both load", async () =>
{
	await withWebApp(
		{
			"/decisions/meetings": 200,
			"/api/v1/decisions/meetings": 200,
		},
		async (origin) =>
		{
			assert.deepStrictEqual(
				await run(
					["url", "meetings"],
					{
						REBALANCE_WEB_APP_URL: origin,
					},
				),
				{
					status: 0,
					stdout: `${origin}/decisions/meetings\n`,
					stderr: "",
				},
			);
		},
	);
});

test("url fails naming the status when the page itself errors, as a dead Vite front end 502s", async () =>
{
	await withWebApp(
		{
			"/decisions/meetings": 502,
			"/api/v1/decisions/meetings": 200,
		},
		async (origin) =>
		{
			assert.deepStrictEqual(
				await run(
					["url", "meetings"],
					{
						REBALANCE_WEB_APP_URL: origin,
					},
				),
				{
					status: 1,
					stdout: "",
					stderr: `Decision page ${origin}/decisions/meetings is not serving: HTTP 502. Restart the web app (just web) if it is down or fix the staged document, then run this again before giving the user the URL.\n`,
				},
			);
		},
	);
});

test("url fails when the page loads but its staged document does not", async () =>
{
	await withWebApp(
		{
			"/decisions/meetings": 200,
		},
		async (origin) =>
		{
			assert.deepStrictEqual(
				await run(
					["url", "meetings"],
					{
						REBALANCE_WEB_APP_URL: origin,
					},
				),
				{
					status: 1,
					stdout: "",
					stderr: `Decision page ${origin}/api/v1/decisions/meetings is not serving: HTTP 404. Restart the web app (just web) if it is down or fix the staged document, then run this again before giving the user the URL.\n`,
				},
			);
		},
	);
});

test("url fails quoting the API's error when the staged document is invalid", async () =>
{
	await withWebApp(
		{
			"/decisions/meetings": 200,
			"/api/v1/decisions/meetings":
			{
				status: 500,
				json:
				{
					error: "Item ids must be unique",
				},
			},
		},
		async (origin) =>
		{
			assert.deepStrictEqual(
				await run(
					["url", "meetings"],
					{
						REBALANCE_WEB_APP_URL: origin,
					},
				),
				{
					status: 1,
					stdout: "",
					stderr: `Decision page ${origin}/api/v1/decisions/meetings is not serving: HTTP 500 (Item ids must be unique). Restart the web app (just web) if it is down or fix the staged document, then run this again before giving the user the URL.\n`,
				},
			);
		},
	);
});

test("url fails naming the network error when nothing is listening", async () =>
{
	let origin = "";
	await withWebApp({}, (served) =>
	{
		origin = served;
	});
	assert.deepStrictEqual(
		await run(
			["url", "meetings"],
			{
				REBALANCE_WEB_APP_URL: origin,
			},
		),
		{
			status: 1,
			stdout: "",
			stderr: `Decision page ${origin}/decisions/meetings is not serving: ECONNREFUSED. Restart the web app (just web) if it is down or fix the staged document, then run this again before giving the user the URL.\n`,
		},
	);
});

test("answers prints the saved answers JSON", async () =>
{
	await withDirectory(async (directory) =>
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
			await run(
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

test("answers looks in the caller's .llm decisions directory, not beside the installed script, and names the missing file", async () =>
{
	await withDirectory(async (directory) =>
	{
		const repo = realpathSync(directory);
		assert.deepStrictEqual(
			await run(["answers", "meetings"], {}, repo),
			{
				status: 1,
				stdout: "",
				stderr: `No answers saved for decision page meetings (${join(repo, ".llm/gtd/review/decisions/meetings.answers.json")})\n`,
			},
		);
	});
});

test("a slug outside [a-z0-9-] is refused", async () =>
{
	assert.deepStrictEqual(
		await run(["url", "../x"]),
		{
			status: 2,
			stdout: "",
			stderr: 'Decision slug must match [a-z0-9-]+, got "../x"\n',
		},
	);
});

test("an unknown subcommand prints usage", async () =>
{
	assert.deepStrictEqual(
		await run(["open", "meetings"]),
		{
			status: 2,
			stdout: "",
			stderr: "Usage: decision-page.mts url <slug> | answers <slug>\n",
		},
	);
});
