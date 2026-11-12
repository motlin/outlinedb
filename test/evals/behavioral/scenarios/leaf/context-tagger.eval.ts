/**
 * Tier 1 leaf eval: context-tagger agent.
 *
 * Tests the context-tagger agent suggests location/mode context tags.
 * Requires the claude CLI (runs on the subscription login) and the prompt file to exist.
 */

import {assert, beforeAll, afterAll, describe, expect, it} from "vite-plus/test";
import fs from "node:fs";
import path from "node:path";
import {z} from "zod";
import {createEvalContext} from "../../helpers/eval-db-setup.js";
import type {EvalContext} from "../../helpers/eval-types.js";
import {runLlmEval, claudeCliAvailable} from "../../helpers/llm-eval-harness.js";

// suggestions is optional; each entry is a tag string, or an object naming it by `tag` or `context`.
const ContextTaggerResponseSchema = z.looseObject(
	{
		suggestions: z
			.array(
				z.union([
					z.string(),
					z.looseObject(
						{
							tag: z.string(),
						},
					),
					z.looseObject(
						{
							context: z.string(),
						},
					),
				]),
			)
			.nullish(),
	},
);

describe(
	"Leaf Eval: context-tagger",
	{
		timeout: 300_000,
	},
	() =>
	{
		let ctx: EvalContext;
		let skipSuite = false;
		const agentFile = "plugins/gtd/prompts/refinement/context-tagger.md";

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

		it("should suggest context tags from known set", async (context) =>
		{
			if (skipSuite)
			{
				context.skip();
			}

			const result = await runLlmEval(
				agentFile,
				`Analyze this item for context tags:\nID: test-item-1\nName: Call dentist to schedule appointment`,
				ctx,
				{
					maxTurns: 15,
				},
			);

			const response = result.finalResponse;
			const jsonMatch = response.match(/\{[\s\S]*\}/u);
			assert(jsonMatch, "Response should contain JSON");

			expect(() => ContextTaggerResponseSchema.parse(JSON.parse(jsonMatch[0]))).not.toThrow();
		});
	},
);
