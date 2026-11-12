// Run: node --test plugins/gtd/scripts/scan-review-feedback.test.mts
/* eslint-disable @typescript-eslint/no-floating-promises -- node:test test() calls are fire-and-forget by design */
import {test} from "node:test";
import assert from "node:assert/strict";
import
{
	askAnswerText,
	assistantSummary,
	extractFeedback,
	hasCommandInvocation,
	isAskUserQuestionAnswer,
	isHumanUserMessage,
	projectDirFor,
	userText,
} from "./scan-review-feedback.mts";
import {at} from "./test-helpers.mts";

const humanTyped =
{
	type: "user",
	timestamp: "2026-06-23T22:15:18.000Z",
	message:
	{
		role: "user",
		content: "you didn't complete the reminders",
	},
};

const humanTypedBlockArray =
{
	type: "user",
	timestamp: "2026-06-23T22:16:00.000Z",
	message:
	{
		role: "user",
		content: [
			{
				type: "text",
				text: "we ALWAYS work on the skill first",
			},
		],
	},
};

const toolResultEcho =
{
	type: "user",
	timestamp: "2026-06-23T22:15:20.000Z",
	message:
	{
		role: "user",
		content: [
			{
				type: "tool_result",
				tool_use_id: "x",
				content: "big tool output",
			},
		],
	},
};

const commandStub =
{
	type: "user",
	timestamp: "2026-06-23T22:00:00.000Z",
	message:
	{
		role: "user",
		content: "<command-name>/gtd:review:daily</command-name>",
	},
};

const assistantToolUse =
{
	type: "assistant",
	timestamp: "2026-06-23T22:15:10.000Z",
	message:
	{
		role: "assistant",
		content: [
			{
				type: "text",
				text: "Marking the reminders complete now.",
			},
			{
				type: "tool_use",
				name: "Bash",
				input:
				{
					command: "osascript -e ...",
				},
			},
		],
	},
};

test("hasCommandInvocation matches only the requested command stub", () =>
{
	assert.deepStrictEqual(
		[
			"<command-name>/gtd:review:daily</command-name>",
			"available skill: gtd:review:daily performs the morning review",
			"<command-name>/gtd:review:daily:overview</command-name>",
		].map((raw) => hasCommandInvocation(raw, "gtd:review:daily")),
		[true, false, false],
	);
});

test("isHumanUserMessage accepts typed text (string and text-block array)", () =>
{
	assert.strictEqual(isHumanUserMessage(humanTyped), true);
	assert.strictEqual(isHumanUserMessage(humanTypedBlockArray), true);
});

test("isHumanUserMessage rejects tool-result echoes and slash-command stubs", () =>
{
	assert.strictEqual(isHumanUserMessage(toolResultEcho), false);
	assert.strictEqual(isHumanUserMessage(commandStub), false);
	assert.strictEqual(isHumanUserMessage(assistantToolUse), false);
});

test("isHumanUserMessage rejects harness-injected and synthetic user lines", () =>
{
	// isMeta marks command-body / skill-injection expansions, not human input.
	assert.strictEqual(
		isHumanUserMessage(
			{
				type: "user",
				isMeta: true,
				message:
				{
					role: "user",
					content: [
						{
							type: "text",
							text: "# Daily Review\n\nRun the full review",
						},
					],
				},
			},
		),
		false,
	);
	// Sidechain = subagent transcript, not the user.
	assert.strictEqual(
		isHumanUserMessage(
			{
				type: "user",
				isSidechain: true,
				message:
				{
					role: "user",
					content: "hello from a subagent",
				},
			},
		),
		false,
	);
	// A user line carrying toolUseResult is a tool echo even if shaped oddly.
	assert.strictEqual(
		isHumanUserMessage(
			{
				type: "user",
				toolUseResult: {},
				message:
				{
					role: "user",
					content: "output",
				},
			},
		),
		false,
	);
	// The interrupt marker is synthetic.
	assert.strictEqual(
		isHumanUserMessage(
			{
				type: "user",
				message:
				{
					role: "user",
					content: [
						{
							type: "text",
							text: "[Request interrupted by user for tool use]",
						},
					],
				},
			},
		),
		false,
	);
});

test("userText pulls a clean string from either content shape", () =>
{
	assert.strictEqual(userText(humanTyped), "you didn't complete the reminders");
	assert.strictEqual(userText(humanTypedBlockArray), "we ALWAYS work on the skill first");
});

test("assistantSummary names the tools/commands the assistant just ran", () =>
{
	const s = assistantSummary(assistantToolUse);
	assert.match(s, /Bash/u);
	assert.match(s, /osascript/u);
});

test("extractFeedback returns human turns with the preceding assistant action, in order", () =>
{
	const objs = [commandStub, assistantToolUse, humanTyped, toolResultEcho, humanTypedBlockArray];
	const {turns} = extractFeedback(objs);
	assert.strictEqual(turns.length, 2);
	assert.strictEqual(at(turns, 0).text, "you didn't complete the reminders");
	assert.match(at(turns, 0).prevAssistant, /Bash/u);
	assert.strictEqual(at(turns, 1).text, "we ALWAYS work on the skill first");
	assert.strictEqual(at(turns, 0).ts, "2026-06-23T22:15:18.000Z");
});

test("extractFeedback keeps only turns at or after the cutoff, not whole sessions", () =>
{
	const before =
	{
		type: "user",
		timestamp: "2026-07-21T10:00:00.000Z",
		message:
		{
			role: "user",
			content: "old turn from an earlier review",
		},
	};
	const after =
	{
		type: "user",
		timestamp: "2026-07-24T10:00:00.000Z",
		message:
		{
			role: "user",
			content: "the new correction",
		},
	};
	const cutoff = Date.parse("2026-07-23T00:00:00.000Z");
	const {turns} = extractFeedback(
		[before, assistantToolUse, after],
		{
			cutoff,
		},
	);
	assert.deepStrictEqual(
		turns.map((t) => t.text),
		["the new correction"],
	);
});

test("extractFeedback without a cutoff keeps every turn", () =>
{
	const {turns} = extractFeedback([humanTyped, humanTypedBlockArray]);
	assert.strictEqual(turns.length, 2);
});

test("extractFeedback keeps turns whose timestamp is missing", () =>
{
	const undated =
	{
		type: "user",
		message:
		{
			role: "user",
			content: "undated but real",
		},
	};
	const {turns} = extractFeedback(
		[undated],
		{
			cutoff: Date.parse("2026-07-23T00:00:00.000Z"),
		},
	);
	assert.deepStrictEqual(
		turns.map((t) => t.text),
		["undated but real"],
	);
});

const askAnswer =
{
	type: "user",
	timestamp: "2026-07-26T17:15:33.000Z",
	toolUseResult: {},
	message:
	{
		role: "user",
		content: [
			{
				type: "tool_result",
				tool_use_id: "q1",
				content: 'The user answered: "Skip any prep tasks?"="figure out why it\'s broken"',
			},
		],
	},
};

const askAnswerMulti =
{
	type: "user",
	timestamp: "2026-07-26T17:20:00.000Z",
	toolUseResult: {},
	message:
	{
		role: "user",
		content: [
			{
				type: "tool_result",
				tool_use_id: "q2",
				content:
					'Your questions have been answered: "Skip set A"="Run all three", "Skip set B"="Run all three"',
			},
		],
	},
};

// Bash output that merely quotes the phrase must not be mistaken for an answer.
const bashEcho =
{
	type: "user",
	timestamp: "2026-07-26T17:21:00.000Z",
	toolUseResult: {},
	message:
	{
		role: "user",
		content: [
			{
				type: "tool_result",
				tool_use_id: "b1",
				content: String.raw`{"txt":"RESULT:The user answered: \"something\"=\"else\""}`,
			},
		],
	},
};

test("isAskUserQuestionAnswer recognizes both answer prefixes", () =>
{
	assert.strictEqual(isAskUserQuestionAnswer(askAnswer), true);
	assert.strictEqual(isAskUserQuestionAnswer(askAnswerMulti), true);
});

test("isAskUserQuestionAnswer rejects tool output that merely quotes the phrase", () =>
{
	assert.strictEqual(isAskUserQuestionAnswer(bashEcho), false);
	assert.strictEqual(isAskUserQuestionAnswer(toolResultEcho), false);
	assert.strictEqual(isAskUserQuestionAnswer(humanTyped), false);
});

test("askAnswerText returns the raw answer payload", () =>
{
	assert.match(askAnswerText(askAnswer) ?? "", /figure out why it's broken/u);
	assert.match(askAnswerText(askAnswerMulti) ?? "", /Run all three/u);
	assert.strictEqual(askAnswerText(bashEcho), null);
});

test("extractFeedback captures AskUserQuestion answers as turns, marked by source", () =>
{
	const {turns} = extractFeedback([assistantToolUse, humanTyped, askAnswer]);
	assert.strictEqual(turns.length, 2);
	assert.strictEqual(at(turns, 0).source, "typed");
	assert.strictEqual(at(turns, 1).source, "ask");
	assert.match(at(turns, 1).text, /figure out why it's broken/u);
	assert.strictEqual(at(turns, 1).ts, "2026-07-26T17:15:33.000Z");
});

test("extractFeedback caps very long turn text so the extract stays compact", () =>
{
	const long =
	{
		type: "user",
		timestamp: "2026-06-23T23:00:00.000Z",
		message:
		{
			role: "user",
			content: "x".repeat(5000),
		},
	};
	const {turns} = extractFeedback([long]);
	assert.ok(at(turns, 0).text.length <= 2050);
	assert.match(at(turns, 0).text, /…$/u);
});

test("projectDirFor encodes the cwd the way Claude Code names transcript directories", () =>
{
	assert.strictEqual(
		projectDirFor(["", "home", "alice", "projects", "my.repo"].join("/")).endsWith(
			".claude/projects/-home-alice-projects-my-repo",
		),
		true,
	);
});
