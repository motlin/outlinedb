// Run: node --test plugins/gtd/scripts/rebase-open-prs.test.mts
/* eslint-disable @typescript-eslint/no-floating-promises -- node:test test() calls are fire-and-forget by design */
import {test} from "node:test";
import assert from "node:assert/strict";
import {execFileSync, spawnSync} from "node:child_process";
import {mkdirSync, mkdtempSync, realpathSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
	buildReport,
	buildStacks,
	findLocalRepo,
	ghGraphql,
	parsePrs,
	processStack,
	remoteFor,
} from "./rebase-open-prs.mts";
import type {Pr, StackOutcome} from "./rebase-open-prs.mts";

const pr = (over: Partial<Pr>): Pr => ({
	repo: "acme/widgets",
	number: 1,
	url: "https://github.com/acme/widgets/pull/1",
	title: "t",
	isDraft: false,
	base: "main",
	head: "feature",
	headRepo: "acme/widgets",
	approved: false,
	ci: "SUCCESS",
	...over,
});

test("parsePrs flattens the graphql search result and derives approval and CI state", () => {
	const json = {
		data: {
			search: {
				nodes: [
					{
						number: 7,
						url: "https://github.com/acme/widgets/pull/7",
						title: "Seven",
						isDraft: true,
						reviewDecision: null,
						baseRefName: "main",
						headRefName: "seven",
						repository: {nameWithOwner: "acme/widgets"},
						headRepository: {nameWithOwner: "me/widgets"},
						latestReviews: {nodes: [{state: "COMMENTED"}, {state: "APPROVED"}]},
						commits: {nodes: [{commit: {statusCheckRollup: {state: "PENDING"}}}]},
					},
					{
						number: 8,
						url: "https://github.com/acme/widgets/pull/8",
						title: "Eight",
						isDraft: false,
						reviewDecision: "APPROVED",
						baseRefName: "main",
						headRefName: "eight",
						repository: {nameWithOwner: "acme/widgets"},
						headRepository: null,
						latestReviews: {nodes: []},
						commits: {nodes: [{commit: {statusCheckRollup: null}}]},
					},
					{},
				],
			},
		},
	};
	assert.deepStrictEqual(parsePrs(json), [
		{
			repo: "acme/widgets",
			number: 7,
			url: "https://github.com/acme/widgets/pull/7",
			title: "Seven",
			isDraft: true,
			base: "main",
			head: "seven",
			headRepo: "me/widgets",
			approved: true,
			ci: "PENDING",
		},
		{
			repo: "acme/widgets",
			number: 8,
			url: "https://github.com/acme/widgets/pull/8",
			title: "Eight",
			isDraft: false,
			base: "main",
			head: "eight",
			headRepo: null,
			approved: true,
			ci: "NONE",
		},
	]);
});

test("buildStacks orders a linear stack root first and keeps lone PRs as stacks of one", () => {
	const a = pr({number: 1, head: "a", base: "main"});
	const b = pr({number: 2, head: "b", base: "a"});
	const c = pr({number: 3, head: "c", base: "b"});
	const lone = pr({number: 4, head: "lone", base: "main"});
	const other = pr({number: 1, repo: "acme/other", head: "a", base: "main"});
	const stacks = buildStacks([c, lone, b, other, a]);
	assert.deepStrictEqual(
		stacks.map((s) => ({repo: s.repo, numbers: s.prs.map((p) => p.number), branched: s.branched})),
		[
			{repo: "acme/widgets", numbers: [1, 2, 3], branched: false},
			{repo: "acme/widgets", numbers: [4], branched: false},
			{repo: "acme/other", numbers: [1], branched: false},
		],
	);
});

test("buildStacks flags a stack where two PRs sit on the same parent as branched", () => {
	const a = pr({number: 1, head: "a", base: "main"});
	const b = pr({number: 2, head: "b", base: "a"});
	const c = pr({number: 3, head: "c", base: "a"});
	const [stack] = buildStacks([a, b, c]);
	assert.strictEqual(stack?.branched, true);
	assert.deepStrictEqual(
		stack?.prs.map((p) => p.number).toSorted((x, y) => x - y),
		[1, 2, 3],
	);
});

test("remoteFor matches scp, https and path style remote URLs", () => {
	const remotes = {
		origin: "git@github.com:acme/widgets.git",
		fork: "https://github.com/me/widgets",
		local: "/tmp/x/acme2/tools.git",
	};
	assert.strictEqual(remoteFor(remotes, "acme/widgets"), "origin");
	assert.strictEqual(remoteFor(remotes, "me/widgets"), "fork");
	assert.strictEqual(remoteFor(remotes, "acme2/tools"), "local");
	assert.strictEqual(remoteFor(remotes, "nobody/widgets"), null);
});

test("buildReport groups outcomes and lists green non-draft PRs as merge URLs", () => {
	const green = pr({number: 1, url: "u1"});
	const failing = pr({number: 2, url: "u2", ci: "FAILURE"});
	const pending = pr({number: 3, url: "u3", ci: "PENDING"});
	const draft = pr({number: 4, url: "u4", isDraft: true});
	const approved = pr({number: 5, url: "u5", approved: true});
	const conflict = pr({number: 6, url: "u6", ci: "FAILURE"});
	const outcomes: StackOutcome[] = [
		{status: "rebased", prs: [green]},
		{status: "current", prs: [failing, pending, draft]},
		{status: "approved", prs: [approved]},
		{status: "conflict", prs: [conflict], worktree: "/w/6"},
	];
	assert.deepStrictEqual(buildReport(outcomes, ["u9"], true), {
		applied: true,
		rebased: ["u1"],
		current: ["u2", "u3", "u4"],
		approved: ["u5"],
		conflicted: [{urls: ["u6"], worktree: "/w/6"}],
		noClone: [],
		branched: [],
		errors: [],
		skipped: ["u9"],
		failing: ["u2"],
		pending: ["u3"],
		mergeUrls: ["u1", "u5"],
	});
});

// ---- git integration against throwaway local repos (no network, no real PR branches) ----

const git = (cwd: string, ...args: string[]): string =>
	execFileSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@t",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@t",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_SYSTEM: "/dev/null",
		},
	}).trim();

function commitFile(repo: string, file: string, content: string, message: string): void {
	writeFileSync(join(repo, file), content);
	git(repo, "add", file);
	git(repo, "commit", "-q", "-m", message);
}

interface Fixture {
	root: string;
	clone: string;
	bare: string;
	work: string;
}

/** acme/widgets.git bare remote, a clone with main plus stacked branches a <- b, then main moves on. */
function fixture(opts: {conflict?: boolean} = {}): Fixture {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "rebase-open-prs-")));
	const bare = join(root, "remote", "acme", "widgets.git");
	mkdirSync(bare, {recursive: true});
	git(bare, "init", "-q", "--bare", "-b", "main");
	const clone = join(root, "projects", "widgets");
	mkdirSync(clone, {recursive: true});
	git(clone, "init", "-q", "-b", "main");
	// the user's global config may set core.fsmonitor=true; processStack's git inherits it and would leave a
	// fsmonitor--daemon running per temp repo (and its worktrees) long after the temp dir is gone
	git(clone, "config", "core.fsmonitor", "false");
	git(clone, "remote", "add", "origin", bare);
	commitFile(clone, "base.txt", "base\n", "base");
	git(clone, "push", "-q", "origin", "main");
	git(clone, "checkout", "-q", "-b", "a");
	commitFile(clone, "a.txt", "a\n", "a1");
	git(clone, "checkout", "-q", "-b", "b");
	commitFile(clone, "b.txt", "b\n", "b1");
	git(clone, "push", "-q", "origin", "a", "b");
	git(clone, "checkout", "-q", "main");
	if (opts.conflict) {
		commitFile(clone, "a.txt", "main wins\n", "main touches a.txt");
	} else {
		commitFile(clone, "main.txt", "m\n", "main moves");
	}
	git(clone, "push", "-q", "origin", "main");
	// the user's own checkout sits on a stack branch: it must not block the rebase
	git(clone, "checkout", "-q", "b");
	return {root, clone, bare, work: join(root, "worktrees")};
}

const stackPrs = (): Pr[] => [
	pr({number: 1, head: "a", base: "main", url: "u1"}),
	pr({number: 2, head: "b", base: "a", url: "u2"}),
];

test("processStack rebases a stack with update-refs and pushes with force-with-lease when applying", () => {
	const f = fixture();
	const [stack] = buildStacks(stackPrs());
	assert.ok(stack);
	const before = git(f.bare, "rev-parse", "b");
	const outcome = processStack({repoPath: f.clone, stack, worktreeRoot: f.work, apply: true});
	assert.strictEqual(outcome.status, "rebased");
	const main = git(f.bare, "rev-parse", "main");
	assert.notStrictEqual(git(f.bare, "rev-parse", "b"), before);
	assert.strictEqual(git(f.bare, "merge-base", "a", "main"), main);
	assert.strictEqual(git(f.bare, "merge-base", "b", "main"), main);
	assert.strictEqual(git(f.bare, "merge-base", "a", "b"), git(f.bare, "rev-parse", "a"));
	assert.strictEqual(git(f.clone, "branch", "--list", "rebase-prs/*"), "");
	assert.strictEqual(git(f.clone, "worktree", "list").split("\n").length, 1);
});

test("processStack without apply rebases nothing and pushes nothing", () => {
	const f = fixture();
	const [stack] = buildStacks(stackPrs());
	assert.ok(stack);
	const before = git(f.bare, "rev-parse", "a", "b");
	const outcome = processStack({repoPath: f.clone, stack, worktreeRoot: f.work, apply: false});
	assert.strictEqual(outcome.status, "rebased");
	assert.strictEqual(git(f.bare, "rev-parse", "a", "b"), before);
	assert.strictEqual(git(f.clone, "worktree", "list").split("\n").length, 1);
});

test("processStack reports current when the base has not moved", () => {
	const f = fixture();
	git(f.clone, "rebase", "-q", "--update-refs", "main", "b");
	git(f.clone, "push", "-q", "--force", "origin", "a", "b");
	const [stack] = buildStacks(stackPrs());
	assert.ok(stack);
	assert.strictEqual(processStack({repoPath: f.clone, stack, worktreeRoot: f.work, apply: true}).status, "current");
});

test("processStack leaves a conflicted worktree for /git:conflicts and pushes nothing", () => {
	const f = fixture({conflict: true});
	const [stack] = buildStacks(stackPrs());
	assert.ok(stack);
	const before = git(f.bare, "rev-parse", "a", "b");
	const outcome = processStack({repoPath: f.clone, stack, worktreeRoot: f.work, apply: true});
	assert.strictEqual(outcome.status, "conflict");
	assert.ok(outcome.status === "conflict" && outcome.worktree.startsWith(f.work));
	assert.strictEqual(git(f.bare, "rev-parse", "a", "b"), before);
});

test("processStack never touches a stack containing an approved PR", () => {
	const f = fixture();
	const prs = stackPrs();
	prs[0] = {...prs[0]!, approved: true};
	const [stack] = buildStacks(prs);
	assert.ok(stack);
	const before = git(f.bare, "rev-parse", "a", "b");
	assert.strictEqual(processStack({repoPath: f.clone, stack, worktreeRoot: f.work, apply: true}).status, "approved");
	assert.strictEqual(git(f.bare, "rev-parse", "a", "b"), before);
});

test("processStack starts no git fsmonitor daemon even when the user's global config enables core.fsmonitor", () => {
	const f = fixture();
	const globalConfig = join(f.root, "global.gitconfig");
	writeFileSync(globalConfig, "[core]\n\tfsmonitor = true\n");
	const saved = process.env.GIT_CONFIG_GLOBAL;
	process.env.GIT_CONFIG_GLOBAL = globalConfig;
	const [stack] = buildStacks(stackPrs());
	assert.ok(stack);
	let outcome: StackOutcome;
	try {
		outcome = processStack({repoPath: f.clone, stack, worktreeRoot: f.work, apply: true});
	} finally {
		if (saved === undefined) {
			delete process.env.GIT_CONFIG_GLOBAL;
		} else {
			process.env.GIT_CONFIG_GLOBAL = saved;
		}
	}
	const watching =
		spawnSync("git", ["-C", f.clone, "fsmonitor--daemon", "status"], {
			env: {...process.env, GIT_CONFIG_GLOBAL: "/dev/null"},
		}).status === 0;
	if (watching) {
		git(f.clone, "fsmonitor--daemon", "stop");
	}
	assert.deepStrictEqual({status: outcome.status, watching}, {status: "rebased", watching: false});
});

test("findLocalRepo finds the checkout whose remote matches", () => {
	const f = fixture();
	assert.strictEqual(findLocalRepo([join(f.root, "projects")], "acme/widgets"), f.clone);
	assert.strictEqual(findLocalRepo([join(f.root, "projects")], "acme/missing"), null);
});

test("ghGraphql inherits stdin so op plugin run can authenticate, and parses captured stdout", () => {
	const calls: {command: string; args: string[]; stdio: unknown}[] = [];
	const result = ghGraphql((command, args, options) => {
		calls.push({command, args, stdio: options.stdio});
		return '{"data":{"ok":true}}';
	}, "op plugin run -- gh");
	assert.deepStrictEqual(result, {data: {ok: true}});
	assert.strictEqual(calls.length, 1);
	assert.strictEqual(calls[0]!.command, "op");
	assert.deepStrictEqual(calls[0]!.args.slice(0, 5), ["plugin", "run", "--", "gh", "api"]);
	assert.deepStrictEqual(calls[0]!.stdio, ["inherit", "pipe", "inherit"]);
});
