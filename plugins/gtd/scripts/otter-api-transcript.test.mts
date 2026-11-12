// Run: node --test plugins/gtd/scripts/otter-api-transcript.test.mts
/* eslint-disable @typescript-eslint/no-floating-promises -- node:test test() calls are fire-and-forget by design */
import {test} from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtempSync, mkdirSync, writeFileSync, chmodSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";

const SCRIPT = fileURLToPath(new URL("otter-api.sh", import.meta.url));

/** Otter offsets count 16 kHz audio samples. Sandbox with a fake `curl` that serves one speech body for any speech?otid= request. */
interface Sandbox
{
	cache: string;
	bin: string;
}

interface RunResult
{
	status: number | null;
	stdout: string;
	stderr: string;
}

function sandbox(speechBody: unknown): Sandbox
{
	const dir = mkdtempSync(join(tmpdir(), "otter-transcript-"));
	const bin = join(dir, "bin");
	const cache = join(dir, "cache");
	for (const d of [bin, cache])
	{
		mkdirSync(d);
	}
	writeFileSync(join(cache, "otter-session-cache"), "");
	writeFileSync(join(cache, "otter-userid-cache"), "42");
	const fixture = join(dir, "speech.json");
	writeFileSync(fixture, JSON.stringify(speechBody));
	const fakeCurl = join(bin, "curl");
	writeFileSync(
		fakeCurl,
		[
			"#!/bin/bash",
			'meta=""',
			'for a in "$@"; do case "$a" in *http_code*) meta=1 ;; esac; done',
			`cat ${JSON.stringify(fixture)}`,
			String.raw`[[ -n "$meta" ]] && printf '\n{"http_code":"200","time_total":"0.01"}'`,
			"exit 0",
			"",
		].join("\n"),
	);
	chmodSync(fakeCurl, 0o755);
	return {
		cache,
		bin,
	};
}

function transcript(sb: Sandbox, ...args: string[]): RunResult
{
	const result = spawnSync(
		"bash",
		[SCRIPT, "transcript", ...args],
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

test("transcript renders a header and one speaker-labelled line per transcript segment, in order", () =>
{
	const sb = sandbox(
		{
			speech:
			{
				otid: "abc123",
				title: "1:1 Alice",
				start_time: 1_790_000_000,
				speakers: [
					{
						id: 1,
						speaker_name: "Alice",
					},
					{
						id: 2,
						speaker_name: "Bob",
					},
				],
				transcripts: [
					{
						start_offset: 1_040_000,
						speaker_id: 2,
						transcript: "Second thing.",
					},
					{
						start_offset: 0,
						speaker_id: 1,
						transcript: "First thing.",
					},
					{
						start_offset: 59_600_000,
						speaker_id: 9,
						transcript: "Unknown speaker.",
					},
				],
			},
		},
	);
	const {status, stdout, stderr} = transcript(sb, "abc123");
	assert.equal(status, 0, stderr);
	assert.equal(
		stdout,
		[
			"# 1:1 Alice",
			"Date: 2026-09-21T14:13:20Z",
			"URL: https://otter.ai/u/abc123",
			"",
			"[00:00] Alice: First thing.",
			"[01:05] Bob: Second thing.",
			"[62:05] Speaker 9: Unknown speaker.",
			"",
		].join("\n"),
	);
});

test("transcript requires an otid", () =>
{
	const sb = sandbox(
		{
			speech: {},
		},
	);
	const {status, stderr} = transcript(sb);
	assert.equal(status, 1);
	assert.equal(stderr, '{"error": "transcript command requires otid argument"}\n');
});

test("transcript fails clearly when Otter returns no speech for the otid", () =>
{
	const sb = sandbox(
		{
			status: "error",
			speech: null,
		},
	);
	const {status, stdout, stderr} = transcript(sb, "gone123");
	assert.equal(status, 1);
	assert.equal(stdout, "");
	assert.equal(stderr, '{"error": "no speech found for otid gone123"}\n');
});
