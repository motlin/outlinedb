#!/usr/bin/env node
// Find the linked git worktrees that hold unexcluded build directories, and remove them on request.
//
// Removing a fully-committed worktree deletes its build output, which beats excluding it from Time
// Machine: the directories stop existing instead of piling up. A linked worktree is any checkout
// whose `.git` is a file pointing into `<repo>/.git/worktrees/<name>`, whether it lives under
// `<repo>/.worktrees/` or in a peer directory such as `~/projects/<repo>-<branch>`. The main checkout
// (a `.git` directory) and submodules (a `.git` file pointing into `.git/modules/`) never qualify.
//
// Removal always runs `git worktree remove` without `--force`, so git itself refuses a worktree with
// modified or untracked files, or a locked one. The branch is kept.
//
// Usage:
//   node scan-build-dirs.mts | node find-removable-worktrees.mts
//     Reads NUL- or newline-delimited build-dir paths from stdin and prints JSON:
//     [{path, repo, branch, dirCount, clean, idle}] sorted by path. `idle` is false when any file in
//     the worktree or its `.git/worktrees/<name>` admin dir changed in the last hour, or a process has
//     it as its working directory.
//   node find-removable-worktrees.mts --remove <worktree>...
//     Prints JSON: [{path, removed, error?}].

import {execFileSync} from "node:child_process";
import {existsSync, lstatSync, readFileSync, statSync} from "node:fs";
import {dirname, join} from "node:path";
import {isMain} from "./is-main.mts";

const LINKED_GITDIR = /^gitdir: (.*\/\.git\/worktrees\/[^/]+)\s*$/u;
// A large checkout lists far more than execFileSync's 1 MiB default buffer.
const MAX_BUFFER = 256 * 1024 * 1024;

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		maxBuffer: MAX_BUFFER,
	}).trim();
}

/** The root of the linked worktree containing `path`, or null when the nearest checkout is not one. */
function linkedWorktreeRoot(path: string): string | null {
	for (let directory = dirname(path); directory !== dirname(directory); directory = dirname(directory)) {
		const dotGit = join(directory, ".git");
		if (!existsSync(dotGit)) {
			continue;
		}
		if (lstatSync(dotGit).isDirectory()) {
			return null;
		}
		return LINKED_GITDIR.test(readFileSync(dotGit, "utf8")) ? directory : null;
	}
	return null;
}

function mainRepoOf(worktree: string): string {
	return dirname(git(worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"));
}

export interface Worktree {
	path: string;
	repo: string;
	branch: string;
	dirCount: number;
	clean: boolean;
	idle: boolean;
}

export interface ActivityOptions {
	now: number;
	/** Working directories of running processes. */
	cwds: string[];
}

const IDLE_MS = 60 * 60 * 1000;

export interface RemovalResult {
	path: string;
	removed: boolean;
	error?: string;
}

function mtimeMs(path: string): number {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return 0;
	}
}

/** Newest mtime among the worktree's non-ignored files and everything in its git admin dir. */
function newestChange(worktree: string): number {
	const files = git(worktree, "ls-files", "-z", "--cached", "--others", "--exclude-standard")
		.split("\0")
		.filter((file) => file.length > 0)
		.map((file) => join(worktree, file));
	const adminDir = git(worktree, "rev-parse", "--absolute-git-dir");
	const adminFiles = execFileSync("find", [adminDir, "-type", "f"], {encoding: "utf8", maxBuffer: MAX_BUFFER})
		.split("\n")
		.filter((file) => file.length > 0);
	return Math.max(mtimeMs(join(worktree, ".git")), ...files.map(mtimeMs), ...adminFiles.map(mtimeMs));
}

function isIdle(worktree: string, {now, cwds}: ActivityOptions): boolean {
	const occupied = cwds.some((cwd) => cwd === worktree || cwd.startsWith(`${worktree}/`));
	return !occupied && now - newestChange(worktree) >= IDLE_MS;
}

/** Working directories of every running process, from lsof; empty when lsof is unavailable. */
function processCwds(): string[] {
	try {
		const out = execFileSync("lsof", ["-d", "cwd", "-Fn"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			maxBuffer: 64 * 1024 * 1024,
		});
		return out
			.split("\n")
			.filter((line) => line.startsWith("n/"))
			.map((line) => line.slice(1));
	} catch {
		return [];
	}
}

function describeWorktree(path: string, dirCount: number, activity: ActivityOptions): Worktree {
	return {
		path,
		repo: mainRepoOf(path),
		branch: git(path, "rev-parse", "--abbrev-ref", "HEAD"),
		dirCount,
		clean: git(path, "--no-optional-locks", "status", "--porcelain") === "",
		idle: isIdle(path, activity),
	};
}

export function findWorktrees(
	paths: string[],
	activity: ActivityOptions = {now: Date.now(), cwds: processCwds()},
): Worktree[] {
	const dirCounts = new Map<string, number>();
	for (const path of paths) {
		const root = linkedWorktreeRoot(path);
		if (root !== null) {
			dirCounts.set(root, (dirCounts.get(root) ?? 0) + 1);
		}
	}
	return [...dirCounts.keys()]
		.toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0))
		.map((root) => describeWorktree(root, dirCounts.get(root) ?? 0, activity));
}

/** The git failure text: its stderr when present, else the error message. */
function failureText(error: unknown): string {
	if (error instanceof Error) {
		const stderr =
			"stderr" in error && (typeof error.stderr === "string" || Buffer.isBuffer(error.stderr))
				? String(error.stderr)
				: "";
		return (stderr || error.message).trim();
	}
	return String(error).trim();
}

export function removeWorktrees(worktrees: string[]): RemovalResult[] {
	return worktrees.map((path): RemovalResult => {
		try {
			git(mainRepoOf(path), "worktree", "remove", path);
			return {path, removed: true};
		} catch (error) {
			return {path, removed: false, error: failureText(error)};
		}
	});
}

function parsePathList(text: string): string[] {
	return text
		.split("\0")
		.flatMap((chunk) => chunk.split("\n"))
		.filter((line) => line.length > 0);
}

function main(): void {
	const [flag, ...rest] = process.argv.slice(2);
	const result = flag === "--remove" ? removeWorktrees(rest) : findWorktrees(parsePathList(readFileSync(0, "utf8")));
	process.stdout.write(`${JSON.stringify(result, null, "\t")}\n`);
}

if (isMain(import.meta.url)) {
	main();
}
