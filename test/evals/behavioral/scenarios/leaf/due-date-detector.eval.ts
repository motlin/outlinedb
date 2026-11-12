/**
 * Tier 1 leaf eval: due-date-detector agent.
 *
 * Tests the due-date-detector agent parses dates and urgency.
 * Requires the claude CLI (runs on the subscription login) and the prompt file to exist.
 */

import {assert, beforeAll, afterAll, describe, expect, it} from "vite-plus/test";
import fs from "node:fs";
import path from "node:path";
import {z} from "zod";
import {createEvalContext} from "../../helpers/eval-db-setup.js";
import type {EvalContext} from "../../helpers/eval-types.js";
import {runLlmEval, claudeCliAvailable} from "../../helpers/llm-eval-harness.js";

// isAsap and urgencyLevel are optional; urgencyLevel must be a string when present.
const DueDateResponseSchema = z.looseObject(
	{
		due: z.unknown(),
		isAsap: z.unknown(),
		urgencyLevel: z.string().optional(),
	},
);

describe(
	"Leaf Eval: due-date-detector",
	{
		timeout: 300_000,
	},
	() =>
	{
		let ctx: EvalContext;
		let skipSuite = false;
		const agentFile = "plugins/gtd/prompts/refinement/due-date-detector.md";

		beforeAll(() =>
		{
			if (!claudeCliAvailable())
			{
				skipSuite = true;
				return;
			}

			ctx = createEvalContext();
			const agentPath = path.join(ctx.projectRoot, agentFile);

			if (!fs.existsSync(agentPath))
			{
				skipSuite = true;
			}
		});

		afterAll(() =>
		{
			ctx.cleanup();
		});

		it("should detect date from item text with explicit deadline", async (context) =>
		{
			if (skipSuite)
			{
				context.skip();
			}

			const result = await runLlmEval(
				agentFile,
				`Analyze this item for due dates:\nID: test-item-1\nName: Submit tax return by April 15th`,
				ctx,
				{
					maxTurns: 15,
				},
			);

			const response = result.finalResponse;
			const jsonMatch = response.match(/\{[\s\S]*\}/u);
			assert(jsonMatch, "Response should contain JSON");

			const parsed = DueDateResponseSchema.parse(JSON.parse(jsonMatch[0]));
			expect(parsed.due).toMatch(/^\d{4}-04-15$/u);
		});

		it("should detect urgency keywords", async (context) =>
		{
			if (skipSuite)
			{
				context.skip();
			}

			const result = await runLlmEval(
				agentFile,
				`Analyze this item for due dates:\nID: test-item-2\nName: URGENT: Fix production server crash ASAP`,
				ctx,
				{
					maxTurns: 15,
				},
			);

			const response = result.finalResponse;
			const jsonMatch = response.match(/\{[\s\S]*\}/u);
			assert(jsonMatch, "Response should contain JSON");

			const parsed = DueDateResponseSchema.parse(JSON.parse(jsonMatch[0]));
			if (parsed.isAsap !== undefined)
			{
				expect(parsed.isAsap).toBe(true);
			}
		});
	},
);
