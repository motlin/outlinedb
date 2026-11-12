#!/usr/bin/env node
// Rebase the user's open pull requests locally, push them, and report which are ready to merge.
//
// Replaces the multi-step "Created Pull Requests" weekly routine with one command:
//   - one GraphQL search lists every open PR authored by the viewer, with review and CI state
//   - PRs listed in --skip, and PRs with any approving review, are never rebased or pushed
//     (a force push can dismiss an approval)
//   - stacked PRs (a PR whose base is another open PR's head) are rebased together with
//     `git rebase --update-refs` in one worktree
//   - rebases always happen locally in a throwaway worktree, never with `gh pr update-branch`
//   - without --apply nothing is rebased or pushed; the report shows what would be
//   - with --apply, rebased branches are pushed with `--force-with-lease`, then CI is polled
//   - never merges; the report lists green PR URLs for the user to merge
//
// A conflicted rebase is left in its worktree (status "conflict", worktree path in the report) for
// /git:conflicts. Failing PRs are listed under "failing" for /build:fix. Never creates PRs.
//
// Usage:
//   node rebase-open-prs.mts [--apply] [--no-wait] [--wait-minutes 30]
//        [--repos-root ~/projects]... [--worktree-root <dir>] [--skip owner/repo#N]...
//   Env REBASE_PRS_GH overrides the gh command (default "gh"), e.g. a wrapper that injects credentials.
//   Prints a JSON report on stdout and progress on stderr.

import {execFileSync, spawnSync} from "node:child_process";
import type {ExecFileSyncOptionsWithStringEncoding} from "node:child_process";
import {existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync} from "node:fs";
import {homedir, tmpdir} from "node:os";
import {join} from "node:path";
import {isObject} from "./json.mts";
import {isMain} from "./is-main.mts";

export type Ci = "SUCCESS" | "FAILURE" | "PENDING" | "NONE";

export interface Pr
{
	repo: string;
	number: number;
	url: string;
	title: string;
	isDraft: boolean;
	base: string;
	head: string;
	/** nameWithOwner of the repository holding the head branch; null when the fork was deleted. */
	headRepo: string | null;
	approved: boolean;
	ci: Ci;
}

export interface Stack
{
	repo: string;
	/** Root first. */
	prs: Pr[];
	branched: boolean;
}

export type StackOutcome =
	|
	  {
			status: "rebased" | "current" | "approved" | "no-clone" | "branched";
			prs: Pr[];
	  }
	|
	  {
			status: "conflict";
			prs: Pr[];
			worktree: string;
	  }
	|
	  {
			status: "error";
			prs: Pr[];
			message: string;
	  };

export interface Report
{
	applied: boolean;
	rebased: string[];
	current: string[];
	approved: string[];
	conflicted:
	{
		urls: string[];
		worktree: string;
	}[];
	noClone: string[];
	branched: string[];
	errors:
	{
		urls: string[];
		message: string;
	}[];
	skipped: string[];
	failing: string[];
	pending: string[];
	mergeUrls: string[];
}

export const SEARCH_QUERY = `query {
  search(query: "is:pr is:open author:@me archived:false", type: ISSUE, first: 100) {
    nodes {
      ... on PullRequest {
        number url title isDraft reviewDecision baseRefName headRefName
        repository { nameWithOwner }
        headRepository { nameWithOwner }
        latestReviews(first: 20) { nodes { state } }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`;

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const obj = (value: unknown): Record<string, unknown> => (isObject(value) ? value : {});

function ciOf(rollup: string | undefined): Ci
{
	if (rollup === "SUCCESS")
	{
		return "SUCCESS";
	}
	if (rollup === "FAILURE" || rollup === "ERROR")
	{
		return "FAILURE";
	}
	if (rollup === "PENDING" || rollup === "EXPECTED")
	{
		return "PENDING";
	}
	return "NONE";
}

export function parsePrs(response: unknown): Pr[]
{
	const nodes = arr(obj(obj(obj(response).data).search).nodes);
	const prs: Pr[] = [];
	for (const raw of nodes)
	{
		const node = obj(raw);
		const number = node.number;
		const url = str(node.url);
		const repo = str(obj(node.repository).nameWithOwner);
		const base = str(node.baseRefName);
		const head = str(node.headRefName);
		if (typeof number !== "number" || !url || !repo || !base || !head)
		{
			continue;
		}
		const reviews = arr(obj(node.latestReviews).nodes).map((review) => str(obj(review).state));
		const lastCommit = obj(obj(arr(obj(node.commits).nodes)[0]).commit);
		prs.push(
			{
				repo,
				number,
				url,
				title: str(node.title) ?? "",
				isDraft: node.isDraft === true,
				base,
				head,
				headRepo: str(obj(node.headRepository).nameWithOwner) ?? null,
				approved: node.reviewDecision === "APPROVED" || reviews.includes("APPROVED"),
				ci: ciOf(str(obj(lastCommit.statusCheckRollup).state)),
			},
		);
	}
	return prs;
}

/** Group PRs of one repo into stacks (connected by head -> base). Stacks keep first-appearance order. */
export function buildStacks(prs: readonly Pr[]): Stack[]
{
	const isOwnBranch = (p: Pr): boolean => p.headRepo === p.repo;
	const parentOf = (p: Pr): Pr | undefined =>
		prs.find((q) => q !== p && q.repo === p.repo && isOwnBranch(q) && q.head === p.base);
	const seen = new Set<Pr>();
	const stacks: Stack[] = [];
	for (const start of prs)
	{
		if (seen.has(start))
		{
			continue;
		}
		const component = new Set<Pr>();
		const queue = [start];
		while (queue.length > 0)
		{
			const current = queue.pop();
			if (!current || component.has(current))
			{
				continue;
			}
			component.add(current);
			const parent = parentOf(current);
			if (parent)
			{
				queue.push(parent);
			}
			for (const q of prs)
			{
				if (parentOf(q) === current)
				{
					queue.push(q);
				}
			}
		}
		for (const member of component)
		{
			seen.add(member);
		}
		const members = [...component];
		const roots = members.filter((p) => !parentOf(p));
		const branched = roots.length !== 1 || members.some((p) => members.filter((q) => parentOf(q) === p).length > 1);
		const ordered: Pr[] = [];
		if (!branched)
		{
			let cursor: Pr | undefined = roots[0];
			while (cursor)
			{
				ordered.push(cursor);
				const parent: Pr = cursor;
				cursor = members.find((q) => parentOf(q) === parent);
			}
		}
		stacks.push(
			{
				repo: start.repo,
				prs: branched ? members : ordered,
				branched,
			},
		);
	}
	return stacks;
}

/** The remote whose URL points at `nameWithOwner`, for scp, https and path style URLs. */
export function remoteFor(remotes: Record<string, string>, nameWithOwner: string): string | null
{
	for (const [name, url] of Object.entries(remotes))
	{
		const normalized = url.replace(/\/$/u, "").replace(/\.git$/u, "");
		if (normalized.endsWith(`/${nameWithOwner}`) || normalized.endsWith(`:${nameWithOwner}`))
		{
			return name;
		}
	}
	return null;
}

export function buildReport(outcomes: readonly StackOutcome[], skipped: readonly string[], applied: boolean): Report
{
	const report: Report =
	{
		applied,
		rebased: [],
		current: [],
		approved: [],
		conflicted: [],
		noClone: [],
		branched: [],
		errors: [],
		skipped: [...skipped],
		failing: [],
		pending: [],
		mergeUrls: [],
	};
	for (const outcome of outcomes)
	{
		const u = outcome.prs.map((p) => p.url);
		switch (outcome.status)
		{
			case "rebased":
				report.rebased.push(...u);
				break;
			case "current":
				report.current.push(...u);
				break;
			case "approved":
				report.approved.push(...u);
				break;
			case "no-clone":
				report.noClone.push(...u);
				break;
			case "branched":
				report.branched.push(...u);
				break;
			case "conflict":
				report.conflicted.push(
					{
						urls: u,
						worktree: outcome.worktree,
					},
				);
				break;
			case "error":
				report.errors.push(
					{
						urls: u,
						message: outcome.message,
					},
				);
				break;
		}
		if (outcome.status === "conflict" || outcome.status === "error")
		{
			continue;
		}
		for (const p of outcome.prs)
		{
			if (p.ci === "FAILURE")
			{
				report.failing.push(p.url);
			}
			else if (p.ci === "PENDING")
			{
				report.pending.push(p.url);
			}
			else if (p.ci === "SUCCESS" && !p.isDraft)
			{
				report.mergeUrls.push(p.url);
			}
		}
	}
	return report;
}

// ---- git ----

interface GitResult
{
	status: number;
	stdout: string;
	stderr: string;
}

function git(cwd: string, ...args: string[]): GitResult
{
	const result = spawnSync(
		"git",
		["-C", cwd, ...args],
		{
			encoding: "utf8",
		},
	);
	return {
		status: result.status ?? 1,
		stdout: result.stdout.trim(),
		stderr: result.stderr.trim(),
	};
}

function gitOk(cwd: string, ...args: string[]): string
{
	const result = git(cwd, ...args);
	if (result.status !== 0)
	{
		throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr}`);
	}
	return result.stdout;
}

function remotesOf(repoPath: string): Record<string, string>
{
	const remotes: Record<string, string> = {};
	for (const name of gitOk(repoPath, "remote").split("\n").filter(Boolean))
	{
		remotes[name] = gitOk(repoPath, "remote", "get-url", name);
	}
	return remotes;
}

/** The local checkout (direct child of a root) with a remote pointing at `repo`. */
export function findLocalRepo(roots: readonly string[], repo: string): string | null
{
	for (const root of roots)
	{
		if (!existsSync(root))
		{
			continue;
		}
		for (const entry of readdirSync(
			root,
			{
				withFileTypes: true,
			},
		).toSorted((a, b) => a.name.localeCompare(b.name)))
		{
			const dir = join(root, entry.name);
			if (!entry.isDirectory() || !existsSync(join(dir, ".git", "HEAD")))
			{
				continue;
			}
			try
			{
				if (remoteFor(remotesOf(dir), repo))
				{
					return dir;
				}
			}
			catch
			{
				continue;
			}
		}
	}
	return null;
}

export interface ProcessStackOptions
{
	repoPath: string;
	stack: Stack;
	worktreeRoot: string;
	apply: boolean;
}

const LOCAL_PREFIX = "rebase-prs/";

/**
 * Rebase one stack onto its base. Pure local work in a worktree; pushes only when `apply`.
 * Without `apply` it only reports whether a rebase would happen.
 */
export function processStack({repoPath, stack, worktreeRoot, apply}: ProcessStackOptions): StackOutcome
{
	const {prs} = stack;
	if (stack.branched)
	{
		return {
			status: "branched",
			prs,
		};
	}
	if (prs.some((p) => p.approved))
	{
		return {
			status: "approved",
			prs,
		};
	}
	const root = prs[0];
	const leaf = prs.at(-1);
	if (!root || !leaf)
	{
		return {
			status: "current",
			prs,
		};
	}
	try
	{
		const remotes = remotesOf(repoPath);
		const baseRemote = remoteFor(remotes, root.repo);
		const headRemotes = prs.map((p) => (p.headRepo ? remoteFor(remotes, p.headRepo) : null));
		if (!baseRemote || headRemotes.some((r) => r === null))
		{
			return {
				status: "no-clone",
				prs,
			};
		}
		for (const remote of new Set([baseRemote, ...headRemotes.filter((r): r is string => r !== null)]))
		{
			gitOk(repoPath, "fetch", "--quiet", remote);
		}
		const baseRef = `${baseRemote}/${root.base}`;
		const originalShas = prs.map((p, i) => gitOk(repoPath, "rev-parse", `${headRemotes[i]}/${p.head}`));
		const behind = git(repoPath, "merge-base", "--is-ancestor", baseRef, originalShas.at(-1) ?? "").status !== 0;
		if (!behind)
		{
			return {
				status: "current",
				prs,
			};
		}
		if (!apply)
		{
			return {
				status: "rebased",
				prs,
			};
		}
		prs.forEach((p, i) =>
		{
			gitOk(repoPath, "branch", "-f", `${LOCAL_PREFIX}${p.head}`, originalShas[i] ?? "");
		});
		mkdirSync(
			worktreeRoot,
			{
				recursive: true,
			},
		);
		const worktree = join(worktreeRoot, `${repoPath.split("/").at(-1)}-pr-${leaf.number}`);
		gitOk(repoPath, "worktree", "add", "--quiet", worktree, `${LOCAL_PREFIX}${leaf.head}`);
		const rebase = git(worktree, "rebase", "--update-refs", baseRef);
		if (rebase.status !== 0)
		{
			return {
				status: "conflict",
				prs,
				worktree,
			};
		}
		prs.forEach((p, i) =>
		{
			const local = gitOk(repoPath, "rev-parse", `${LOCAL_PREFIX}${p.head}`);
			if (local !== originalShas[i])
			{
				gitOk(
					repoPath,
					"push",
					"--quiet",
					`--force-with-lease=refs/heads/${p.head}:${originalShas[i]}`,
					headRemotes[i] ?? "",
					`${LOCAL_PREFIX}${p.head}:refs/heads/${p.head}`,
				);
			}
		});
		gitOk(repoPath, "worktree", "remove", worktree);
		for (const p of prs)
		{
			gitOk(repoPath, "branch", "-D", `${LOCAL_PREFIX}${p.head}`);
		}
		return {
			status: "rebased",
			prs,
		};
	}
	catch (error)
	{
		return {
			status: "error",
			prs,
			message: error instanceof Error ? error.message : String(error),
		};
	}
}

// ---- CLI ----

export type GhExec = (command: string, args: string[], options: ExecFileSyncOptionsWithStringEncoding) => string;

// stdin is inherited so wrappers like `op plugin run -- gh` can authenticate; stdout is captured for parsing.
export function ghGraphql(exec: GhExec = execFileSync, ghCommand: string = process.env.REBASE_PRS_GH ?? "gh"): unknown
{
	const [command = "gh", ...prefix] = ghCommand.split(/\s+/u);
	const out = exec(
		command,
		[...prefix, "api", "graphql", "-f", `query=${SEARCH_QUERY}`],
		{
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
			stdio: ["inherit", "pipe", "inherit"],
		},
	);
	return JSON.parse(out);
}

/** PRs to skip from `rebaseSkip` (array of owner/repo#N) in .llm/gtd/config.json, when that file exists. */
function configuredSkips(configPath = ".llm/gtd/config.json"): string[]
{
	if (!existsSync(configPath))
	{
		return [];
	}
	const config: unknown = JSON.parse(readFileSync(configPath, "utf8"));
	const skip = isObject(config) ? config.rebaseSkip : undefined;
	return Array.isArray(skip) ? skip.filter((entry): entry is string => typeof entry === "string") : [];
}

function parseArgs(argv: readonly string[])
{
	const options =
	{
		apply: false,
		wait: true,
		waitMinutes: 30,
		roots: [] as string[],
		worktreeRoot: "",
		skip: configuredSkips(),
	};
	for (let i = 0; i < argv.length; i++)
	{
		const arg = argv[i];
		const next = (): string => argv[++i] ?? "";
		if (arg === "--apply")
		{
			options.apply = true;
		}
		else if (arg === "--no-wait")
		{
			options.wait = false;
		}
		else if (arg === "--wait-minutes")
		{
			options.waitMinutes = Number(next());
		}
		else if (arg === "--repos-root")
		{
			options.roots.push(next());
		}
		else if (arg === "--worktree-root")
		{
			options.worktreeRoot = next();
		}
		else if (arg === "--skip")
		{
			options.skip.push(next());
		}
		else
		{
			throw new Error(`unknown argument: ${arg}`);
		}
	}
	if (options.roots.length === 0)
	{
		options.roots.push(join(homedir(), "projects"));
	}
	if (!options.worktreeRoot)
	{
		options.worktreeRoot = join(realpathSync(mkdtempSync(join(tmpdir(), "rebase-open-prs-"))), "worktrees");
	}
	return options;
}

const sleep = (ms: number): void =>
{
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

function main(argv: readonly string[]): Report
{
	const options = parseArgs(argv);
	const all = parsePrs(ghGraphql());
	const isSkipped = (p: Pr): boolean => options.skip.includes(`${p.repo}#${p.number}`);
	const skipped = all.filter(isSkipped).map((p) => p.url);
	const prs = all.filter((p) => !isSkipped(p));
	const outcomes: StackOutcome[] = [];
	for (const stack of buildStacks(prs))
	{
		const repoPath = findLocalRepo(options.roots, stack.repo);
		const label = `${stack.repo} ${stack.prs.map((p) => `#${p.number}`).join("+")}`;
		if (!repoPath)
		{
			console.error(`${label}: no local clone`);
			outcomes.push(
				{
					status: "no-clone",
					prs: stack.prs,
				},
			);
			continue;
		}
		const outcome = processStack(
			{
				repoPath,
				stack,
				worktreeRoot: options.worktreeRoot,
				apply: options.apply,
			},
		);
		console.error(`${label}: ${outcome.status}`);
		outcomes.push(outcome);
	}
	if (options.apply && options.wait)
	{
		const deadline = Date.now() + options.waitMinutes * 60_000;
		let latest = prs;
		while (Date.now() < deadline)
		{
			latest = parsePrs(ghGraphql()).filter((p) => !isSkipped(p));
			if (!latest.some((p) => p.ci === "PENDING"))
			{
				break;
			}
			console.error("waiting for CI...");
			sleep(30_000);
		}
		const byUrl = new Map(latest.map((p) => [p.url, p]));
		for (const outcome of outcomes)
		{
			outcome.prs = outcome.prs.map((p) => byUrl.get(p.url) ?? p);
		}
	}
	return buildReport(outcomes, skipped, options.apply);
}

if (isMain(import.meta.url))
{
	console.log(JSON.stringify(main(process.argv.slice(2)), null, 2));
}
