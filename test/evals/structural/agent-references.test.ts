import {beforeAll, describe, expect, it} from "vite-plus/test";
import {readFileSync} from "node:fs";
import {dirname, join, relative, sep} from "node:path";
import {parseMarkdownFile} from "./helpers/markdown-parser.js";
import
{
	PLUGINS_DIR,
	PROJECT_ROOT,
	collectComponentFiles,
	collectMarkdownFiles,
	listPlugins,
} from "./helpers/scan-roots.js";

/**
 * Extract the `name:` field from YAML frontmatter of an agent file.
 */
function extractAgentName(filePath: string): string | null
{
	const content = readFileSync(filePath, "utf8");
	const frontmatterMatch = /^---\n([\s\S]*?)\n---/u.exec(content);
	const frontmatter = frontmatterMatch?.[1];
	if (frontmatter === undefined)
	{
		return null;
	}

	const name = /^name:\s*(.+)$/mu.exec(frontmatter)?.[1];
	if (name === undefined)
	{
		return null;
	}

	return name.trim().replaceAll(/^["']|["']$/gu, "");
}

// Agent types Claude Code provides without an agent file.
const BUILT_IN_AGENTS = new Set(["general-purpose"]);

describe("Structural Eval: Agent References", () =>
{
	let agentRegistry: Map<string, string>;
	let allSubagentRefs:
	{
		name: string;
		file: string;
		line: number;
	}[];

	beforeAll(() =>
	{
		// Build agent registry: name -> file path. Claude Code registers a plugin agent under its
		// plugin plus every subdirectory below agents/ (agents/refinement/item-refiner.md is
		// "gtd:refinement:item-refiner"); neither the bare name nor "gtd:item-refiner" resolves.
		agentRegistry = new Map();
		for (const plugin of listPlugins())
		{
			const agentsDir = join(PLUGINS_DIR, plugin, "agents");
			for (const filePath of collectMarkdownFiles(agentsDir))
			{
				const name = extractAgentName(filePath);
				if (name)
				{
					const subdirs = dirname(relative(agentsDir, filePath))
						.split(sep)
						.filter((part) => part !== ".");
					agentRegistry.set([plugin, ...subdirs, name].join(":"), filePath);
				}
			}
		}
		for (const filePath of collectMarkdownFiles(join(PROJECT_ROOT, ".claude", "agents")))
		{
			const name = extractAgentName(filePath);
			if (name)
			{
				agentRegistry.set(name, filePath);
			}
		}

		// Collect all subagent_type references from commands and agents
		allSubagentRefs = [];
		const sourceFiles = [...collectComponentFiles("commands"), ...collectComponentFiles("agents")];
		for (const filePath of sourceFiles)
		{
			const analysis = parseMarkdownFile(filePath);
			for (const ref of analysis.subagentRefs)
			{
				allSubagentRefs.push(
					{
						name: ref.name,
						file: filePath.replace(`${PROJECT_ROOT}/`, ""),
						line: ref.line,
					},
				);
			}
		}
	});

	it("should find subagent_type references in commands or agents", () =>
	{
		expect(allSubagentRefs.length).toBeGreaterThan(0);
	});

	it("every subagent_type reference should resolve to an agent file", () =>
	{
		const missing: string[] = [];

		for (const ref of allSubagentRefs)
		{
			if (!agentRegistry.has(ref.name) && !BUILT_IN_AGENTS.has(ref.name))
			{
				missing.push(`  "${ref.name}" referenced at ${ref.file}:${ref.line}`);
			}
		}

		expect(missing).toStrictEqual([]);
	});

	it("every agent file should have a name: field in frontmatter", () =>
	{
		const agentFiles = collectComponentFiles("agents");
		const missingName: string[] = [];

		for (const filePath of agentFiles)
		{
			const name = extractAgentName(filePath);
			if (!name)
			{
				missingName.push(filePath.replace(`${PROJECT_ROOT}/`, ""));
			}
		}

		expect(missingName).toStrictEqual([]);
	});

	it("agent names should be unique across all agent files", () =>
	{
		const nameToFiles = new Map<string, string[]>();
		const agentFiles = collectComponentFiles("agents");

		for (const filePath of agentFiles)
		{
			const name = extractAgentName(filePath);
			if (name)
			{
				const relativePath = filePath.replace(`${PROJECT_ROOT}/`, "");
				const existing = nameToFiles.get(name) ?? [];
				existing.push(relativePath);
				nameToFiles.set(name, existing);
			}
		}

		const duplicates: string[] = [];
		for (const [name, files] of nameToFiles)
		{
			if (files.length > 1)
			{
				duplicates.push(`  "${name}" defined in:\n${files.map((f) => `    - ${f}`).join("\n")}`);
			}
		}

		expect(duplicates).toStrictEqual([]);
	});
});
