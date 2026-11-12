/**
 * Tier 2 orchestrator eval: item-refiner agent.
 *
 * Tests the item-refiner agent end to end. Validates:
 * - The item is fetched first
 * - Phase A tagger prompts are applied inline, with no nested subagents
 *
 * Requires the claude CLI (runs on the subscription login).
 */

import {expect, beforeAll, describe, afterAll, it} from "vite-plus/test";
import {createEvalContext, runInEvalContext} from "../../helpers/eval-db-setup.js";
import type {EvalContext} from "../../helpers/eval-types.js";
import {parseNodeJson} from "../../helpers/eval-schemas.js";
import
{
	extractBashCommands,
	extractSubagentLaunches,
	flattenSubagentExecutions,
	runLlmEval,
	claudeCliAvailable,
	stringInput,
} from "../../helpers/llm-eval-harness.js";
import {createMockWorkflowyServer} from "../../helpers/mock-workflowy-server.js";
import type {MockWorkflowyServer} from "../../helpers/mock-workflowy-server.js";

describe(
	"Orchestrator Eval: item-refiner",
	{
		timeout: 600_000,
	},
	() =>
	{
		let ctx: EvalContext;
		let itemId: string;
		let mockServer: MockWorkflowyServer;
		let skipSuite = false;
		const agentFile = "plugins/gtd/prompts/refinement/item-refiner.md";

		beforeAll(async () =>
		{
			if (!claudeCliAvailable())
			{
				skipSuite = true;
				return;
			}

			// Start mock server for write-through operations
			mockServer = createMockWorkflowyServer();
			await mockServer.start();

			ctx = createEvalContext(
				{
					mockServerPort: mockServer.port,
				},
			);

			// Find an inbox item from the eval database
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
					`./bin/run.js node get --id "${firstInboxId}" --depth 1 --json --fields id --fields children 2>/dev/null`,
				);

				if (itemResult.exitCode !== 0)
				{
					skipSuite = true;
					return;
				}

				const inboxNode = parseNodeJson(itemResult.stdout);
				itemId = inboxNode.children?.[0]?.id ?? "";
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

		afterAll(async () =>
		{
			await mockServer.stop();
			ctx.cleanup();
		});

		it("should fetch item data as first action", async (context) =>
		{
			if (skipSuite)
			{
				context.skip();
			}

			// Reading the prompt and skill files takes the first turns
			const result = await runLlmEval(
				agentFile,
				`Refine item ${itemId}`,
				ctx,
				{
					maxTurns: 6,
				},
			);

			const bashCommands = extractBashCommands(result.toolCalls);
			expect(bashCommands.length).toBeGreaterThan(0);

			const firstCommand = bashCommands[0];
			expect(firstCommand).toContain("node");
			expect(firstCommand).toContain(itemId);
		});

		it("should apply tagger prompts inline without launching subagents", async (context) =>
		{
			if (skipSuite)
			{
				context.skip();
			}

			const result = await runLlmEval(
				agentFile,
				`Refine item ${itemId}`,
				ctx,
				{
					maxTurns: 12,
				},
			);

			const readPaths = result.toolCalls
				.filter((call) => call.name === "Read")
				.map((call) => stringInput(call, "file_path"));
			const expectedTaggers = ["project-tagger", "people-tagger", "due-date-detector", "context-tagger"];
			const readTaggers = expectedTaggers.filter((tagger) => readPaths.some((path) => path.includes(tagger)));

			expect(
				readTaggers.length,
				`Expected to read tagger prompts inline. Read: ${readPaths.join(", ")}`,
			).toBeGreaterThanOrEqual(2);
			expect(extractSubagentLaunches(result.toolCalls)).toStrictEqual([]);
		});

		it("should track token usage in a single conversation", async (context) =>
		{
			if (skipSuite)
			{
				context.skip();
			}

			const result = await runLlmEval(
				agentFile,
				`Refine item ${itemId}`,
				ctx,
				{
					maxTurns: 10,
				},
			);

			expect(result.inputTokens).toBeGreaterThan(0);
			expect(result.outputTokens).toBeGreaterThan(0);
			expect(flattenSubagentExecutions(result.subagentExecutions)).toStrictEqual([]);
		});
	},
);
