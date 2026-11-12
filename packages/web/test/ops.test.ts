import {z} from "zod";
import {describe, expect, it} from "vite-plus/test";
import {Ops} from "../src/server/ops/index.js";
import {existsSync, readdirSync, readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {defineOp, ok} from "../src/server/ops/define.js";
import type {Json, OpDefinition} from "../src/server/ops/define.js";
import type {ServerContext} from "../src/server/context.js";
import {checkOpOutputs} from "./helpers/check-op-outputs.js";

describe("ops input schemas", () => {
	/** Walk a zod schema and return the paths of every field typed z.unknown() or z.any(). */
	function looseFields(schema: z.core.$ZodType, path: string): string[] {
		if (schema instanceof z.ZodUnknown || schema instanceof z.ZodAny) {
			return [path];
		}
		if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable || schema instanceof z.ZodDefault) {
			return looseFields(schema.unwrap(), path);
		}
		if (schema instanceof z.ZodObject) {
			return Object.entries(schema.shape).flatMap(([key, field]) => looseFields(field, `${path}.${key}`));
		}
		if (schema instanceof z.ZodRecord) {
			return looseFields(schema.valueType, `${path}.*`);
		}
		if (schema instanceof z.ZodArray) {
			return looseFields(schema.element, `${path}[]`);
		}
		if (schema instanceof z.ZodUnion) {
			return schema.options.flatMap((option) => looseFields(option, path));
		}
		return [];
	}

	describe("op input schemas", () => {
		it("declare no z.unknown() or z.any() fields", () => {
			const loose = Object.entries(Ops).flatMap(([name, op]) => looseFields(op.input, name));
			expect(loose).toStrictEqual([]);
		});
	});
});

describe("ops no hono", () => {
	const opsDir = fileURLToPath(new URL("../src/server/ops/", import.meta.url));

	function sourceFiles(dir: string): string[] {
		return readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
			const full = `${dir}${entry.name}`;
			return entry.isDirectory() ? sourceFiles(`${full}/`) : [full];
		});
	}

	describe("host-neutral ops", () => {
		it("do not import hono", () => {
			const offenders = existsSync(opsDir)
				? sourceFiles(opsDir).filter((file) =>
						/from\s+["']hono(\/[^"']*)?["']|from\s+["']@hono\//u.test(readFileSync(file, "utf8")),
					)
				: [];
			expect(offenders).toStrictEqual([]);
		});

		it("do not import cloudflare:* modules", () => {
			const offenders = existsSync(opsDir)
				? sourceFiles(opsDir).filter((file) => /from\s+["']cloudflare:/u.test(readFileSync(file, "utf8")))
				: [];
			expect(offenders).toStrictEqual([]);
		});
	});
});

describe("ops output schemas", () => {
	describe("checkOpOutputs", () => {
		const ctx = {} as ServerContext;

		it("passes a value that matches its output schema through", async () => {
			const ops = checkOpOutputs({
				count: defineOp({input: z.object({}), output: z.object({n: z.number()}), run: () => ok({n: 1})}),
			});
			await expect(Promise.resolve(ops.count.run(ctx, {}))).resolves.toStrictEqual({ok: true, value: {n: 1}});
		});

		it("throws when a value misses its output schema", () => {
			// An op whose value drifted from its schema; production would never notice.
			const drifted: OpDefinition<z.ZodType, Json> = {
				input: z.object({}),
				output: z.object({n: z.number()}),
				run: () => ok({n: "1"}),
			};
			const ops = checkOpOutputs({drifted});
			expect(() => {
				void ops.drifted.run(ctx, {});
			}).toThrow(
				'drifted output does not match its schema: [{"expected":"number","code":"invalid_type","path":["n"],"message":"Invalid input: expected number, received string"}]',
			);
		});

		it("keeps a synchronous op synchronous", () => {
			const ops = checkOpOutputs({
				count: defineOp({input: z.object({}), output: z.object({n: z.number()}), run: () => ok({n: 1})}),
			});
			expect(ops.count.run(ctx, {})).toStrictEqual({ok: true, value: {n: 1}});
		});
	});
});
