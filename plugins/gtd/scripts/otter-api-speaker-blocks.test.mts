// Run: node --test plugins/gtd/scripts/otter-api-speaker-blocks.test.mts
/* eslint-disable @typescript-eslint/no-floating-promises -- node:test test() calls are fire-and-forget by design */
import {test} from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtempSync, mkdirSync, writeFileSync, chmodSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";

const SCRIPT = fileURLToPath(new URL("otter-api.sh", import.meta.url));

/** Sandbox with a fake `curl` that serves one speech body for any request. Otter offsets count 16 kHz audio samples. */
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
	const dir = mkdtempSync(join(tmpdir(), "otter-speaker-blocks-"));
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

function speakerBlocks(sb: Sandbox, ...args: string[]): RunResult
{
	const result = spawnSync(
		"bash",
		[SCRIPT, "speaker-blocks", ...args],
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

const SPEECH =
{
	speech:
	{
		otid: "abc123",
		title: "1:1 Alice",
		start_time: 1_790_000_000,
		speakers: [
			{
				id: 1,
				speaker_name: "Bob",
				self_speaker: true,
			},
			{
				id: 2,
				speaker_name: "Speaker 2",
				self_speaker: false,
			},
		],
		transcripts: [
			{
				start_offset: 0,
				speaker_id: 1,
				transcript: "My own long block that should never be offered for tagging at all.",
			},
			{
				start_offset: 160_000,
				speaker_id: 2,
				transcript: "Short.",
			},
			{
				start_offset: 1_040_000,
				speaker_id: 2,
				transcript: "A medium sized block of text.",
			},
			{
				start_offset: 9_600_000,
				speaker_id: 2,
				transcript: "The longest block of text from the other speaker in this meeting.",
			},
			{
				start_offset: 59_600_000,
				speaker_id: null,
				transcript: "An undiarized block nobody was assigned to.",
			},
		],
	},
};

test("speaker-blocks lists each non-self speaker's longest blocks in time order, skipping the user's own speaker", () =>
{
	const sb = sandbox(SPEECH);
	const {status, stdout, stderr} = speakerBlocks(sb, "abc123", "2");
	assert.equal(status, 0, stderr);
	assert.deepEqual(
		JSON.parse(stdout),
		{
			otid: "abc123",
			title: "1:1 Alice",
			url: "https://otter.ai/u/abc123",
			speakers: [
				{
					speaker_id: 2,
					label: "Speaker 2",
					blocks: [
						{
							time: "01:05",
							chars: 29,
							text: "A medium sized block of text.",
						},
						{
							time: "10:00",
							chars: 65,
							text: "The longest block of text from the other speaker in this meeting.",
						},
					],
				},
				{
					speaker_id: null,
					label: "unattributed",
					blocks: [
						{
							time: "62:05",
							chars: 43,
							text: "An undiarized block nobody was assigned to.",
						},
					],
				},
			],
		},
	);
});

test("speaker-blocks defaults to two blocks per speaker and truncates long text to a findable preview", () =>
{
	const long = "x".repeat(150);
	const sb = sandbox(
		{
			speech:
			{
				otid: "def456",
				title: "Sync",
				start_time: 1_790_000_000,
				speakers: [
					{
						id: 3,
						speaker_name: "Alice",
						self_speaker: false,
					},
				],
				transcripts: [
					{
						start_offset: 0,
						speaker_id: 3,
						transcript: "aaaa",
					},
					{
						start_offset: 16_000,
						speaker_id: 3,
						transcript: "bbbbbb",
					},
					{
						start_offset: 32_000,
						speaker_id: 3,
						transcript: long,
					},
					{
						start_offset: 48_000,
						speaker_id: 3,
						transcript: "cccccccc",
					},
				],
			},
		},
	);
	const {status, stdout, stderr} = speakerBlocks(sb, "def456");
	assert.equal(status, 0, stderr);
	assert.deepEqual(
		JSON.parse(stdout),
		{
			otid: "def456",
			title: "Sync",
			url: "https://otter.ai/u/def456",
			speakers: [
				{
					speaker_id: 3,
					label: "Alice",
					blocks: [
						{
							time: "00:02",
							chars: 150,
							text: `${"x".repeat(120)}...`,
						},
						{
							time: "00:03",
							chars: 8,
							text: "cccccccc",
						},
					],
				},
			],
		},
	);
});

test("speaker-blocks requires an otid", () =>
{
	const sb = sandbox(SPEECH);
	const {status, stderr} = speakerBlocks(sb);
	assert.equal(status, 1);
	assert.equal(stderr, '{"error": "speaker-blocks command requires otid argument"}\n');
});

test("speaker-blocks fails clearly when Otter returns no speech for the otid", () =>
{
	const sb = sandbox(
		{
			status: "error",
			speech: null,
		},
	);
	const {status, stdout, stderr} = speakerBlocks(sb, "gone123");
	assert.equal(status, 1);
	assert.equal(stdout, "");
	assert.equal(stderr, '{"error": "no speech found for otid gone123"}\n');
});
