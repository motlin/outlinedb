import type {z} from "zod";
import type {ServerContext} from "../context.js";

export type Json =
	| null
	| boolean
	| number
	| string
	| Json[]
	|
	  {
			[key: string]: Json;
	  };

export type OpFailureStatus = 400 | 403 | 404 | 409 | 422 | 500 | 503;

/** Response details an op can ask the HTTP layer for; the op itself never builds a Response. */
export interface OpMeta
{
	created?: true;
	etag?: string;
	notModified?: true;
	redirect?: string;
	timing?: string[];
}

/** Errors are values, not exceptions: Workers RPC keeps only the message of a thrown error. */
export type OpResult<T> =
	|
	  {
			ok: true;
			value: T;
			meta?: OpMeta;
	  }
	|
	  {
			ok: false;
			status: OpFailureStatus;
			body: Json;
	  };

export function ok<T extends Json>(value: T, meta?: OpMeta): OpResult<T>
{
	return meta === undefined
		?
			{
				ok: true,
				value,
			}
		:
			{
				ok: true,
				value,
				meta,
			};
}

export function fail(status: OpFailureStatus, body: Json): OpResult<never>
{
	return {
		ok: false,
		status,
		body,
	};
}

export interface OpDefinition<S extends z.ZodType, T extends Json>
{
	input: S;
	/** The value's shape. Tests parse every op's value against it; production never does. */
	output: z.ZodType<T>;
	run(ctx: ServerContext, input: z.output<S>): OpResult<T> | Promise<OpResult<T>>;
}

/** An op whose value type comes from its output schema. */
export type TypedOpDefinition<S extends z.ZodType, O extends z.ZodType<Json>> = OpDefinition<S, z.output<O>> &
{
	output: O;
};

export function defineOp<S extends z.ZodType, O extends z.ZodType<Json>>(
	definition: TypedOpDefinition<S, O>,
): TypedOpDefinition<S, O>
{
	return definition;
}

/** A value's shape after a JSON round trip: Dates become strings. */
export type Jsonify<T> = T extends Date
	? string
	: T extends Json
		? T
		: T extends readonly (infer U)[]
			? Jsonify<U>[]
			: T extends object
				? {[K in keyof T]: Jsonify<T[K]>}
				: never;

/** Narrows a value built from Dates and interfaces to {@link Json} by serializing it, as `c.json` did. */
function jsonOf(value: unknown): Json
{
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion, unicorn/prefer-structured-clone -- structuredClone would keep Dates; the JSON round trip is the point
	return JSON.parse(JSON.stringify(value)) as Json;
}

/** {@link jsonOf} that keeps the value's type, so an op with an output schema can return it. */
export function toJson<T>(value: T): Jsonify<T>
{
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the JSON round trip produces exactly Jsonify<T>
	return jsonOf(value) as Jsonify<T>;
}
