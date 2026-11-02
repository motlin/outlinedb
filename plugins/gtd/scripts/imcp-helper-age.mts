#!/usr/bin/env node
// Report the running iMCP helper's age for the daily review's "iMCP self-heal
// preflight" (plugins/gtd/commands/review/daily/overview.md), which restarts
// iMCP only when it is genuinely stale.
//
// Only this session's helper counts: every Claude session spawns its own
// imcp-server, so `pgrep -f` matches dozens. The session's helper is the one
// whose parent is an ancestor of this process (the claude that ran the Bash).
//
// Prints one token to stdout:
//   none       this session has no iMCP helper (launch a fresh one)
//   unknown    a helper is running but its start time couldn't be parsed
//              (proceed; don't kill a live helper on a parse glitch)
//   <integer>  the helper's age in whole seconds
//
// Age comes from `ps -o lstart=`, not `ps -o etimes=`: etimes is GNU/procps-only,
// so on BSD/macOS it errors and the empty result reads as "not running" — which
// would needlessly kill a healthy helper.
//
// With --pid, prints this session's helper pid (or `none`) instead, so the
// restart recipe kills only that helper.

import {execSync} from "node:child_process";
import {isMain} from "./is-main.mts";

// ~1 day, mirrored in overview.md
export const STALE_THRESHOLD_SECONDS = 86_400;

const MONTHS: Record<string, number> =
{
	Jan: 0,
	Feb: 1,
	Mar: 2,
	Apr: 3,
	May: 4,
	Jun: 5,
	Jul: 6,
	Aug: 7,
	Sep: 8,
	Oct: 9,
	Nov: 10,
	Dec: 11,
};

// `ps -o lstart=` renders e.g. "Sat Jun 27 14:02:14 2026", sometimes with trailing
// spaces. Parse it to epoch seconds in local time, matching how ps prints it.
const LSTART_RE = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/u;

export function parseLstartToEpochSeconds(lstart: string): number | null
{
	const m = lstart.trim().match(LSTART_RE);
	if (!m)
	{
		return null;
	}
	const month = MONTHS[m[1] ?? ""];
	if (month === undefined)
	{
		return null;
	}
	const [day, hh, mm, ss, year] = m.slice(2);
	return Math.floor(new Date(Number(year), month, Number(day), Number(hh), Number(mm), Number(ss)).getTime() / 1000);
}

export function ageSeconds(lstart: string, nowEpochSeconds: number): number | null
{
	const start = parseLstartToEpochSeconds(lstart);
	return start === null ? null : nowEpochSeconds - start;
}

const HELPER_COMMAND = "iMCP.app/Contents/MacOS/imcp-server";

// Parse `ps -A -o pid=,ppid=,command=` output.
export interface PsProcess
{
	pid: number;
	ppid: number;
	command: string;
}

export function parsePsTable(output: string): PsProcess[]
{
	const processes: PsProcess[] = [];
	for (const line of output.split("\n"))
	{
		const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/u);
		if (m)
		{
			processes.push(
				{
					pid: Number(m[1]),
					ppid: Number(m[2]),
					command: (m[3] ?? "").trim(),
				},
			);
		}
	}
	return processes;
}

// Return the pid of the iMCP helper whose parent is startPid or one of its
// ancestors, preferring the nearest ancestor; null when there is none.
export function findSessionHelperPid(processes: readonly PsProcess[], startPid: number): number | null
{
	const parentOf = new Map(processes.map((p) => [p.pid, p.ppid]));
	const helpers = processes.filter((p) => (p.command.split(/\s+/u)[0] ?? "").endsWith(HELPER_COMMAND));
	const seen = new Set<number>();
	for (let pid = startPid; pid > 0 && !seen.has(pid); pid = parentOf.get(pid) ?? 0)
	{
		seen.add(pid);
		const helper = helpers.find((p) => p.ppid === pid);
		if (helper)
		{
			return helper.pid;
		}
	}
	return null;
}

function main(): void
{
	const processes = parsePsTable(
		execSync(
			"ps -A -o pid=,ppid=,command=",
			{
				encoding: "utf8",
			},
		),
	);
	const pid = findSessionHelperPid(processes, process.pid);
	if (process.argv.includes("--pid"))
	{
		process.stdout.write(`${pid ?? "none"}\n`);
		return;
	}
	if (pid === null)
	{
		process.stdout.write("none\n");
		return;
	}

	let lstart: string;
	try
	{
		lstart = execSync(
			`ps -o lstart= -p ${pid}`,
			{
				encoding: "utf8",
			},
		).trim();
	}
	catch
	{
		process.stdout.write("unknown\n");
		return;
	}

	const age = ageSeconds(lstart, Math.floor(Date.now() / 1000));
	process.stdout.write(age === null ? "unknown\n" : `${age}\n`);
}

if (isMain(import.meta.url))
{
	main();
}
