/**
 * Tier 1 leaf eval: text-composer agent.
 *
 * Tests the text-composer agent integrates tags into item text.
 * Requires the claude CLI (runs on the subscription login) and the prompt file to exist.
 */

import {assert, beforeAll, afterAll, describe, expect, it} from "vite-plus/test";
import fs from "node:fs";
import path from "node:path";
import {z} from "zod";
import {createEvalContext} from "../../helpers/eval-db-setup.js";
import type {EvalContext} from "../../helpers/eval-types.js";
import {runLlmEval, claudeCliAvailable} from "../../helpers/llm-eval-harness.js";

// Both fields are optional; suggestedText must be a string and tagsAdded an array when present.
const TextComposerResponseSchema = z.looseObject(
	{
		suggestedText: z.string().nullish(),
		tagsAdded: z.array(z.unknown()).nullish(),
	},
);

describe(
	"Leaf Eval: text-composer",
	{
		timeout: 300_000,
	},
	() =>
	{
		let ctx: EvalContext;
		let skipSuite = false;
		const agentFile = "plugins/gtd/prompts/refinement/text-composer.md";

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

		it("should compose text with integrated tags", async (context) =>
		{
			if (skipSuite)
			{
				context.skip();
			}

			const taggerResults =
			{
				itemId: "test-item-1",
				originalText: "Fix the login page",
				projectTagger:
				{
					suggestedTag: "#web-app",
					confidence: 0.8,
				},
				peopleTagger:
				{
					suggestedTags: ["@Alice"],
				},
				dueDateDetector:
				{
					date: null,
				},
				contextTagger:
				{
					suggestions: [
						{
							tag: "#computer",
						},
					],
				},
				destination:
				{
					path: "Next Actions",
					confidence: 0.9,
				},
			};

			const result = await runLlmEval(
				agentFile,
				`Compose final text for this item:\n${JSON.stringify(taggerResults, null, 2)}`,
				ctx,
				{
					maxTurns: 15,
				},
			);

			const response = result.finalResponse;
			const jsonMatch = response.match(/\{[\s\S]*\}/u);
			assert(jsonMatch, "Response should contain JSON");

			expect(() => TextComposerResponseSchema.parse(JSON.parse(jsonMatch[0]))).not.toThrow();
		});
	},
);
