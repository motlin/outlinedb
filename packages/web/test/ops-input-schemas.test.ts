import {z} from "zod";
import {describe, expect, it} from "vite-plus/test";
import {Ops} from "../src/server/ops/index.js";

/** Walk a zod schema and return the paths of every field typed z.unknown() or z.any(). */
function looseFields(schema: z.core.$ZodType, path: string): string[]
{
	if (schema instanceof z.ZodUnknown || schema instanceof z.ZodAny)
	{
		return [path];
	}
	if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable || schema instanceof z.ZodDefault)
	{
		return looseFields(schema.unwrap(), path);
	}
	if (schema instanceof z.ZodObject)
	{
		return Object.entries(schema.shape).flatMap(([key, field]) => looseFields(field, `${path}.${key}`));
	}
	if (schema instanceof z.ZodRecord)
	{
		return looseFields(schema.valueType, `${path}.*`);
	}
	if (schema instanceof z.ZodArray)
	{
		return looseFields(schema.element, `${path}[]`);
	}
	if (schema instanceof z.ZodUnion)
	{
		return schema.options.flatMap((option) => looseFields(option, path));
	}
	return [];
}

describe("op input schemas", () =>
{
	it("declare no z.unknown() or z.any() fields", () =>
	{
		const loose = Object.entries(Ops).flatMap(([name, op]) => looseFields(op.input, name));
		expect(loose).toStrictEqual([]);
	});
});
