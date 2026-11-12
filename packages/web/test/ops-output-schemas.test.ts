import {describe, expect, it} from "vite-plus/test";
import {z} from "zod";
import {defineOp, ok} from "../src/server/ops/define.js";
import type {Json, OpDefinition} from "../src/server/ops/define.js";
import type {ServerContext} from "../src/server/context.js";
import {checkOpOutputs} from "./helpers/check-op-outputs.js";

describe("checkOpOutputs", () =>
{
	const ctx = {} as ServerContext;

	it("passes a value that matches its output schema through", async () =>
	{
		const ops = checkOpOutputs(
			{
				count: defineOp(
					{
						input: z.object({}),
						output: z.object(
							{
								n: z.number(),
							},
						),
						run: () =>
							ok(
								{
									n: 1,
								},
							),
					},
				),
			},
		);
		await expect(Promise.resolve(ops.count.run(ctx, {}))).resolves.toStrictEqual(
			{
				ok: true,
				value:
				{
					n: 1,
				},
			},
		);
	});

	it("throws when a value misses its output schema", () =>
	{
		// An op whose value drifted from its schema; production would never notice.
		const drifted: OpDefinition<z.ZodType, Json> =
		{
			input: z.object({}),
			output: z.object(
				{
					n: z.number(),
				},
			),
			run: () =>
				ok(
					{
						n: "1",
					},
				),
		};
		const ops = checkOpOutputs(
			{
				drifted,
			},
		);
		expect(() =>
		{
			void ops.drifted.run(ctx, {});
		}).toThrow(
			'drifted output does not match its schema: [{"expected":"number","code":"invalid_type","path":["n"],"message":"Invalid input: expected number, received string"}]',
		);
	});

	it("keeps a synchronous op synchronous", () =>
	{
		const ops = checkOpOutputs(
			{
				count: defineOp(
					{
						input: z.object({}),
						output: z.object(
							{
								n: z.number(),
							},
						),
						run: () =>
							ok(
								{
									n: 1,
								},
							),
					},
				),
			},
		);
		expect(ops.count.run(ctx, {})).toStrictEqual(
			{
				ok: true,
				value:
				{
					n: 1,
				},
			},
		);
	});
});
