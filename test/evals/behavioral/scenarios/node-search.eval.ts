/**
 * Behavioral eval: node search command against local cache.
 *
 * Validates that `./bin/run.js node search` finds nodes that exist
 * in the SQLite cache without requiring an API key.
 */

import {beforeAll, afterAll, describe, expect, it} from "vite-plus/test";
import {z} from "zod";
import {collectCreatedFiles, createEvalContext, runInEvalContext} from "../helpers/eval-db-setup.js";
import type {EvalContext, EvalResult} from "../helpers/eval-types.js";

const SearchResultsSchema = z.array(
	z.looseObject(
		{
			shortId: z.string().nullable(),
			path: z.string(),
		},
	),
);

describe("Behavioral Eval: node search", () =>
{
	let ctx: EvalContext;

	beforeAll(() =>
	{
		ctx = createEvalContext();
	});

	afterAll(() =>
	{
		ctx.cleanup();
	});

	it(
		"should find results for a common term",
		{
			timeout: 30_000,
		},
		async () =>
		{
			const result = await runInEvalContext(ctx, './bin/run.js node search --query "Metadata" --json');

			expect(result.exitCode, `Command failed with stderr: ${result.stderr}`).toBe(0);

			// Every result should have the required fields.
			const parsed = SearchResultsSchema.parse(JSON.parse(result.stdout));
			expect(parsed.length).toBeGreaterThan(0);
		},
	);

	it(
		"should return empty array for nonsense query",
		{
			timeout: 30_000,
		},
		async () =>
		{
			const result = await runInEvalContext(
				ctx,
				'./bin/run.js node search --query "zzzznonexistent99999" --json',
			);

			expect(result.exitCode).toBe(0);

			const parsed: unknown = JSON.parse(result.stdout);
			expect(Array.isArray(parsed)).toBe(true);
			expect(parsed).toHaveLength(0);
		},
	);

	it(
		"should respect --limit flag",
		{
			timeout: 30_000,
		},
		async () =>
		{
			const result = await runInEvalContext(ctx, './bin/run.js node search --query "a" --limit 3 --json');

			expect(result.exitCode, `Command failed with stderr: ${result.stderr}`).toBe(0);

			const parsed = SearchResultsSchema.parse(JSON.parse(result.stdout));
			expect(parsed.length).toBeLessThanOrEqual(3);
		},
	);

	it(
		"should produce valid EvalResult shape",
		{
			timeout: 30_000,
		},
		async () =>
		{
			const result = await runInEvalContext(ctx, './bin/run.js node search --query "Inbox" --json');
			const files = collectCreatedFiles(ctx);

			const evalResult: EvalResult =
			{
				exitCode: result.exitCode,
				filesCreated: files,
				stderr: result.stderr,
				stdout: result.stdout,
			};

			expect(evalResult.exitCode).toBe(0);
			expect(evalResult.stdout).toBeTypeOf("string");
			expect(evalResult.stderr).toBeTypeOf("string");
			expect(evalResult.filesCreated).toBeTypeOf("object");
		},
	);
});
