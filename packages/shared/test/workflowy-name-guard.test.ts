import {execFileSync} from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vite-plus/test";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

/**
 * Mentions that name the upstream workflowy.com service rather than OutlineDB, stripped from each line before the check.
 * Anything left that still matches /workflowy/i is our own code wearing the old name.
 */
const UPSTREAM_PATTERNS: readonly RegExp[] = [
	// Upstream hosts, including the test stand-in host and upstream's help/community/blog menu keys.
	/[\w.@-]*workflowy\\?\.(?:com|test|help|community|blog)\b/giu,
	// Upstream credential and protocol constants (WORKFLOWY_API_KEY, WORKFLOWY_EPOCH, WORKFLOWY_HOSTS, ...).
	/\bWORKFLOWY_[A-Z_]*/gu,
	// Code identifiers for the upstream client, adapter, node shapes, links, dates and epoch (WorkflowyApiClient, readWorkflowyEpoch, ...).
	/\w+Workflowy\w*/gu,
	/\bworkflowy[A-Z]\w*/gu,
	/\bWorkflowy[A-Z]\w*/gu,
	// Modules that hold the upstream client and upstream format helpers.
	/@outlinedb\/shared\/workflowy\b/gu,
	/"\.\/workflowy"/gu,
	/[\w./-]*\/workflowy(?:\/|\.js\b|\.ts\b)/gu,
	/\bworkflowy-(?:internal-client|client|write-through-client|data-sources)\b/gu,
	/\b(?:mock|fake)-workflowy\b/gu,
	// Upstream's Dropbox backup files and folders.
	/workflowy\\?\.backup\b/gu,
	/\bworkflowy-backup-/gu,
	/\/Apps\/WorkFlowy\//gu,
	// Slash commands and skills of the workflowy plugin, which edits workflowy.com.
	/\/workflowy:[\w-]+/gu,
	/\bplugins\/workflowy\b/gu,
	// The file holding the upstream workflowy.com session cookie.
	/\bworkflowy-session(?:-cookie|-seeded)?\b/gu,
	// A draft bug report for upstream.
	/\.llm\/workflowy-bug-report-[\w-]+\.md/gu,
	// The upstream product named in prose and comments, never followed by an identifier character.
	/\bWork[Ff]lowy\b(?![\w])/gu,
];

/** Files whose remaining mentions all refer to upstream, with the reason. */
const ALLOWED_FILES: readonly (readonly [RegExp, string])[] = [
	[/^plugins\/(?:gtd|workflowy)\//u, "GTD and workflowy plugins operate on Craig's workflowy.com outline"],
	[/^\.claude\/skills\/legacy\//u, "legacy GTD skills about Craig's workflowy.com outline"],
	[
		/^\.claude-plugin\/marketplace\.json$/u,
		"installed marketplace and plugin names; renaming breaks the installed plugins",
	],
	[/^settings\.json$/u, "permission rules for the installed workflowy-tasks plugin"],
	[/^packages\/shared\/test\/workflowy-name-guard\.test\.ts$/u, "this guard"],
	[/^packages\/shared\/test\/package-scope-guard\.test\.ts$/u, "guards against the old @workflowy scope"],
	[/^packages\/web\/test\/outlinedb-brand-guard\.test\.ts$/u, "guards the web brand against the old name"],
	[/^packages\/web\/test\/auth-pages\.test\.tsx$/u, "asserts the auth pages never say workflowy"],
	[/^packages\/cloudflare\/test\/auth-signup\.test\.ts$/u, "asserts the verification email never says workflowy"],
	[/^packages\/web\/test\/changelog\.test\.ts$/u, "asserts the changelog has no workflowy.com links"],
	[
		/^packages\/web\/test\/show-completed-store\.test\.ts$/u,
		"asserts the old workflowy-show-completed key is ignored",
	],
	[/^packages\/web\/src\/client\/components\/decisions-view\.tsx$/u, "the workflowy.com link icon"],
	[/^packages\/web\/test\/decisions-view\.test\.tsx$/u, "the workflowy.com link icon"],
	[
		/^packages\/shared\/test\/account-store-surveys\.test\.ts$/u,
		"upstream survey key from workflowy.com account data",
	],
	[/^packages\/shared\/test\/internal-client-bootstrap\.test\.ts$/u, "upstream workflowy_dev feature flag field"],
	[/^packages\/web\/vite\.config\.ts$/u, "Craig's tailnet hostname for the local app, not ours to rename here"],
	[/^test\/evals\/behavioral\/helpers\/llm-eval-harness\.ts$/u, "loads the workflowy plugin by name"],
	[/^test\/evals\/structural\/prompt-agents\.test\.ts$/u, "scans the workflowy plugin's prompts"],
	[/^test\/evals\/structural\/helpers\/personal-paths\.test\.ts$/u, "a sample local checkout path"],
];

/** Old names for our own CLI, binary, topic and package, banned everywhere including the allowlisted files. */
const OLD_PRODUCT_NAMES = /workflowy[ -]cli\b|workflowy[ :]utils\b|@workflowy\/|mcp__workflowy|\bworkflowy\.sqlite\b/iu;

function allTrackedFiles(): string[] {
	return execFileSync("git", ["ls-files", "-z"], {cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024})
		.split("\0")
		.filter((file) => file !== "" && !file.startsWith(".llm/"))
		.filter((file) => fs.existsSync(path.join(REPO_ROOT, file)));
}

function trackedFiles(): string[] {
	return allTrackedFiles().filter((file) => !ALLOWED_FILES.some(([pattern]) => pattern.test(file)));
}

function oldProductNames(file: string): string[] {
	return fs
		.readFileSync(path.join(REPO_ROOT, file), "utf8")
		.split("\n")
		.filter((line) => OLD_PRODUCT_NAMES.test(line))
		.map((line) => `${file}: ${line.trim()}`);
}

function ownMentions(file: string): string[] {
	const content = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
	if (!/workflowy/iu.test(content)) {
		return [];
	}
	return content
		.split("\n")
		.filter((line) =>
			/workflowy/iu.test(UPSTREAM_PATTERNS.reduce((rest, pattern) => rest.replaceAll(pattern, ""), line)),
		)
		.map((line) => `${file}: ${line.trim()}`);
}

describe("workflowy name guard", () => {
	it("names our own code OutlineDB, keeping workflowy only for upstream references", () => {
		expect(trackedFiles().flatMap((file) => ownMentions(file))).toStrictEqual([]);
	});

	it("never uses the old CLI, topic, package scope, MCP tool or cache file names, even in upstream-facing files", () => {
		const guards = new Set([
			"packages/shared/test/workflowy-name-guard.test.ts",
			"packages/shared/test/package-scope-guard.test.ts",
		]);
		expect(
			allTrackedFiles()
				.filter((file) => !guards.has(file))
				.flatMap((file) => oldProductNames(file)),
		).toStrictEqual([]);
	});
});
