// Run: node --test plugins/gtd/scripts/find-removable-worktrees.test.mts
/* eslint-disable @typescript-eslint/no-floating-promises -- node:test test() calls are fire-and-forget by design */
import {test} from "node:test";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {findWorktrees, removeWorktrees} from "./find-removable-worktrees.mts";
import {at} from "./test-helpers.mts";

function git(cwd: string, ...args: string[]): string
{
	return execFileSync(
		"git",
		["-C", cwd, ...args],
		{
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
}

/** A repo at `<root>/app` with one commit and ignored build dirs, plus linked worktrees as requested. */
function makeRepo(worktrees: [branch: string, path: string][]):
{
	root: string;
	repo: string;
}
{
	const root = realpathSync(mkdtempSync(join(tmpdir(), "find-removable-worktrees-")));
	const repo = join(root, "app");
	mkdirSync(repo);
	git(repo, "init", "--quiet", "--initial-branch=main");
	git(repo, "config", "user.email", "test@example.com");
	git(repo, "config", "user.name", "Test");
	writeFileSync(join(repo, ".gitignore"), "node_modules/\ntarget/\n");
	git(repo, "add", ".gitignore");
	git(repo, "commit", "--quiet", "--message", "init");
	for (const [branch, path] of worktrees)
	{
		git(repo, "worktree", "add", "--quiet", "-b", branch, join(root, path));
	}
	return {
		root,
		repo,
	};
}

const HOUR = 60 * 60 * 1000;
/** A clock two hours ahead, so freshly created fixtures count as long idle. */
const LATER =
{
	now: Date.now() + 2 * HOUR,
	cwds: [],
};

test("build dirs in the main checkout are not worktree candidates", () =>
{
	const {root, repo} = makeRepo([]);
	try
	{
		mkdirSync(join(repo, "node_modules"));
		assert.deepStrictEqual(findWorktrees([join(repo, "node_modules")], LATER), []);
	}
	finally
	{
		rmSync(
			root,
			{
				recursive: true,
			},
		);
	}
});

test("linked worktrees in peer dirs and under .worktrees are found with their build-dir counts", () =>
{
	const {root, repo} = makeRepo([
		["just-format-hooks", "app-just-format-hooks"],
		["feature", "app/.worktrees/feature"],
	]);
	const peer = join(root, "app-just-format-hooks");
	const nested = join(repo, ".worktrees/feature");
	try
	{
		for (const dir of [`${peer}/node_modules`, `${peer}/lib/target`, `${nested}/target`])
		{
			mkdirSync(
				dir,
				{
					recursive: true,
				},
			);
		}
		assert.deepStrictEqual(
			findWorktrees(
				[`${peer}/node_modules`, `${peer}/lib/target`, `${nested}/target`, "/nonexistent/app/dist"],
				LATER,
			),
			[
				{
					path: peer,
					repo,
					branch: "just-format-hooks",
					dirCount: 2,
					clean: true,
					idle: true,
				},
				{
					path: nested,
					repo,
					branch: "feature",
					dirCount: 1,
					clean: true,
					idle: true,
				},
			],
		);
	}
	finally
	{
		rmSync(
			root,
			{
				recursive: true,
			},
		);
	}
});

test("a worktree with untracked or modified files is reported as not clean", () =>
{
	const {root, repo} = makeRepo([["dirty", "app-dirty"]]);
	const dirty = join(root, "app-dirty");
	try
	{
		mkdirSync(join(dirty, "target"));
		writeFileSync(join(dirty, "notes.txt"), "wip\n");
		assert.deepStrictEqual(findWorktrees([join(dirty, "target")], LATER), [
			{
				path: dirty,
				repo,
				branch: "dirty",
				dirCount: 1,
				clean: false,
				idle: true,
			},
		]);
	}
	finally
	{
		rmSync(
			root,
			{
				recursive: true,
			},
		);
	}
});

test("removal runs git worktree remove without --force and reports refusals", () =>
{
	const {root, repo} = makeRepo([
		["clean", "app-clean"],
		["dirty", "app-dirty"],
	]);
	const clean = join(root, "app-clean");
	const dirty = join(root, "app-dirty");
	try
	{
		mkdirSync(join(clean, "node_modules"));
		writeFileSync(join(dirty, "notes.txt"), "wip\n");
		const results = removeWorktrees([clean, dirty]);
		assert.deepStrictEqual(
			results.map(({path, removed}) => (
			{
				path,
				removed,
			})),
			[
				{
					path: clean,
					removed: true,
				},
				{
					path: dirty,
					removed: false,
				},
			],
		);
		assert.match(at(results, 1).error ?? "", /contains modified or untracked files/u);
		assert.deepStrictEqual([existsSync(clean), existsSync(dirty)], [false, true]);
		assert.match(git(repo, "branch", "--list", "clean"), /clean/u);
	}
	finally
	{
		rmSync(
			root,
			{
				recursive: true,
			},
		);
	}
});

test("a worktree is idle only when nothing in it or its git admin dir changed within the hour and no process sits in it", () =>
{
	const {root, repo} = makeRepo([
		["quiet", "app-quiet"],
		["edited", "app-edited"],
		["busy", "app-busy"],
		["staged", "app-staged"],
	]);
	const dirs = ["quiet", "edited", "busy", "staged"].map((name) => join(root, `app-${name}`));
	const [quiet, edited, busy, staged] = [at(dirs, 0), at(dirs, 1), at(dirs, 2), at(dirs, 3)];
	try
	{
		const now = Date.now();
		const old = new Date(now - 3 * HOUR);
		for (const dir of [quiet, edited, busy, staged])
		{
			mkdirSync(join(dir, "target"));
			for (const file of git(dir, "ls-files").split("\n").filter(Boolean))
			{
				utimesSync(join(dir, file), old, old);
			}
			const adminDir = git(dir, "rev-parse", "--absolute-git-dir").trim();
			for (const adminFile of execFileSync(
				"find",
				[adminDir, "-type", "f"],
				{
					encoding: "utf8",
				},
			).split("\n"))
			{
				if (adminFile !== "")
				{
					utimesSync(adminFile, old, old);
				}
			}
			utimesSync(join(dir, ".git"), old, old);
		}
		writeFileSync(join(edited, ".gitignore"), "node_modules/\ntarget/\n# touched\n");
		utimesSync(join(staged, ".gitignore"), old, old);
		const adminHead = join(git(staged, "rev-parse", "--absolute-git-dir").trim(), "HEAD");
		utimesSync(adminHead, new Date(now - 5 * 60 * 1000), new Date(now - 5 * 60 * 1000));
		const paths = [quiet, edited, busy, staged].map((dir) => join(dir, "target"));
		const result = findWorktrees(
			paths,
			{
				now,
				cwds: [join(busy, "src")],
			},
		);
		assert.deepStrictEqual(
			result.map(({path, idle}) => (
			{
				path,
				idle,
			})),
			[
				{
					path: busy,
					idle: false,
				},
				{
					path: edited,
					idle: false,
				},
				{
					path: quiet,
					idle: true,
				},
				{
					path: staged,
					idle: false,
				},
			],
		);
		assert.ok(repo.length > 0);
	}
	finally
	{
		rmSync(
			root,
			{
				recursive: true,
			},
		);
	}
});

test("a worktree whose file listing exceeds the default 1 MiB exec buffer is still described", () =>
{
	const {root, repo} = makeRepo([["huge", "app-huge"]]);
	const huge = join(root, "app-huge");
	try
	{
		mkdirSync(join(huge, "target"));
		const many = join(huge, "many");
		mkdirSync(many);
		const padding = "x".repeat(200);
		for (let index = 0; index < 6000; index++)
		{
			writeFileSync(join(many, `${padding}-${index}.txt`), "");
		}
		assert.deepStrictEqual(findWorktrees([join(huge, "target")], LATER), [
			{
				path: huge,
				repo,
				branch: "huge",
				dirCount: 1,
				clean: false,
				idle: true,
			},
		]);
	}
	finally
	{
		rmSync(
			root,
			{
				recursive: true,
			},
		);
	}
});
