/**
 * Tier 1 leaf eval: url-linker agent.
 *
 * Tests the url-linker agent extracts URLs and provenance.
 * Requires the claude CLI (runs on the subscription login) and the prompt file to exist.
 */

import {assert, beforeAll, afterAll, describe, expect, it} from "vite-plus/test";
import fs from "node:fs";
import path from "node:path";
import {z} from "zod";
import {createEvalContext} from "../../helpers/eval-db-setup.js";
import type {EvalContext} from "../../helpers/eval-types.js";
import {runLlmEval, claudeCliAvailable} from "../../helpers/llm-eval-harness.js";

// urls is optional, but must be a non-empty array when present.
const UrlLinkerResponseSchema = z.looseObject(
	{
		urls: z.array(z.unknown()).nonempty().nullish(),
	},
);

describe(
	"Leaf Eval: url-linker",
	{
		timeout: 300_000,
	},
	() =>
	{
		let ctx: EvalContext;
		let skipSuite = false;
		const agentFile = "plugins/gtd/prompts/refinement/url-linker.md";

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

		it("should extract URLs from item text", async (context) =>
		{
			if (skipSuite)
			{
				context.skip();
			}

			const result = await runLlmEval(
				agentFile,
				`Analyze this item for URLs:\nID: test-item-1\nName: Read article https://example.com/article-about-productivity`,
				ctx,
				{
					maxTurns: 15,
				},
			);

			const response = result.finalResponse;
			const jsonMatch = response.match(/\{[\s\S]*\}/u);
			assert(jsonMatch, "Response should contain JSON");

			expect(() => UrlLinkerResponseSchema.parse(JSON.parse(jsonMatch[0]))).not.toThrow();
		});
	},
);
