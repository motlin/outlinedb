// Run: node --test plugins/gtd/scripts/otter-api-credentials.test.mts
/* eslint-disable @typescript-eslint/no-floating-promises -- node:test test() calls are fire-and-forget by design */
import {test} from "node:test";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";

const SCRIPT = fileURLToPath(new URL("otter-api.sh", import.meta.url));

/** Build a sandbox with a fake `op` that records every invocation. */
interface Sandbox
{
	dir: string;
	bin: string;
	cache: string;
	calls: string;
}

function sandbox(): Sandbox
{
	const dir = mkdtempSync(join(tmpdir(), "otter-creds-"));
	const bin = join(dir, "bin");
	const cache = join(dir, "cache");
	const calls = join(dir, "op-calls.log");
	mkdirSync(bin);
	mkdirSync(cache);
	const fakeOp = join(bin, "op");
	writeFileSync(
		fakeOp,
		[
			"#!/bin/bash",
			`echo "$*" >> ${JSON.stringify(calls)}`,
			'case "$2" in',
			"*username*) echo user@example.com ;;",
			"*) echo hunter2 ;;",
			"esac",
			"",
		].join("\n"),
	);
	chmodSync(fakeOp, 0o755);
	return {
		dir,
		bin,
		cache,
		calls,
	};
}

function warm(sb: Sandbox): string
{
	return execFileSync(
		"bash",
		[SCRIPT, "warm-credentials"],
		{
			env:
			{
				...process.env,
				PATH: `${sb.bin}:${process.env.PATH}`,
				OTTER_CACHE_DIR: sb.cache,
				OTTER_USERNAME: "op://Private/Otter/username",
				OTTER_PASSWORD: "op://Private/Otter/password",
			},
			encoding: "utf8",
		},
	);
}

const opCalls = (sb: Sandbox): string[] =>
	existsSync(sb.calls) ? readFileSync(sb.calls, "utf8").trim().split("\n").filter(Boolean) : [];

test("warm-credentials resolves op:// refs into the cache file", () =>
{
	const sb = sandbox();
	warm(sb);
	const creds = readFileSync(join(sb.cache, "otter-creds-cache"), "utf8");
	assert.deepStrictEqual(creds.trim().split("\n"), ["user@example.com", "hunter2"]);
	assert.equal(opCalls(sb).length, 2, "cold warm should call op exactly twice");
});

test("warm-credentials is a no-op once the cache exists, so subagents never invoke op", () =>
{
	const sb = sandbox();
	warm(sb);
	warm(sb);
	assert.equal(opCalls(sb).length, 2, "second warm must not invoke op again");
});

test("credential cache lives outside /tmp so reads do not trigger permission prompts", () =>
{
	const body = readFileSync(SCRIPT, "utf8");
	for (const stale of ["/tmp/otter-creds-cache", "/tmp/otter-session-cache", "/tmp/otter-userid-cache"])
	{
		assert.ok(!body.includes(stale), `${SCRIPT} must not hardcode ${stale}`);
	}
});

/** Sandbox whose fake `op` hangs forever, to prove the in-script timeout fires. */
function hangingSandbox()
{
	const sb = sandbox();
	writeFileSync(
		join(sb.bin, "op"),
		["#!/bin/bash", `echo "$*" >> ${JSON.stringify(sb.calls)}`, "sleep 600", ""].join("\n"),
	);
	chmodSync(join(sb.bin, "op"), 0o755);
	return sb;
}

test("a hanging op read is killed by the in-script timeout instead of blocking forever", () =>
{
	const sb = hangingSandbox();
	const started = Date.now();
	let failed = false;
	try
	{
		execFileSync(
			"bash",
			[SCRIPT, "warm-credentials"],
			{
				env:
				{
					...process.env,
					PATH: `${sb.bin}:${process.env.PATH}`,
					OTTER_CACHE_DIR: sb.cache,
					OTTER_OP_TIMEOUT: "1",
					OTTER_USERNAME: "op://Private/Otter/username",
					OTTER_PASSWORD: "op://Private/Otter/password",
				},
				encoding: "utf8",
				stdio: "pipe",
			},
		);
	}
	catch
	{
		failed = true;
	}
	const elapsed = Date.now() - started;
	assert.ok(failed, "a hanging op read must fail the script, not succeed");
	assert.ok(elapsed < 30_000, `expected the timeout to fire quickly, took ${elapsed}ms`);
	assert.ok(
		!existsSync(join(sb.cache, "otter-creds-cache")),
		"no cache file should be written from a timed-out resolve",
	);
});

test("the empty-response check stays fast on a large multibyte response", () =>
{
	const big = '{"title": "réunion — café ☕ ", "x": 1}, '.repeat(8000);
	const run = (value: string): string =>
		execFileSync(
			"/bin/bash",
			[
				"-c",
				`source ${JSON.stringify(SCRIPT)}; response_is_blank "$1" && echo blank || echo content`,
				"bash",
				value,
			],
			{
				encoding: "utf8",
				timeout: 10_000,
				env:
				{
					...process.env,
					LANG: "en_US.UTF-8",
					LC_ALL: "en_US.UTF-8",
				},
			},
		).trim();
	assert.equal(run(big), "content");
	assert.equal(run(" \n\t "), "blank");
	assert.equal(run(""), "blank");
});
