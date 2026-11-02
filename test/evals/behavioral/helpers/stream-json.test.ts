import {describe, expect, it} from "vite-plus/test";
import {parseStreamJson} from "./stream-json.js";

const usage = (input: number, output: number) => (
{
	input_tokens: input,
	cache_creation_input_tokens: 10,
	cache_read_input_tokens: 100,
	output_tokens: output,
});

// Shape of `claude -p --output-format stream-json --verbose`: the top-level agent reads a file,
// launches one subagent, and the subagent runs one Bash command.
const EVENTS = [
	{
		type: "system",
		subtype: "init",
	},
	{
		type: "assistant",
		parent_tool_use_id: null,
		message:
		{
			usage: usage(1, 5),
			content: [
				{
					type: "tool_use",
					id: "tu_read",
					name: "Read",
					input:
					{
						file_path: "/repo/a.md",
					},
				},
			],
		},
	},
	{
		type: "user",
		parent_tool_use_id: null,
		message:
		{
			content: [
				{
					type: "tool_result",
					tool_use_id: "tu_read",
					content: "file body",
				},
			],
		},
	},
	{
		type: "assistant",
		parent_tool_use_id: null,
		message:
		{
			usage: usage(1, 7),
			content: [
				{
					type: "text",
					text: "Launching.",
				},
				{
					type: "tool_use",
					id: "tu_agent",
					name: "Agent",
					input:
					{
						subagent_type: "general-purpose",
						model: "sonnet",
						prompt: "Tag item abc",
					},
				},
			],
		},
	},
	{
		type: "system",
		subtype: "task_started",
	},
	{
		type: "user",
		parent_tool_use_id: "tu_agent",
		message:
		{
			content: [
				{
					type: "text",
					text: "Tag item abc",
				},
			],
		},
	},
	{
		type: "assistant",
		parent_tool_use_id: "tu_agent",
		message:
		{
			usage: usage(2, 3),
			content: [
				{
					type: "tool_use",
					id: "tu_bash",
					name: "Bash",
					input:
					{
						command: "echo hi",
					},
				},
			],
		},
	},
	{
		type: "user",
		parent_tool_use_id: "tu_agent",
		message:
		{
			content: [
				{
					type: "tool_result",
					tool_use_id: "tu_bash",
					content: [
						{
							type: "text",
							text: "hi",
						},
					],
				},
			],
		},
	},
	{
		type: "assistant",
		parent_tool_use_id: "tu_agent",
		message:
		{
			usage: usage(0, 0),
			content: [
				{
					type: "text",
					text: '{"tag":null}',
				},
			],
		},
	},
	{
		type: "user",
		parent_tool_use_id: null,
		message:
		{
			content: [
				{
					type: "tool_result",
					tool_use_id: "tu_agent",
					content: [
						{
							type: "text",
							text: 'Hand-back: {"tag":null}',
						},
					],
				},
			],
		},
	},
	{
		type: "assistant",
		parent_tool_use_id: null,
		message:
		{
			usage: usage(1, 4),
			content: [
				{
					type: "text",
					text: "All done.",
				},
			],
		},
	},
	{
		type: "result",
		subtype: "success",
		result: "All done.",
		usage: usage(4, 16),
	},
];

const toLines = (events: unknown[]) => events.map((event) => JSON.stringify(event)).join("\n");

describe("parseStreamJson", () =>
{
	it("builds top-level tool calls, the subagent tree, and token totals", () =>
	{
		expect(parseStreamJson(toLines(EVENTS))).toStrictEqual(
			{
				toolCalls: [
					{
						name: "Read",
						input:
						{
							file_path: "/repo/a.md",
						},
						result: "file body",
					},
					{
						name: "Agent",
						input:
						{
							subagent_type: "general-purpose",
							model: "sonnet",
							prompt: "Tag item abc",
						},
						result: 'Hand-back: {"tag":null}',
					},
				],
				finalResponse: "All done.",
				inputTokens: 114,
				outputTokens: 16,
				stopReason: "success",
				subagentExecutions: [
					{
						agentName: "general-purpose",
						prompt: "Tag item abc",
						result:
						{
							toolCalls: [
								{
									name: "Bash",
									input:
									{
										command: "echo hi",
									},
									result: "hi",
								},
							],
							finalResponse: '{"tag":null}',
							inputTokens: 222,
							outputTokens: 3,
							stopReason: "success",
							subagentExecutions: [],
						},
					},
				],
			},
		);
	});

	it("reports a run cut off by --max-turns and ignores non-JSON noise", () =>
	{
		const events = [
			{
				type: "assistant",
				parent_tool_use_id: null,
				message:
				{
					usage: usage(1, 2),
					content: [
						{
							type: "text",
							text: "Partial.",
						},
					],
				},
			},
			{
				type: "result",
				subtype: "error_max_turns",
				usage: usage(1, 2),
			},
		];
		expect(parseStreamJson(`warning: something\n${toLines(events)}\n`)).toStrictEqual(
			{
				toolCalls: [],
				finalResponse: "Partial.",
				inputTokens: 111,
				outputTokens: 2,
				stopReason: "error_max_turns",
				subagentExecutions: [],
			},
		);
	});
});
