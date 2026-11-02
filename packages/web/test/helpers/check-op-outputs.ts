import type {z} from "zod";
import type {Json, OpDefinition, OpResult} from "../../src/server/ops/define.js";

function checked(name: string, output: z.ZodType, result: OpResult<Json>): OpResult<Json>
{
	if (result.ok)
	{
		const parsed = output.safeParse(result.value);
		if (!parsed.success)
		{
			throw new Error(`${name} output does not match its schema: ${JSON.stringify(parsed.error.issues)}`);
		}
	}
	return result;
}

/**
 * Wraps each op's `run` in place so a successful value is parsed against the op's output schema, throwing on a
 * mismatch. Tests only: production never parses outputs. A synchronous op stays synchronous.
 */
export function checkOpOutputs<R extends Record<string, OpDefinition<z.ZodType, Json>>>(ops: R): R
{
	for (const [name, op] of Object.entries(ops))
	{
		const {output} = op;
		const run = op.run.bind(op);
		op.run = (ctx, input): OpResult<Json> | Promise<OpResult<Json>> =>
		{
			const result = run(ctx, input);
			return result instanceof Promise
				? result.then((settled) => checked(name, output, settled))
				: checked(name, output, result);
		};
	}
	return ops;
}
