/**
 * Parse `claude -p --output-format stream-json --verbose` output into an LlmEvalResult.
 *
 * Every event carries `parent_tool_use_id`: null for the top-level agent, or the id of the
 * `Agent` tool call whose subagent produced it. Claude Code streams only one level of subagent
 * activity, so a subagent's own subagents appear as launches without their inner tool calls.
 */

import type {CapturedToolCall, LlmEvalResult, SubagentExecution} from "./eval-types.js";

interface Usage
{
	input_tokens?: number;
	cache_creation_input_tokens?: number;
	cache_read_input_tokens?: number;
	output_tokens?: number;
}

interface ContentBlock
{
	type: string;
	id?: string;
	name?: string;
	input?: Record<string, unknown>;
	text?: string;
	tool_use_id?: string;
	content?:
		| string
		|
		  {
				type: string;
				text?: string;
		  }[];
}

interface StreamEvent
{
	type: string;
	subtype?: string;
	parent_tool_use_id?: string | null;
	result?: string;
	usage?: Usage;
	message?:
	{
		usage?: Usage;
		content?: string | ContentBlock[];
	};
}

interface Scope
{
	toolCalls: CapturedToolCall[];
	pending: Map<string, CapturedToolCall>;
	texts: string[];
	inputTokens: number;
	outputTokens: number;
	children: string[];
}

const inputTokensOf = (usage: Usage = {}) =>
	(usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);

function resultText(content: ContentBlock["content"]): string
{
	if (typeof content === "string")
	{
		return content;
	}
	return (content ?? []).map((part) => part.text ?? "").join("");
}

function isStreamEvent(value: unknown): value is StreamEvent
{
	return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}

function parseLine(line: string): StreamEvent | undefined
{
	try
	{
		const event: unknown = JSON.parse(line);
		return isStreamEvent(event) ? event : undefined;
	}
	catch
	{
		return undefined;
	}
}

/** A string-valued tool input, or '' when absent. */
export function stringInput(call: CapturedToolCall, key: string): string
{
	const value = call.input[key];
	return typeof value === "string" ? value : "";
}

export function parseStreamJson(output: string): LlmEvalResult
{
	const scopes = new Map<string | null, Scope>();
	const scopeFor = (id: string | null): Scope =>
	{
		let scope = scopes.get(id);
		if (!scope)
		{
			scope =
			{
				toolCalls: [],
				pending: new Map(),
				texts: [],
				inputTokens: 0,
				outputTokens: 0,
				children: [],
			};
			scopes.set(id, scope);
		}
		return scope;
	};
	const agentCalls = new Map<string, CapturedToolCall>();
	let final: StreamEvent | undefined;

	for (const event of output.split("\n").map(parseLine))
	{
		if (!event)
		{
			continue;
		}
		if (event.type === "result")
		{
			final = event;
			continue;
		}
		if (event.type !== "assistant" && event.type !== "user")
		{
			continue;
		}

		const scope = scopeFor(event.parent_tool_use_id ?? null);
		const content = event.message?.content;
		if (!Array.isArray(content))
		{
			continue;
		}

		if (event.type === "assistant")
		{
			scope.inputTokens += inputTokensOf(event.message?.usage);
			scope.outputTokens += event.message?.usage?.output_tokens ?? 0;
		}

		for (const block of content)
		{
			if (event.type === "assistant" && block.type === "text" && block.text)
			{
				scope.texts.push(block.text);
			}
			else if (block.type === "tool_use" && block.id && block.name)
			{
				const call: CapturedToolCall =
				{
					name: block.name,
					input: block.input ?? {},
					result: "",
				};
				scope.toolCalls.push(call);
				scope.pending.set(block.id, call);
				if (block.name === "Agent" || block.name === "Task")
				{
					agentCalls.set(block.id, call);
					scope.children.push(block.id);
				}
			}
			else if (block.type === "tool_result" && block.tool_use_id)
			{
				const call = scope.pending.get(block.tool_use_id);
				if (call)
				{
					call.result = resultText(block.content);
				}
			}
		}
	}

	const executionsOf = (scope: Scope): SubagentExecution[] =>
		scope.children.flatMap((id) =>
		{
			const call = agentCalls.get(id);
			if (call === undefined)
			{
				return [];
			}
			const child = scopeFor(id);
			return {
				agentName: stringInput(call, "subagent_type") || "general-purpose",
				prompt: stringInput(call, "prompt"),
				result:
				{
					toolCalls: child.toolCalls,
					// The Agent tool result wraps the report in hand-back framing; prefer the subagent's own words
					finalResponse: child.texts.at(-1) ?? call.result,
					inputTokens: child.inputTokens,
					outputTokens: child.outputTokens,
					stopReason: call.result ? "success" : "incomplete",
					subagentExecutions: executionsOf(child),
				},
			} satisfies SubagentExecution;
		});

	const top = scopeFor(null);
	return {
		toolCalls: top.toolCalls,
		finalResponse: final?.result ?? top.texts.at(-1) ?? "",
		inputTokens: final?.usage ? inputTokensOf(final.usage) : top.inputTokens,
		outputTokens: final?.usage?.output_tokens ?? top.outputTokens,
		stopReason: final?.subtype ?? "incomplete",
		subagentExecutions: executionsOf(top),
	};
}

/**
 * Flatten the subagent execution tree into a flat list.
 * Useful for assertions that want to check all subagents at any depth.
 */
export function flattenSubagentExecutions(executions: SubagentExecution[]): SubagentExecution[]
{
	return executions.flatMap((exec) => [exec, ...flattenSubagentExecutions(exec.result.subagentExecutions)]);
}
