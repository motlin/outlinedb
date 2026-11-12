import {describe, expect, it} from "vite-plus/test";
import {existsSync, readFileSync} from "node:fs";
import {join, relative} from "node:path";
import {PLUGINS_DIR, PROJECT_ROOT, collectMarkdownFiles} from "./helpers/scan-roots.js";

// gtd subagents are prompt files, not registered agents: every registered agent's description is
// loaded into context on every session, and these are only ever spawned by the gtd orchestrators.
// Orchestrators launch `general-purpose` and point it at `${CLAUDE_PLUGIN_ROOT}/prompts/<path>.md`.
const GTD_DIR = join(PLUGINS_DIR, "gtd");
const PROMPTS_DIR = join(GTD_DIR, "prompts");
const PROMPT_REF = /\bprompts\/([\w/-]+\.md)/gu;

function promptRefs():
{
	path: string;
	at: string;
}[]
{
	const refs:
	{
		path: string;
		at: string;
	}[] = [];
	for (const filePath of collectMarkdownFiles(GTD_DIR))
	{
		const lines = readFileSync(filePath, "utf8").split("\n");
		for (const [index, line] of lines.entries())
		{
			for (const match of line.matchAll(PROMPT_REF))
			{
				const [, refPath] = match;
				if (refPath !== undefined)
				{
					refs.push(
						{
							path: refPath,
							at: `${relative(PROJECT_ROOT, filePath)}:${index + 1}`,
						},
					);
				}
			}
		}
	}
	return refs;
}

describe("Structural Eval: gtd prompt agents", () =>
{
	it("the gtd plugin registers no agents", () =>
	{
		expect(collectMarkdownFiles(join(GTD_DIR, "agents")).map((f) => relative(PROJECT_ROOT, f))).toStrictEqual([]);
	});

	it("every prompts/ reference resolves to a prompt file", () =>
	{
		const missing = promptRefs()
			.filter((ref) => !existsSync(join(PROMPTS_DIR, ref.path)))
			.map((ref) => `${ref.path} referenced at ${ref.at}`);
		expect(missing).toStrictEqual([]);
	});

	it("every prompt file is referenced somewhere", () =>
	{
		const referenced = new Set(promptRefs().map((ref) => ref.path));
		const orphans = collectMarkdownFiles(PROMPTS_DIR)
			.map((f) => relative(PROMPTS_DIR, f))
			.filter((p) => !referenced.has(p));
		expect(orphans).toStrictEqual([]);
	});

	it("no command or prompt still spawns a gtd agent by subagent_type", () =>
	{
		const offenders: string[] = [];
		for (const filePath of [
			...collectMarkdownFiles(GTD_DIR),
			...collectMarkdownFiles(join(PLUGINS_DIR, "workflowy")),
		])
		{
			const lines = readFileSync(filePath, "utf8").split("\n");
			for (const [index, line] of lines.entries())
			{
				if (
					/subagent_type:\s*["']gtd:|`gtd:(capture|journal|refinement|shared|legacy:fetchers)(:[\w-]+)+`/u.test(
						line,
					)
				)
				{
					offenders.push(`${relative(PROJECT_ROOT, filePath)}:${index + 1}`);
				}
			}
		}
		expect(offenders).toStrictEqual([]);
	});
});
