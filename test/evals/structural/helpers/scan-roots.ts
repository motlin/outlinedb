/**
 * Shared scan roots for structural evals.
 *
 * Commands, agents, prompts, and skills live in two kinds of places:
 * - Plugins: `plugins/<plugin>/{commands,agents,prompts,skills}` (declared by
 *   `.claude-plugin/marketplace.json`)
 * - Project-local: `.claude/{commands,agents,skills}`
 */

import {execFileSync} from "node:child_process";
import {existsSync, readdirSync} from "node:fs";
import {join, resolve} from "node:path";

export const PROJECT_ROOT = resolve(import.meta.dirname, "../../../..");
export const PLUGINS_DIR = join(PROJECT_ROOT, "plugins");

export type ComponentKind = "commands" | "agents" | "prompts" | "skills";

/**
 * Paths of every git-tracked file under a root, relative to PROJECT_ROOT.
 *
 * Structural evals scan tracked files only, so gitignored personal config
 * (`.claude/settings.local.json`, `.llm/`) stays exempt by design.
 */
export function trackedFiles(root: string): string[]
{
	const output = execFileSync(
		"git",
		["ls-files", "-z", "--", root],
		{
			cwd: PROJECT_ROOT,
			encoding: "utf8",
		},
	);
	return output.split("\0").filter(Boolean);
}

/**
 * Recursively collect all .md files under a directory.
 */
export function collectMarkdownFiles(dir: string): string[]
{
	if (!existsSync(dir))
	{
		return [];
	}
	const results: string[] = [];
	for (const entry of readdirSync(
		dir,
		{
			withFileTypes: true,
		},
	))
	{
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory())
		{
			results.push(...collectMarkdownFiles(fullPath));
		}
		else if (entry.isFile() && entry.name.endsWith(".md"))
		{
			results.push(fullPath);
		}
	}
	return results;
}

/**
 * List plugin names (subdirectories of plugins/).
 */
export function listPlugins(): string[]
{
	if (!existsSync(PLUGINS_DIR))
	{
		return [];
	}
	return readdirSync(
		PLUGINS_DIR,
		{
			withFileTypes: true,
		},
	)
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name);
}

/**
 * All directories holding components of the given kind, across plugins and
 * the project-local .claude tree.
 */
function componentDirs(kind: ComponentKind): string[]
{
	return [...listPlugins().map((plugin) => join(PLUGINS_DIR, plugin, kind)), join(PROJECT_ROOT, ".claude", kind)];
}

/**
 * All markdown files of the given component kind, across plugins and the
 * project-local .claude tree.
 */
export function collectComponentFiles(kind: ComponentKind): string[]
{
	return componentDirs(kind).flatMap((dir) => collectMarkdownFiles(dir));
}
