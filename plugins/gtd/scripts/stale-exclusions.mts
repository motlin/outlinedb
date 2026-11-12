#!/usr/bin/env node
// Find fixed-path Time Machine exclusions whose directory no longer exists.
//
// `tmutil addexclusion -p` records each path in the SkipPaths list of the system Time Machine
// preferences. Nothing removes an entry when its directory is deleted, so the list only grows.
// This prints the NUL-delimited stale entries under a root, ready for
// `sudo xargs -0 tmutil removeexclusion -p`.
//
// Usage: stale-exclusions.mts [root]    (default: ~/projects)

import {execFileSync} from "node:child_process";
import {existsSync} from "node:fs";
import {homedir} from "node:os";
import {join} from "node:path";
import {isMain} from "./is-main.mts";

const PREFERENCES = "/Library/Preferences/com.apple.TimeMachine";

const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// `defaults read` prints a property-list array: "(", one entry per line (quoted when it holds
// spaces), then ")". A missing key prints nothing useful, which parses as an empty list.
export function parseSkipPaths(output: string): string[]
{
	const paths: string[] = [];
	for (const line of output.split("\n"))
	{
		const entry = line.trim().replace(/,$/u, "");
		if (entry === "" || entry === "(" || entry === ")")
		{
			continue;
		}
		paths.push(entry.startsWith('"') && entry.endsWith('"') ? entry.slice(1, -1) : entry);
	}
	return paths;
}

export function selectStalePaths(
	skipPaths: string[],
	root: string,
	exists: (path: string) => boolean = existsSync,
): string[]
{
	const prefix = root.endsWith("/") ? root : `${root}/`;
	return skipPaths.filter((path) => path.startsWith(prefix) && !exists(path)).toSorted(byPath);
}

function readSkipPaths(): string[]
{
	try
	{
		return parseSkipPaths(
			execFileSync(
				"defaults",
				["read", PREFERENCES, "SkipPaths"],
				{
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
				},
			),
		);
	}
	catch
	{
		// No SkipPaths key yet: nothing has ever been excluded by path.
		return [];
	}
}

function main(): void
{
	const root = process.argv[2] ?? join(homedir(), "projects");
	process.stdout.write(
		selectStalePaths(readSkipPaths(), root)
			.map((path) => `${path}\0`)
			.join(""),
	);
}

if (isMain(import.meta.url))
{
	main();
}
