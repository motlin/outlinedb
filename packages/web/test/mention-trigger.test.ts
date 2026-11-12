import {describe, expect, it} from "vite-plus/test";
import
{
	MENTION_CHIP_CLASS,
	planMentionOpen,
	planMentionRearm,
	stripMentionChip,
} from "../src/client/mention-trigger.js";

describe("planMentionOpen", () =>
{
	it("wraps only the @ for a spaced symbol", () =>
	{
		expect([
			planMentionOpen("a @", 2),
			planMentionOpen("mail@", 4),
			planMentionOpen("@x", 0),
			planMentionOpen("a\t@b", 2),
			planMentionOpen("ab@cd", 2),
		]).toStrictEqual([
			{
				start: 2,
				end: 3,
			},
			{
				start: 4,
				end: 5,
			},
			{
				start: 0,
				end: 1,
			},
			{
				start: 2,
				end: 3,
			},
			null,
		]);
	});
});

describe("planMentionRearm", () =>
{
	it("re-wraps a resting @tag from its @ to the caret, and nothing else", () =>
	{
		expect([
			planMentionRearm("X @md", 5),
			planMentionRearm("@md", 3),
			planMentionRearm("mail@md", 7),
			planMentionRearm("X md", 4),
			planMentionRearm("X @md y", 7),
		]).toStrictEqual([
			{
				start: 2,
				end: 5,
			},
			{
				start: 0,
				end: 3,
			},
			null,
			null,
			null,
		]);
	});
});

describe("stripMentionChip", () =>
{
	it("unwraps a live chip to its text", () =>
	{
		expect([MENTION_CHIP_CLASS, stripMentionChip('x <span class="mention-input">@md</span>')]).toStrictEqual([
			"mention-input",
			"x @md",
		]);
	});
});
