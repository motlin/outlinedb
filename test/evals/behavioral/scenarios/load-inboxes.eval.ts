/**
 * Behavioral eval: gtd inboxes load command against local cache.
 *
 * Validates that the `gtd inboxes load` CLI command runs against the eval database,
 * reads inbox metadata from the cache, and produces a valid gtd-inboxes.json file
 * with optional children when --depth is specified.
 *
 * The command derives PROJECT_ROOT from its own location, so .llm/ output goes
 * to the real project root. We verify the command succeeds and produces output,
 * then clean up the generated file.
 */

import {beforeAll, expect, describe, afterAll, it} from "vite-plus/test";
import fs from "node:fs";
import path from "node:path";
import {z} from "zod";
import {createEvalContext, runInEvalContext} from "../helpers/eval-db-setup.js";
import type {EvalContext} from "../helpers/eval-types.js";

// Items carry an optional children array.
const InboxesFileSchema = z.looseObject(
	{
		loadedAt: z.string(),
		itemCount: z.number(),
		inboxes: z.array(
			z.looseObject(
				{
					id: z.string(),
					name: z.string(),
					items: z.array(
						z.looseObject(
							{
								id: z.string(),
								name: z.string(),
								children: z.array(z.unknown()).optional(),
							},
						),
					),
				},
			),
		),
	},
);

describe("Behavioral Eval: gtd inboxes load", () =>
{
	let ctx: EvalContext;
	let outputFile: string;

	beforeAll(() =>
	{
		ctx = createEvalContext();
		outputFile = path.join(ctx.projectRoot, ".llm/gtd-inboxes.json");
	});

	afterAll(() =>
	{
		ctx.cleanup();
	});

	it(
		"should run without errors against the eval database",
		{
			timeout: 60_000,
		},
		async () =>
		{
			const result = await runInEvalContext(ctx, "./bin/run.js gtd inboxes load --depth 3");

			expect(result.exitCode, `Command failed with stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);
			expect(result.stdout).toContain("itemCount");
		},
	);

	it(
		"should produce a gtd-inboxes.json file with valid structure",
		{
			timeout: 60_000,
		},
		async () =>
		{
			await runInEvalContext(ctx, "./bin/run.js gtd inboxes load --depth 3");

			expect(fs.existsSync(outputFile), `Expected ${outputFile} to exist`).toBe(true);

			const content = fs.readFileSync(outputFile, "utf8");
			const data = InboxesFileSchema.parse(JSON.parse(content));

			expect(data.inboxes.length).toBeGreaterThan(0);
			expect(data.inboxes.flatMap((inbox) => inbox.items).length).toBeGreaterThan(0);
		},
	);

	it(
		"should use cache data (not require API key)",
		{
			timeout: 60_000,
		},
		async () =>
		{
			const result = await runInEvalContext(ctx, "./bin/run.js gtd inboxes load --depth 3");

			// Should succeed even without WORKFLOWY_API_KEY
			expect(result.exitCode).toBe(0);
		},
	);
});
