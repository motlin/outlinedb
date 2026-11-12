/**
 * Tier 1 leaf eval: destination-guesser agent.
 *
 * Tests the destination-guesser agent reads tagger results and produces
 * a destination recommendation with valid JSON structure.
 * Requires the claude CLI (runs on the subscription login) and the prompt file to exist.
 */

import {assert, expect, beforeAll, describe, afterAll, it} from "vite-plus/test";
import fs from "node:fs";
import path from "node:path";
import {z} from "zod";
import {createEvalContext, runInEvalContext} from "../../helpers/eval-db-setup.js";
import type {EvalContext} from "../../helpers/eval-types.js";
import {parseNodeJson} from "../../helpers/eval-schemas.js";
import {extractBashCommands, runLlmEval, claudeCliAvailable} from "../../helpers/llm-eval-harness.js";

const DestinationResponseSchema = z.looseObject(
	{
		confidence: z.unknown(),
	},
);

describe(
	"Leaf Eval: destination-guesser",
	{
		timeout: 300_000,
	},
	() =>
	{
		let ctx: EvalContext;
		let itemId: string;
		let skipSuite = false;
		const agentFile = "plugins/gtd/prompts/refinement/destination-guesser.md";

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

				if (!itemId)
				{
					skipSuite = true;
					return;
				}

				// Write simulated tagger results
				const taggerResults =
				{
					itemId,
					itemName: firstItem?.name ?? "Test item",
					projectTagger:
					{
						project: null,
						confidence: 0,
					},
					peopleTagger:
					{
						people: [],
						confidence: 0,
					},
					dueDateDetector:
					{
						date: null,
						confidence: 0,
					},
					urlLinker:
					{
						urls: [],
						provenance: null,
					},
					contextTagger:
					{
						contexts: ["#home"],
						confidence: 0.7,
					},
					tagCleaner:
					{
						invalidTags: [],
						validTags: [],
					},
				};

				const llmDir = path.join(ctx.llmDir, "gtd", "refinement");
				fs.mkdirSync(
					llmDir,
					{
						recursive: true,
					},
				);
				fs.writeFileSync(path.join(llmDir, `${itemId}.json`), JSON.stringify(taggerResults, null, 2));
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

		it("should produce destination recommendation with a confidence level", async (context) =>
		{
			if (skipSuite)
			{
				context.skip();
			}

			const result = await runLlmEval(
				agentFile,
				`Determine destination for item ${itemId}`,
				ctx,
				{
					maxTurns: 25,
				},
			);

			const response = result.finalResponse;
			const jsonMatch = response.match(/\{[\s\S]*"(?:path|targetId|confidence)"[\s\S]*\}/u);
			assert(jsonMatch, "Response should contain JSON with destination fields");

			const parsed = DestinationResponseSchema.parse(JSON.parse(jsonMatch[0]));
			expect(["high", "medium", "low"]).toContain(parsed.confidence);
		});

		it("should use CLI to query node data", async (context) =>
		{
			if (skipSuite)
			{
				context.skip();
			}

			const result = await runLlmEval(
				agentFile,
				`Determine destination for item ${itemId}`,
				ctx,
				{
					maxTurns: 25,
				},
			);

			const bashCommands = extractBashCommands(result.toolCalls);
			const cliCommands = bashCommands.filter((cmd) => cmd.includes("bin/run.js"));
			expect(cliCommands.length, "Should use CLI commands for node queries").toBeGreaterThan(0);
		});
	},
);
