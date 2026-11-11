#!/usr/bin/env node
// Find build directories that Time Machine still backs up.
//
// `find ~/projects` exits non-zero when a directory disappears between being listed and being
// opened -- a `.git/rebase-merge` dir finishing its rebase is enough. That is not a failed scan:
// a directory that no longer exists has no build output to exclude. The walk prunes it and keeps
// going, so one transient entry never forces a second sweep of the whole tree. Anything else
// (permission denied, a missing root, a tmutil crash) is a real failure and exits non-zero.
//
// Usage: scan-build-dirs.mts [root]    (default: ~/projects)
// Prints NUL-delimited unexcluded, untracked paths on stdout, ready for group-build-dirs.mts.
// Vanished directories are listed on stderr for the record.

import {execFileSync} from "node:child_process";
import type {Dirent} from "node:fs";
import {existsSync, readdirSync} from "node:fs";
import {homedir} from "node:os";
import {join} from "node:path";
import {isMain} from "./is-main.mts";

const BUILD_DIR_NAMES = new Set(["node_modules", "target", "build", "dist"]);
const VANISHED_CODES = new Set(["ENOENT", "ENOTDIR"]);
const TMUTIL_BATCH_SIZE = 200;

const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

type ReadDir = (directory: string, options: {withFileTypes: true}) => Dirent[];

export interface WalkResult {
	dirs: string[];
	vanished: string[];
}

function isVanishedError(error: unknown): boolean {
	return (
		error instanceof Error && "code" in error && typeof error.code === "string" && VANISHED_CODES.has(error.code)
	);
}

const readDirents: ReadDir = (directory, options) => readdirSync(directory, options);

export function walkBuildDirs(root: string, {readdir = readDirents}: {readdir?: ReadDir} = {}): WalkResult {
	const dirs: string[] = [];
	const vanished: string[] = [];
	const pending = [root];
	for (let directory = pending.pop(); directory !== undefined; directory = pending.pop()) {
		let entries: Dirent[];
		try {
			entries = readdir(directory, {withFileTypes: true});
		} catch (error) {
			if (directory !== root && isVanishedError(error)) {
				vanished.push(directory);
				continue;
			}
			throw error;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) {
				continue;
			}
			const path = join(directory, entry.name);
			if (BUILD_DIR_NAMES.has(entry.name)) {
				dirs.push(path);
			} else {
				pending.push(path);
			}
		}
	}
	return {dirs: dirs.toSorted(byPath), vanished: vanished.toSorted(byPath)};
}

function runTmutilIsExcluded(paths: string[]): string {
	return execFileSync("tmutil", ["isexcluded", ...paths], {encoding: "utf8", maxBuffer: 64 * 1024 * 1024});
}

interface ClassifyOptions {
	runTmutil?: (paths: string[]) => string;
	exists?: (path: string) => boolean;
	batchSize?: number;
}

export function classifyExclusions(
	paths: string[],
	{runTmutil = runTmutilIsExcluded, exists = existsSync, batchSize = TMUTIL_BATCH_SIZE}: ClassifyOptions = {},
): {unexcluded: string[]; vanished: string[]} {
	const unexcluded: string[] = [];
	const vanished: string[] = [];
	for (let start = 0; start < paths.length; start += batchSize) {
		const batch = paths.slice(start, start + batchSize);
		const lines = runTmutil(batch)
			.split("\n")
			.filter((line) => line !== "");
		if (lines.length !== batch.length) {
			throw new Error(`tmutil returned ${lines.length} lines for ${batch.length} paths`);
		}
		// tmutil prints one status line per argument, in argument order.
		for (const [index, path] of batch.entries()) {
			const line = lines[index];
			if (line === undefined) {
				throw new Error(`tmutil returned no line for ${path}`);
			}
			if (line.startsWith("[Excluded]")) {
				continue;
			}
			if (line.startsWith("[Included]")) {
				unexcluded.push(path);
			} else if (exists(path)) {
				throw new Error(`tmutil could not classify ${path}: ${line}`);
			} else {
				vanished.push(path);
			}
		}
	}
	return {unexcluded, vanished};
}

function gitTrackedFiles(path: string): string {
	try {
		return execFileSync("git", ["-C", path, "ls-files", "--", "."], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		// Not inside a git work tree, so nothing here is tracked.
		return "";
	}
}

// A directory named like build output can be checked-in source (a plugin named `build`).
// Excluding it would drop real source from backups, so any directory with tracked files stays.
export function dropTrackedSource(
	paths: string[],
	{trackedFiles = gitTrackedFiles}: {trackedFiles?: (path: string) => string} = {},
): string[] {
	return paths.filter((path) => trackedFiles(path) === "");
}

function main(): void {
	const root = process.argv[2] ?? join(homedir(), "projects");
	const walked = walkBuildDirs(root);
	const classified = classifyExclusions(walked.dirs);
	for (const path of [...walked.vanished, ...classified.vanished]) {
		process.stderr.write(`vanished mid-scan, skipped: ${path}\n`);
	}
	process.stdout.write(
		dropTrackedSource(classified.unexcluded)
			.map((path) => `${path}\0`)
			.join(""),
	);
}

if (isMain(import.meta.url)) {
	main();
}
