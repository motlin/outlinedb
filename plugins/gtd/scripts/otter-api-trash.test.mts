// Run: node --test plugins/gtd/scripts/otter-api-trash.test.mts
/* eslint-disable @typescript-eslint/no-floating-promises -- node:test test() calls are fire-and-forget by design */
import {test} from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";

const SCRIPT = fileURLToPath(new URL("otter-api.sh", import.meta.url));

/** Sandbox with a fake `curl` that records its arguments and never touches the network. */
function sandbox():
{
	cache: string;
	bin: string;
	argsLog: string;
}
{
	const dir = mkdtempSync(join(tmpdir(), "otter-trash-"));
	const bin = join(dir, "bin");
	const cache = join(dir, "cache");
	mkdirSync(bin);
	mkdirSync(cache);
	writeFileSync(
		join(cache, "otter-session-cache"),
		[
			"# Netscape HTTP Cookie File",
			".otter.ai\tTRUE\t/\tTRUE\t0\tcsrftoken\ttok123",
			".otter.ai\tTRUE\t/\tTRUE\t0\tsessionid\tsess",
			"",
		].join("\n"),
	);
	writeFileSync(join(cache, "otter-userid-cache"), "42");
	const argsLog = join(dir, "curl-args.txt");
	writeFileSync(
		join(bin, "curl"),
		[
			"#!/bin/bash",
			`printf '%s\\n' "$@" > ${JSON.stringify(argsLog)}`,
			`echo '{"status": "OK"}'`,
			"exit 0",
			"",
		].join("\n"),
	);
	chmodSync(join(bin, "curl"), 0o755);
	return {
		cache,
		bin,
		argsLog,
	};
}

function run(
	sb:
	{
		cache: string;
		bin: string;
	},
	...args: string[]
)
{
	const result = spawnSync(
		"bash",
		[SCRIPT, ...args],
		{
			env:
			{
				...process.env,
				PATH: `${sb.bin}:${process.env.PATH}`,
				OTTER_CACHE_DIR: sb.cache,
			},
			encoding: "utf8",
		},
	);
	return {
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
	};
}

test("trash posts move_to_trash_bin with otid, csrf header, cookie file and referer", () =>
{
	const sb = sandbox();
	const result = run(sb, "trash", "otid-xyz");
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout.trim(), '{"status": "OK"}');
	const args = readFileSync(sb.argsLog, "utf8").trim().split("\n");
	assert.deepEqual(args, [
		"-s",
		"-X",
		"POST",
		"-b",
		join(sb.cache, "otter-session-cache"),
		"-H",
		"x-csrftoken: tok123",
		"-H",
		"referer: https://otter.ai/",
		"-H",
		"accept: application/json",
		"--data-urlencode",
		"otid=otid-xyz",
		"https://otter.ai/forward/api/v1/move_to_trash_bin?userid=42",
	]);
});

test("trash without an otid fails and sends nothing", () =>
{
	const sb = sandbox();
	const result = run(sb, "trash");
	assert.equal(result.status, 1);
	assert.match(result.stderr, /trash command requires otid argument/u);
	assert.throws(() => readFileSync(sb.argsLog, "utf8"));
});
