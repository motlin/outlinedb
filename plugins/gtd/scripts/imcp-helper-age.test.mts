// Run: node --test plugins/gtd/scripts/imcp-helper-age.test.mts
/* eslint-disable @typescript-eslint/no-floating-promises -- node:test test() calls are fire-and-forget by design */
import {test} from "node:test";
import assert from "node:assert/strict";
import
{
	STALE_THRESHOLD_SECONDS,
	ageSeconds,
	findSessionHelperPid,
	parseLstartToEpochSeconds,
	parsePsTable,
} from "./imcp-helper-age.mts";

test("parseLstartToEpochSeconds parses the BSD ps lstart format", () =>
{
	const expected = Math.floor(new Date(2026, 5, 27, 14, 2, 14).getTime() / 1000);
	assert.strictEqual(parseLstartToEpochSeconds("Sat Jun 27 14:02:14 2026"), expected);
});

test("parseLstartToEpochSeconds tolerates trailing whitespace from ps -o lstart=", () =>
{
	const expected = Math.floor(new Date(2026, 5, 27, 14, 2, 14).getTime() / 1000);
	assert.strictEqual(parseLstartToEpochSeconds("Sat Jun 27 14:02:14 2026    "), expected);
});

test("parseLstartToEpochSeconds returns null on garbage input", () =>
{
	assert.strictEqual(parseLstartToEpochSeconds("not a date"), null);
	assert.strictEqual(parseLstartToEpochSeconds(""), null);
});

test("ageSeconds returns the difference from a known now", () =>
{
	const start = Math.floor(new Date(2026, 5, 27, 14, 2, 14).getTime() / 1000);
	assert.strictEqual(ageSeconds("Sat Jun 27 14:02:14 2026", start + 760), 760);
});

test("ageSeconds returns null when lstart is unparseable", () =>
{
	assert.strictEqual(ageSeconds("not a date", 1_000_000), null);
});

test("STALE_THRESHOLD_SECONDS is one day, matching the skill doc", () =>
{
	assert.strictEqual(STALE_THRESHOLD_SECONDS, 86_400);
});

const SERVER = "/Applications/iMCP.app/Contents/MacOS/imcp-server";

test("parsePsTable parses pid, ppid, and command columns", () =>
{
	const out = `    1     0 /sbin/launchd\n  4435  4273 ${SERVER}\n 27342 27262 /bin/zsh -c echo hi  \n`;
	assert.deepStrictEqual(parsePsTable(out), [
		{
			pid: 1,
			ppid: 0,
			command: "/sbin/launchd",
		},
		{
			pid: 4435,
			ppid: 4273,
			command: SERVER,
		},
		{
			pid: 27_342,
			ppid: 27_262,
			command: "/bin/zsh -c echo hi",
		},
	]);
});

test("findSessionHelperPid picks the helper parented by an ancestor of the start pid", () =>
{
	const processes = [
		{
			pid: 1,
			ppid: 0,
			command: "/sbin/launchd",
		},
		{
			pid: 100,
			ppid: 1,
			command: "claude",
		},
		{
			pid: 101,
			ppid: 100,
			command: SERVER,
		},
		{
			pid: 200,
			ppid: 1,
			command: "claude",
		},
		{
			pid: 201,
			ppid: 200,
			command: SERVER,
		},
		{
			pid: 202,
			ppid: 200,
			command: "/bin/zsh -c node imcp-helper-age.mts",
		},
		{
			pid: 203,
			ppid: 202,
			command: "node imcp-helper-age.mts",
		},
	];
	assert.strictEqual(findSessionHelperPid(processes, 203), 201);
});

test("findSessionHelperPid returns null when no ancestor owns a helper", () =>
{
	const processes = [
		{
			pid: 1,
			ppid: 0,
			command: "/sbin/launchd",
		},
		{
			pid: 100,
			ppid: 1,
			command: "claude",
		},
		{
			pid: 101,
			ppid: 100,
			command: SERVER,
		},
		{
			pid: 300,
			ppid: 1,
			command: "/bin/zsh",
		},
		{
			pid: 301,
			ppid: 300,
			command: "node imcp-helper-age.mts",
		},
	];
	assert.strictEqual(findSessionHelperPid(processes, 301), null);
});

test("findSessionHelperPid survives a ppid cycle in the process table", () =>
{
	const processes = [
		{
			pid: 10,
			ppid: 11,
			command: "a",
		},
		{
			pid: 11,
			ppid: 10,
			command: "b",
		},
	];
	assert.strictEqual(findSessionHelperPid(processes, 10), null);
});

test("findSessionHelperPid ignores processes that merely mention the helper path in their arguments", () =>
{
	const processes = [
		{
			pid: 100,
			ppid: 1,
			command: "claude",
		},
		{
			pid: 102,
			ppid: 100,
			command: `/bin/zsh -c grep ${SERVER}; node imcp-helper-age.mts`,
		},
		{
			pid: 101,
			ppid: 100,
			command: SERVER,
		},
		{
			pid: 103,
			ppid: 102,
			command: "node imcp-helper-age.mts",
		},
	];
	assert.strictEqual(findSessionHelperPid(processes, 103), 101);
});
