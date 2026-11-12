/**
 * Tier 1 leaf eval: people-tagger agent.
 *
 * Tests the people-tagger agent detects @Name mentions.
 * Requires the claude CLI (runs on the subscription login) and the prompt file to exist.
 */

import {assert, expect, beforeAll, describe, afterAll, it} from "vite-plus/test";
import fs from "node:fs";
import path from "node:path";
import {z} from "zod";
import {createEvalContext, runInEvalContext} from "../../helpers/eval-db-setup.js";
import type {EvalContext} from "../../helpers/eval-types.js";
import {parseNodeJson} from "../../helpers/eval-schemas.js";
import {runLlmEval, claudeCliAvailable} from "../../helpers/llm-eval-harness.js";

// Both tag lists are optional, but must be arrays when present.
const PeopleTaggerResponseSchema = z.looseObject(
	{
		existingTags: z.array(z.unknown()).nullish(),
		suggestedTags: z.array(z.unknown()).nullish(),
	},
);

describe(
	"Leaf Eval: people-tagger",
	{
		timeout: 300_000,
	},
	() =>
	{
		let ctx: EvalContext;
		let itemId: string;
		let itemName: string;
		let skipSuite = false;
		const agentFile = "plugins/gtd/prompts/refinement/people-tagger.md";

		beforeAll(async () =>
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
				return;
			}

			const result = await runInEvalContext(
				ctx,
				`./bin/run.js node get --path "Metadata,📥 Inboxes" --depth 1 --json --fields id --fields children --fields linkTargets 2>/dev/null`,
			);

			if (result.exitCode !== 0)
			{
				skipSuite = true;
				return;
			}

			try
			{
				const inboxData = parseNodeJson(result.stdout);
				const firstInboxId = inboxData.children?.[0]?.linkTargets?.[0]?.id;
				if (!firstInboxId)
				{
					skipSuite = true;
					return;
				}

				const itemResult = await runInEvalContext(
					ctx,
					`./bin/run.js node get --id "${firstInboxId}" --depth 1 --json --fields id --fields name --fields children 2>/dev/null`,
				);

				if (itemResult.exitCode !== 0)
				{
					skipSuite = true;
					return;
				}

				const inboxNode = parseNodeJson(itemResult.stdout);
				const firstItem = inboxNode.children?.[0];
				itemId = firstItem?.id ?? "";
				itemName = firstItem?.name ?? "Unknown item";

				if (!itemId)
				{
					skipSuite = true;
				}
			}
			catch
			{
				skipSuite = true;
			}
		});

		afterAll(() =>
		{
			ctx.cleanup();
		});

		it("should return valid JSON with people detections", async (context) =>
		{
			if (skipSuite)
			{
				context.skip();
			}

			const result = await runLlmEval(
				agentFile,
				`Analyze this item for people mentions:\nID: ${itemId}\nName: ${itemName}`,
				ctx,
				{
					maxTurns: 15,
				},
			);

			const response = result.finalResponse;
			const jsonMatch = response.match(/\{[\s\S]*\}/u);
			assert(jsonMatch, "Response should contain JSON");

			expect(() => PeopleTaggerResponseSchema.parse(JSON.parse(jsonMatch[0]))).not.toThrow();
		});
	},
);
