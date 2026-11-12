// Run: node --test plugins/gtd/scripts/otter-api-sync-since.test.mts
/* eslint-disable @typescript-eslint/no-floating-promises -- node:test test() calls are fire-and-forget by design */
import {test} from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {arrayField, expectObject, parseJson, stringField} from "./json.mts";
import {at} from "./test-helpers.mts";

const SCRIPT = fileURLToPath(new URL("otter-api.sh", import.meta.url));

interface Sandbox
{
	cache: string;
	bin: string;
	calls: string;
}

interface SyncResult
{
	status: number | null;
	stdout: string;
	stderr: string;
	urls: string[];
}

const speech = (otid: string, startTime: number, summary: string | null = `summary ${otid}`) => (
{
	otid,
	title: `Meeting ${otid}`,
	start_time: startTime,
	duration: 60,
	short_abstract_summary: summary,
	action_item_count: null,
	speech_outline: [
		{
			text: `Section ${otid}`,
			segments: [
				{
					text: `segment ${otid}`,
				},
			],
		},
	],
});

/**
 * Sandbox with a fake `curl` that serves Otter fixtures and logs every URL.
 * `pages` maps a cursor ("first" for no cursor) to an available_speeches body.
 */
function sandbox(pages: Record<string, unknown>): Sandbox
{
	const dir = mkdtempSync(join(tmpdir(), "otter-sync-since-"));
	const bin = join(dir, "bin");
	const cache = join(dir, "cache");
	const fixtures = join(dir, "fixtures");
	const calls = join(dir, "curl-calls.log");
	for (const d of [bin, cache, fixtures])
	{
		mkdirSync(d);
	}
	writeFileSync(join(cache, "otter-session-cache"), "");
	writeFileSync(join(cache, "otter-userid-cache"), "42");
	for (const [cursor, body] of Object.entries(pages))
	{
		writeFileSync(join(fixtures, `page-${cursor}.json`), JSON.stringify(body));
	}
	const fakeCurl = join(bin, "curl");
	writeFileSync(
		fakeCurl,
		[
			"#!/bin/bash",
			'url=""; meta=""',
			'for a in "$@"; do',
			'  case "$a" in http*) url="$a" ;; esac',
			'  case "$a" in *http_code*) meta=1 ;; esac',
			"done",
			`echo "$url" >> ${JSON.stringify(calls)}`,
			'case "$url" in',
			"  *available_speeches*)",
			"    cursor=first",
			'    [[ "$url" =~ last_load_ts=([0-9]+) ]] && cursor="${BASH_REMATCH[1]}"',
			`    cat ${JSON.stringify(fixtures)}/page-$cursor.json ;;`,
			"  *speech_action_items*)",
			'    otid="${url##*otid=}"',
			'    printf \'{"speech_action_items":[{"text":"do %s","assignee":{"name":"Alice"},"completed":false}]}\' "$otid" ;;',
			"esac",
			String.raw`[[ -n "$meta" ]] && printf '\n{"http_code":"200","time_total":"0.01"}'`,
			"exit 0",
			"",
		].join("\n"),
	);
	chmodSync(fakeCurl, 0o755);
	return {
		cache,
		bin,
		calls,
	};
}

function syncSince(sb: Sandbox, ...args: string[]): SyncResult
{
	const result = spawnSync(
		"bash",
		[SCRIPT, "sync-since", ...args],
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
	const urls = existsSync(sb.calls) ? readFileSync(sb.calls, "utf8").trim().split("\n").filter(Boolean) : [];
	return {
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
		urls,
	};
}

const listCalls = (urls: string[]): string[] => urls.filter((u) => u.includes("available_speeches"));
const actionOtids = (urls: string[]): string[] =>
	urls.filter((u) => u.includes("speech_action_items")).map((u) => u.slice(u.indexOf("otid=") + 5));

/** The `speeches` array of a sync-since stdout payload. */
const outputSpeeches = (stdout: string): unknown[] =>
	arrayField(expectObject(parseJson(stdout), "sync-since output"), "speeches");
const outputOtids = (stdout: string): (string | undefined)[] =>
	outputSpeeches(stdout).map((s) => stringField(expectObject(s, "speech"), "otid"));

const expectedSpeech = (otid: string, startTime: number) => (
{
	otid,
	title: `Meeting ${otid}`,
	start_time: startTime,
	duration: 60,
	summary: `summary ${otid}`,
	outline: [
		{
			title: `Section ${otid}`,
			segments: [`segment ${otid}`],
		},
	],
	action_items: [
		{
			text: `do ${otid}`,
			assignee: "Alice",
			completed: false,
		},
	],
});

test("sync-since returns only meetings newer than the boundary and fetches action items only for them", () =>
{
	const sb = sandbox(
		{
			first:
			{
				last_load_ts: 900,
				end_of_list: false,
				speeches: [speech("new2", 1200), speech("new1", 1100), speech("seen", 1000), speech("old", 950)],
			},
		},
	);
	const {status, stdout, urls} = syncSince(sb, "seen");
	assert.equal(status, 0);
	assert.deepStrictEqual(
		JSON.parse(stdout),
		{
			boundary_found: true,
			end_of_list: false,
			speeches: [expectedSpeech("new2", 1200), expectedSpeech("new1", 1100)],
		},
	);
	assert.deepStrictEqual(actionOtids(urls), ["new2", "new1"]);
	assert.equal(listCalls(urls).length, 1);
	assert.ok(
		at(listCalls(urls), 0).includes("page_size=10"),
		`default page size should be small: ${at(listCalls(urls), 0)}`,
	);
});

test("sync-since pages with the cursor until it reaches the boundary", () =>
{
	const sb = sandbox(
		{
			first:
			{
				last_load_ts: 1100,
				end_of_list: false,
				speeches: [speech("new3", 1300), speech("new2", 1200)],
			},
			1100:
			{
				last_load_ts: 900,
				end_of_list: false,
				speeches: [speech("new1", 1100), speech("seen", 1000)],
			},
		},
	);
	const {status, stdout, urls} = syncSince(sb, "seen", "2");
	assert.equal(status, 0);
	assert.deepStrictEqual(outputOtids(stdout), ["new3", "new2", "new1"]);
	assert.equal(listCalls(urls).length, 2);
	assert.ok(at(listCalls(urls), 1).includes("last_load_ts=1100"), at(listCalls(urls), 1));
	assert.ok(at(listCalls(urls), 1).includes("modified_after="), at(listCalls(urls), 1));
	assert.deepStrictEqual(actionOtids(urls), ["new3", "new2", "new1"]);
});

test("sync-since drops meetings a later page repeats, as the live API does with a cursor", () =>
{
	const sb = sandbox(
		{
			first:
			{
				last_load_ts: 1100,
				end_of_list: false,
				speeches: [speech("new3", 1300), speech("new2", 1200)],
			},
			1100:
			{
				last_load_ts: 900,
				end_of_list: false,
				speeches: [speech("new3", 1300), speech("new2", 1200), speech("new1", 1100), speech("seen", 1000)],
			},
		},
	);
	const {status, stdout, urls} = syncSince(sb, "seen", "2");
	assert.equal(status, 0);
	assert.deepStrictEqual(outputOtids(stdout), ["new3", "new2", "new1"]);
	assert.deepStrictEqual(actionOtids(urls), ["new3", "new2", "new1"]);
});

test("sync-since skips the action-items call for meetings Otter is still processing", () =>
{
	const sb = sandbox(
		{
			first:
			{
				last_load_ts: 900,
				end_of_list: false,
				speeches: [
					{
						...speech("pending", 1200, null),
						speech_outline: null,
					},
					speech("new1", 1100),
					speech("seen", 1000),
				],
			},
		},
	);
	const {status, stdout, urls} = syncSince(sb, "seen");
	assert.equal(status, 0);
	assert.deepStrictEqual(
		outputSpeeches(stdout)[0],
		{
			otid: "pending",
			title: "Meeting pending",
			start_time: 1200,
			duration: 60,
			summary: null,
			outline: [],
			action_items: [],
		},
	);
	assert.deepStrictEqual(actionOtids(urls), ["new1"]);
});

test("sync-since returns everything with boundary_found false when the list ends first", () =>
{
	const sb = sandbox(
		{
			first:
			{
				last_load_ts: 900,
				end_of_list: true,
				speeches: [speech("new1", 1100)],
			},
		},
	);
	const {status, stdout} = syncSince(sb, "missing");
	assert.equal(status, 0);
	assert.deepStrictEqual(
		JSON.parse(stdout),
		{
			boundary_found: false,
			end_of_list: true,
			speeches: [expectedSpeech("new1", 1100)],
		},
	);
});

test("sync-since fails instead of scanning unbounded when the boundary is never found", () =>
{
	const pages =
	{
		first:
		{
			last_load_ts: 1,
			end_of_list: false,
			speeches: [speech("a", 1100)],
		},
		1:
		{
			last_load_ts: 1,
			end_of_list: false,
			speeches: [speech("b", 1000)],
		},
	};
	const sb = sandbox(pages);
	const result = spawnSync(
		"bash",
		[SCRIPT, "sync-since", "missing", "1"],
		{
			env:
			{
				...process.env,
				PATH: `${sb.bin}:${process.env.PATH}`,
				OTTER_CACHE_DIR: sb.cache,
				OTTER_MAX_PAGES: "3",
			},
			encoding: "utf8",
		},
	);
	assert.notEqual(result.status, 0);
	assert.equal(result.stdout, "");
	assert.match(result.stderr, /missing.*not found within 3 pages/u);
	const urls = readFileSync(sb.calls, "utf8").trim().split("\n");
	assert.equal(listCalls(urls).length, 3);
	assert.deepStrictEqual(actionOtids(urls), []);
});

test("sync-since requires the boundary otid", () =>
{
	const sb = sandbox({});
	const {status, stderr, urls} = syncSince(sb);
	assert.notEqual(status, 0);
	assert.match(stderr, /sync-since requires/u);
	assert.deepStrictEqual(urls, []);
});

test("sync-since drops trashed meetings that a modified_after page returns with deleted: true", () =>
{
	const sb = sandbox(
		{
			first:
			{
				last_load_ts: 1100,
				end_of_list: false,
				speeches: [speech("new2", 1200)],
			},
			1100:
			{
				last_load_ts: 900,
				end_of_list: false,
				speeches: [
					{
						...speech("trashed", 1150, null),
						deleted: true,
					},
					speech("new1", 1100),
					speech("seen", 1000),
				],
			},
		},
	);
	const {status, stdout, urls} = syncSince(sb, "seen", "1");
	assert.equal(status, 0);
	assert.deepStrictEqual(
		{
			otids: outputOtids(stdout),
			actions: actionOtids(urls),
		},
		{
			otids: ["new2", "new1"],
			actions: ["new2", "new1"],
		},
	);
});

test("sync-since fetches action items for a meeting Otter outlined but gave no abstract", () =>
{
	const sb = sandbox(
		{
			first:
			{
				last_load_ts: 900,
				end_of_list: false,
				speeches: [
					speech("outlined", 1200, null),
					{
						...speech("pending", 1150, null),
						speech_outline: null,
					},
					speech("seen", 1000),
				],
			},
		},
	);
	const {status, urls} = syncSince(sb, "seen");
	assert.equal(status, 0);
	assert.deepStrictEqual(actionOtids(urls), ["outlined"]);
});
