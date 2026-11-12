#!/usr/bin/env node
// Group unexcluded build directories for the Time Machine exclusions report.
//
// A repo's `.worktrees/` directory can hold hundreds of Maven `target/` dirs, one per module per
// worktree. Listing each one buries the handful of durable-checkout paths that matter. Build output
// inside a worktree is still regenerable and still gets excluded; only the presentation changes:
// every path under `<repo>/.worktrees/<worktree>/` or `<repo>/.claude/worktrees/<worktree>/` collapses into one line per repo. Scratch checkouts
// at `<repo>/.llm/conflicts-*/` and `<repo>/.llm/pr-*-repair/`, and Yarn PnP packages at
// `<repo>/.yarn/unplugged/<package>/`, collapse the same way, each kind into its own line per repo.
//
// Never exclude the `.worktrees` root itself. Worktrees share one Git object database, and a
// worktree with uncommitted changes is exactly the source that needs backing up.
//
// Usage:
//   find ... -print0 | node group-build-dirs.mts
//
// Reads NUL- or newline-delimited paths from stdin and prints JSON:
//   {"durable": [...], "worktrees": [{repo, worktreeCount, dirCount}],
//    "conflicts": [{repo, checkoutCount, dirCount}], "repairs": [{repo, checkoutCount, dirCount}],
//    "unplugged": [{repo, packageCount, dirCount}], "report": [...]}

import {readFileSync} from "node:fs";
import {isMain} from "./is-main.mts";

const PR_REPAIR = /^pr-.+-repair$/u;

const KIND_NAMES = ["worktrees", "conflicts", "repairs", "unplugged"] as const;
type KindName = (typeof KIND_NAMES)[number];
type CountKey = "worktreeCount" | "checkoutCount" | "packageCount";

interface Kind
{
	markers: string[][];
	matches: (name: string) => boolean;
	countKey: CountKey;
	noun: string;
	under: string;
}

export type GroupEntry =
{
	repo: string;
	dirCount: number;
} & Partial<Record<CountKey, number>>;
export type GroupedBuildDirs =
{
	durable: string[];
} & Record<KindName, GroupEntry[]>;
type RepoTally = Map<
	string,
	{
		names: Set<string>;
		dirCount: number;
	}
>;

/**
 * Each kind of collapsible location: the segments that mark it under the repo, a test for the
 * segment naming one checkout or package, the count key, and how a report line describes it.
 */
const KINDS: Record<KindName, Kind> =
{
	worktrees:
	{
		markers: [[".worktrees"], [".claude", "worktrees"]],
		matches: () => true,
		countKey: "worktreeCount",
		noun: "worktree",
		under: "",
	},
	conflicts:
	{
		markers: [[".llm"]],
		matches: (name) => name.startsWith("conflicts-"),
		countKey: "checkoutCount",
		noun: "conflicts checkout",
		under: "/.llm",
	},
	repairs:
	{
		markers: [[".llm"]],
		matches: (name) => PR_REPAIR.test(name),
		countKey: "checkoutCount",
		noun: "PR repair checkout",
		under: "/.llm",
	},
	unplugged:
	{
		markers: [[".yarn", "unplugged"]],
		matches: () => true,
		countKey: "packageCount",
		noun: "unplugged package",
		under: "/.yarn/unplugged",
	},
};

/** The kind whose marker and name match `segments` at `index`, or null. */
function kindAt(
	segments: string[],
	index: number,
):
{
	kind: KindName;
	name: string;
} | null
{
	for (const kind of KIND_NAMES)
	{
		const {markers, matches} = KINDS[kind];
		for (const marker of markers)
		{
			const nameIndex = index + marker.length;
			// The last segment is the build dir itself, so a location needs a named segment before it.
			if (nameIndex >= segments.length - 1)
			{
				continue;
			}
			if (!marker.every((segment, offset) => segments[index + offset] === segment))
			{
				continue;
			}
			const name = segments[nameIndex];
			if (name !== undefined && matches(name))
			{
				return {
					kind,
					name,
				};
			}
		}
	}
	return null;
}

/** The outermost collapsible location containing `path` as `{kind, repo, name}`, or null for a durable path. */
function locationOf(path: string):
{
	kind: KindName;
	name: string;
	repo: string;
} | null
{
	const segments = path.split("/");
	for (let index = 0; index < segments.length; index += 1)
	{
		const match = kindAt(segments, index);
		if (match !== null)
		{
			return {
				...match,
				repo: segments.slice(0, index).join("/"),
			};
		}
	}
	return null;
}

function countEntry(countKey: CountKey, count: number): Partial<Record<CountKey, number>>
{
	return {
		[countKey]: count,
	};
}

function aggregate(byRepo: RepoTally, countKey: CountKey): GroupEntry[]
{
	return [...byRepo.entries()]
		.map(([repo, {names, dirCount}]) => (
		{
			repo,
			...countEntry(countKey, names.size),
			dirCount,
		}))
		.toSorted((a, b) => a.repo.localeCompare(b.repo));
}

export function groupBuildDirs(paths: string[]): GroupedBuildDirs
{
	const durable: string[] = [];
	const byKind: Record<KindName, RepoTally> =
	{
		worktrees: new Map(),
		conflicts: new Map(),
		repairs: new Map(),
		unplugged: new Map(),
	};

	for (const path of paths)
	{
		const location = locationOf(path);
		if (!location)
		{
			durable.push(path);
			continue;
		}
		const byRepo = byKind[location.kind];
		const entry = byRepo.get(location.repo) ??
		{
			names: new Set<string>(),
			dirCount: 0,
		};
		entry.names.add(location.name);
		entry.dirCount += 1;
		byRepo.set(location.repo, entry);
	}

	return {
		durable,
		worktrees: aggregate(byKind.worktrees, KINDS.worktrees.countKey),
		conflicts: aggregate(byKind.conflicts, KINDS.conflicts.countKey),
		repairs: aggregate(byKind.repairs, KINDS.repairs.countKey),
		unplugged: aggregate(byKind.unplugged, KINDS.unplugged.countKey),
	};
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

export function formatBuildDirReport(grouped: GroupedBuildDirs): string[]
{
	return [
		...grouped.durable,
		...KIND_NAMES.flatMap((kind) =>
		{
			const {countKey, noun, under} = KINDS[kind];
			return grouped[kind].map(
				(entry) =>
					`${plural(entry.dirCount, "build dir")} across ${plural(entry[countKey] ?? 0, noun)} under ${entry.repo}${under}`,
			);
		}),
	];
}

export function parsePathList(text: string): string[]
{
	return text
		.split("\0")
		.flatMap((chunk) => chunk.split("\n"))
		.filter((line) => line.length > 0);
}

function main(): void
{
	const grouped = groupBuildDirs(parsePathList(readFileSync(0, "utf8")));
	process.stdout.write(
		`${JSON.stringify(
			{
				...grouped,
				report: formatBuildDirReport(grouped),
			},
			null,
			"\t",
		)}\n`,
	);
}

if (isMain(import.meta.url))
{
	main();
}
