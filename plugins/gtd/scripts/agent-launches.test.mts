// Run: node --test plugins/gtd/scripts/agent-launches.test.mts
/* eslint-disable @typescript-eslint/no-floating-promises -- node:test test() calls are fire-and-forget by design */
import {test} from "node:test";
import assert from "node:assert/strict";
import {existsSync, mkdtempSync, writeFileSync, mkdirSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {acknowledgeLaunch, alreadyLaunched, pendingReports, recordLaunch, reportPath} from "./agent-launches.mts";
import type {Launch} from "./agent-launches.mts";

const launch: Launch =
{
	slug: "sync-forks",
	pane: "w1-p2",
	cwd: "/work/forks",
	launchedAt: "2026-10-25T08:00:00.000Z",
	reportPath: ".llm/gtd/review/agent-reports/sync-forks-2026-10-25.md",
};

test("reportPath names the report by slug and local date", () =>
{
	assert.equal(reportPath("sync-forks", "2026-10-25"), ".llm/gtd/review/agent-reports/sync-forks-2026-10-25.md");
});

test("recordLaunch appends a launch and stays immutable", () =>
{
	const ledger =
	{
		launches: [],
	};
	assert.deepStrictEqual(
		recordLaunch(ledger, launch),
		{
			launches: [launch],
		},
	);
	assert.deepStrictEqual(
		ledger,
		{
			launches: [],
		},
	);
});

test("alreadyLaunched matches slug within the same cycle date only", () =>
{
	const ledger =
	{
		launches: [launch],
	};
	assert.equal(alreadyLaunched(ledger, "sync-forks", "2026-10-25"), true);
	assert.equal(alreadyLaunched(ledger, "sync-forks", "2026-10-26"), false);
	assert.equal(alreadyLaunched(ledger, "pull-requests", "2026-10-25"), false);
});

test("pendingReports splits launches by whether the report file exists", () =>
{
	const dir = mkdtempSync(join(tmpdir(), "ledger-"));
	mkdirSync(join(dir, "r"));
	writeFileSync(join(dir, "r", "done.md"), "report");
	const done =
	{
		...launch,
		slug: "done",
		reportPath: "r/done.md",
	};
	const waiting =
	{
		...launch,
		slug: "waiting",
		reportPath: "r/waiting.md",
	};
	assert.equal(existsSync(join(dir, "r", "done.md")), true);
	const acked =
	{
		...done,
		slug: "acked",
		ackedAt: "2026-10-25T20:00:00.000Z",
	};
	assert.deepStrictEqual(
		pendingReports(
			{
				launches: [done, waiting, acked],
			},
			dir,
		),
		{
			ready: [done],
			missing: [waiting],
		},
	);
});

test("acknowledgeLaunch stamps only the launch matching slug and launchedAt", () =>
{
	const later =
	{
		...launch,
		launchedAt: "2026-10-26T08:00:00.000Z",
		reportPath: ".llm/gtd/review/agent-reports/sync-forks-2026-10-26.md",
	};
	const ledger =
	{
		launches: [launch, later],
	};
	assert.deepStrictEqual(
		acknowledgeLaunch(ledger, "sync-forks", "2026-10-25T08:00:00.000Z", "2026-10-26T09:00:00.000Z"),
		{
			launches: [
				{
					...launch,
					ackedAt: "2026-10-26T09:00:00.000Z",
				},
				later,
			],
		},
	);
	assert.deepStrictEqual(
		ledger,
		{
			launches: [launch, later],
		},
	);
	assert.throws(
		() => acknowledgeLaunch(ledger, "sync-forks", "2026-10-27T08:00:00.000Z", "2026-10-27T09:00:00.000Z"),
		{
			message: "no launch sync-forks at 2026-10-27T08:00:00.000Z",
		},
	);
});
