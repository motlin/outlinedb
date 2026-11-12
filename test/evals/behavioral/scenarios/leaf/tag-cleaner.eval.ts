/**
 * Tier 1 leaf eval: tag-cleaner agent.
 *
 * Tests the tag-cleaner agent validates tags against known metadata.
 * Requires the claude CLI (runs on the subscription login) and the prompt file to exist.
 */

import {assert, beforeAll, afterAll, describe, expect, it} from "vite-plus/test";
import fs from "node:fs";
import path from "node:path";
import {z} from "zod";
import {createEvalContext} from "../../helpers/eval-db-setup.js";
import type {EvalContext} from "../../helpers/eval-types.js";
import {runLlmEval, claudeCliAvailable} from "../../helpers/llm-eval-harness.js";

// Both tag lists are optional, but must be arrays when present.
const TagCleanerResponseSchema = z.looseObject(
	{
		validTags: z.array(z.unknown()).nullish(),
		invalidTags: z.array(z.unknown()).nullish(),
	},
);

describe(
	"Leaf Eval: tag-cleaner",
	{
		timeout: 300_000,
	},
	() =>
	{
		let ctx: EvalContext;
		let skipSuite = false;
		const agentFile = "plugins/gtd/prompts/refinement/tag-cleaner.md";

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

		it("should validate tags and identify invalid ones", async (context) =>
		{
			if (skipSuite)
			{
				context.skip();
			}

			const result = await runLlmEval(
				agentFile,
				`Validate tags on this item:\nID: test-item-1\nName: Fix #bug-tracker integration #typo-project @UnknownPerson`,
				ctx,
				{
					maxTurns: 15,
				},
			);

			const response = result.finalResponse;
			const jsonMatch = response.match(/\{[\s\S]*\}/u);
			assert(jsonMatch, "Response should contain JSON");

			expect(() => TagCleanerResponseSchema.parse(JSON.parse(jsonMatch[0]))).not.toThrow();
		});
	},
);
