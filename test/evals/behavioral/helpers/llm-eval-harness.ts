/**
 * LLM eval harness for behavioral evals.
 *
 * Runs headless Claude Code (`claude -p`) on the user's subscription login, the same way the gtd
 * orchestrators launch their subagents, and parses the stream-json output into tool calls and a
 * subagent tree for assertion. Subagents are real Claude Code `general-purpose` agents.
 *
 * User, project, and local settings (hooks, plugins, permissions) and MCP servers are ignored so
 * a run depends only on this repo. Each run's working directory is the eval's temp dir, which
 * holds its own `.llm/` and a `bin` symlink back to the repo CLI.
 */

import {execFile, execFileSync} from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type {CapturedToolCall, EvalContext, LlmEvalResult} from "./eval-types.js";
import {parseStreamJson, stringInput} from "./stream-json.js";

export type {CapturedToolCall, LlmEvalResult} from "./eval-types.js";

/** Options for running an LLM eval. */
export interface LlmEvalOptions
{
	/** Maximum top-level agentic turns before Claude Code stops (default: 10) */
	maxTurns?: number;
	/** Model alias or id (default: sonnet, matching how the orchestrators launch gtd prompts) */
	model?: string;
	/** Kill the run after this long (default: 10 minutes) */
	timeoutMs?: number;
}

let cliAvailable: boolean | undefined;

/** True when the `claude` CLI is on PATH; LLM evals skip otherwise. */
export function claudeCliAvailable(): boolean
{
	if (cliAvailable === undefined)
	{
		try
		{
			execFileSync(
				"claude",
				["--version"],
				{
					stdio: "ignore",
					timeout: 30_000,
				},
			);
			cliAvailable = true;
		}
		catch
		{
			cliAvailable = false;
		}
	}
	return cliAvailable;
}

/**
 * The message a run starts from, mirroring production:
 * - `plugins/<plugin>/prompts/<p>.md` gets the orchestrators' launch prompt
 * - `plugins/<plugin>/commands/<a>/<b>.md` becomes the slash command `/<plugin>:<a>:<b>`
 */
function launchMessage(projectRoot: string, agentFile: string, task: string): string
{
	const [, plugin, kind, ...rest] = agentFile.replace(/\.md$/u, "").split("/");
	if (plugin === undefined)
	{
		throw new Error(`Agent file path has no plugin segment: ${agentFile}`);
	}
	const pluginRoot = path.join(projectRoot, "plugins", plugin);
	if (kind === "prompts")
	{
		return `CLAUDE_PLUGIN_ROOT=${pluginRoot}. Read ${pluginRoot}/prompts/${rest.join("/")}.md and follow it. ${task}`;
	}
	if (kind === "commands")
	{
		return `/${[plugin, ...rest].join(":")} ${task}`.trim();
	}
	throw new Error(`Unsupported eval target: ${agentFile}`);
}

/**
 * Run one eval: start `agentFile` with `task` in headless Claude Code and capture what it did.
 *
 * @param agentFile - Repo-relative prompt or command file, e.g. `plugins/gtd/prompts/refinement/url-linker.md`
 * @param task - The task text appended to the launch message (e.g. "Refine item <ID>")
 * @param ctx - The eval context with database and environment
 * @param options - Turn, model, and timeout limits
 */
export async function runLlmEval(
	agentFile: string,
	task: string,
	ctx: EvalContext,
	options: LlmEvalOptions = {},
): Promise<LlmEvalResult>
{
	const args = [
		"-p",
		launchMessage(ctx.projectRoot, agentFile, task),
		"--output-format",
		"stream-json",
		"--verbose",
		"--model",
		options.model ?? "sonnet",
		"--max-turns",
		String(options.maxTurns ?? 10),
		"--setting-sources",
		"",
		"--strict-mcp-config",
		"--permission-mode",
		"bypassPermissions",
		"--no-session-persistence",
		"--append-system-prompt",
		`This is an eval run. Your working directory is ${ctx.workDir}: its .llm/ holds this run's files and ./bin/run.js is the CLI. Never cd into ${ctx.projectRoot} or write under it.`,
		"--add-dir",
		ctx.projectRoot,
		...["gtd", "workflowy"].flatMap((plugin) => ["--plugin-dir", path.join(ctx.projectRoot, "plugins", plugin)]),
	];

	const env: Record<string, string | undefined> =
	{
		...process.env,
		...ctx.env,
	};
	// An API key would bill the API instead of the subscription login
	delete env.ANTHROPIC_API_KEY;
	if ((ctx.mockServerPort ?? 0) === 0)
	{
		delete env.WORKFLOWY_API_KEY;
	}

	const stdout = await new Promise<string>((resolve, reject) =>
	{
		execFile(
			"claude",
			args,
			{
				cwd: ctx.workDir,
				env,
				maxBuffer: 64 * 1024 * 1024,
				timeout: options.timeoutMs ?? 600_000,
			},
			(error, out, stderr) =>
			{
				// --max-turns exits non-zero but still streams a result event worth asserting on
				if (error && !out.includes('"type":"result"'))
				{
					reject(new Error(`claude -p failed: ${error.message}\n${stderr}`));
				}
				else
				{
					resolve(out);
				}
			},
		);
	});

	// Set EVAL_STREAM_LOG to a directory to keep each run's raw stream for debugging
	if (process.env.EVAL_STREAM_LOG)
	{
		fs.mkdirSync(
			process.env.EVAL_STREAM_LOG,
			{
				recursive: true,
			},
		);
		const name = `${path.basename(agentFile, ".md")}-${Date.now()}.jsonl`;
		fs.writeFileSync(path.join(process.env.EVAL_STREAM_LOG, name), stdout);
	}

	return parseStreamJson(stdout);
}

/**
 * Extract bash commands from captured tool calls.
 */
export function extractBashCommands(toolCalls: CapturedToolCall[]): string[]
{
	return toolCalls.filter((tc) => tc.name === "Bash").map((tc) => stringInput(tc, "command"));
}

/**
 * Extract subagent launches from captured tool calls. `promptFile` is the gtd prompt the launch
 * points at (e.g. `refinement/project-tagger`), since every gtd launch is `general-purpose`.
 */
export function extractSubagentLaunches(toolCalls: CapturedToolCall[]):
{
	subagentType: string;
	prompt: string;
	promptFile: string | undefined;
}[]
{
	return toolCalls
		.filter((tc) => tc.name === "Agent" || tc.name === "Task")
		.map((tc) =>
		{
			const prompt = stringInput(tc, "prompt");
			return {
				subagentType: stringInput(tc, "subagent_type") || "general-purpose",
				prompt,
				promptFile: /prompts\/([\w/-]+)\.md/u.exec(prompt)?.[1],
			};
		});
}

export {flattenSubagentExecutions, stringInput} from "./stream-json.js";
