import {expect, describe, beforeAll, it} from "vite-plus/test";
import {existsSync} from "node:fs";
import {join} from "node:path";
import {parseMarkdownFile} from "./helpers/markdown-parser.js";
import
{
	PLUGINS_DIR,
	PROJECT_ROOT,
	collectComponentFiles,
	collectMarkdownFiles,
	listPlugins,
} from "./helpers/scan-roots.js";

const LOCAL_COMMANDS_DIR = join(PROJECT_ROOT, ".claude/commands");

/**
 * Build a command registry from plugin and project-local command directories.
 * Plugin commands are namespaced by plugin name:
 *   `plugins/gtd/commands/inbox.md` -> `gtd:inbox`
 *   `plugins/gtd/commands/review/daily.md` -> `gtd:review:daily`
 * Project-local commands keep their directory-derived names:
 *   `.claude/commands/foo/bar.md` -> `foo:bar`
 */
function buildCommandRegistry(): Set<string>
{
	const registry = new Set<string>();

	for (const plugin of listPlugins())
	{
		const commandsDir = join(PLUGINS_DIR, plugin, "commands");
		for (const filePath of collectMarkdownFiles(commandsDir))
		{
			const relative = filePath.slice(commandsDir.length + 1);
			const withoutExt = relative.replace(/\.md$/u, "");
			registry.add(`${plugin}:${withoutExt.replaceAll("/", ":")}`);
		}
	}

	for (const filePath of collectMarkdownFiles(LOCAL_COMMANDS_DIR))
	{
		const relative = filePath.slice(LOCAL_COMMANDS_DIR.length + 1);
		const withoutExt = relative.replace(/\.md$/u, "");
		registry.add(withoutExt.replaceAll("/", ":"));
	}

	return registry;
}

/**
 * Resolve a script reference to an absolute path. `${CLAUDE_PLUGIN_ROOT}` refs
 * resolve against the plugin containing the referencing file; `.claude/scripts/`
 * refs resolve against the project root.
 */
function resolveScriptRef(refPath: string, referencingFile: string): string | undefined
{
	if (refPath.startsWith("${CLAUDE_PLUGIN_ROOT}/"))
	{
		const pluginName = referencingFile.match(/^plugins\/([^/]+)\//u)?.[1];
		if (pluginName === undefined)
		{
			return undefined;
		}
		return join(PLUGINS_DIR, pluginName, refPath.slice("${CLAUDE_PLUGIN_ROOT}/".length));
	}
	return join(PROJECT_ROOT, refPath);
}

describe("Structural Eval: Cross-References", () =>
{
	let commandRegistry: Set<string>;
	let allCommandRefs:
	{
		ref: string;
		file: string;
		line: number;
	}[];
	let allScriptRefs:
	{
		path: string;
		file: string;
		line: number;
	}[];

	beforeAll(() =>
	{
		commandRegistry = buildCommandRegistry();

		// Collect all cross-command and script references from plugin and
		// project-local commands, agents, and skills
		allCommandRefs = [];
		allScriptRefs = [];
		const sourceFiles = [
			...collectComponentFiles("commands"),
			...collectComponentFiles("agents"),
			...collectComponentFiles("prompts"),
			...collectComponentFiles("skills"),
		];

		for (const filePath of sourceFiles)
		{
			const analysis = parseMarkdownFile(filePath);
			const relativeFile = filePath.replace(`${PROJECT_ROOT}/`, "");

			for (const ref of analysis.commandRefs)
			{
				allCommandRefs.push(
					{
						ref: ref.ref,
						file: relativeFile,
						line: ref.line,
					},
				);
			}

			for (const ref of analysis.scriptRefs)
			{
				allScriptRefs.push(
					{
						path: ref.path,
						file: relativeFile,
						line: ref.line,
					},
				);
			}
		}
	});

	describe("command references (/gtd:X)", () =>
	{
		it("should build a non-empty command registry", () =>
		{
			expect(commandRegistry.size).toBeGreaterThan(0);
		});

		it("should find command references in markdown files", () =>
		{
			expect(allCommandRefs.length).toBeGreaterThan(0);
		});

		it("every /X:Y command reference should resolve to an existing command file", () =>
		{
			const missing: string[] = [];

			for (const ref of allCommandRefs)
			{
				// Strip leading / to get the command name (e.g., "/gtd:inbox" -> "gtd:inbox")
				const commandName = ref.ref.slice(1);
				if (!commandRegistry.has(commandName))
				{
					missing.push(`  "${ref.ref}" referenced at ${ref.file}:${ref.line}`);
				}
			}

			expect(missing).toStrictEqual([]);
		});
	});

	describe("script references", () =>
	{
		it("should find script references in markdown files", () =>
		{
			expect(allScriptRefs.length).toBeGreaterThan(0);
		});

		it("every script reference should resolve to an existing file", () =>
		{
			const missing: string[] = [];

			for (const ref of allScriptRefs)
			{
				const fullPath = resolveScriptRef(ref.path, ref.file);
				if (!fullPath || !existsSync(fullPath))
				{
					missing.push(`  "${ref.path}" referenced at ${ref.file}:${ref.line}`);
				}
			}

			expect(missing).toStrictEqual([]);
		});
	});
});
