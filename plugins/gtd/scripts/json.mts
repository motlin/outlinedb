// Narrowing helpers for JSON read from disk or stdin, so scripts never hold an `any`.
import {readFileSync} from "node:fs";

export type JsonObject = Record<string, unknown>;

/** Parse JSON text as `unknown`; callers narrow it with the guards below. */
export function parseJson(text: string): unknown
{
	return JSON.parse(text);
}

/** Read and parse a JSON file as `unknown`. */
export function readJsonFile(path: string): unknown
{
	return parseJson(readFileSync(path, "utf8"));
}

export function isObject(value: unknown): value is JsonObject
{
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The value as an object, or throw naming `what`. */
export function expectObject(value: unknown, what: string): JsonObject
{
	if (!isObject(value))
	{
		throw new TypeError(`${what} must be a JSON object`);
	}
	return value;
}

/** The value as an array, or throw naming `what`. */
export function expectArray(value: unknown, what: string): unknown[]
{
	if (!Array.isArray(value))
	{
		throw new TypeError(`${what} must be a JSON array`);
	}
	return value;
}

/** A string field, or undefined when absent or not a string. */
export function stringField(object: JsonObject, key: string): string | undefined
{
	const value = object[key];
	return typeof value === "string" ? value : undefined;
}

/** A number field, or undefined when absent or not a number. */
export function numberField(object: JsonObject, key: string): number | undefined
{
	const value = object[key];
	return typeof value === "number" ? value : undefined;
}

/** An array field, or an empty array when absent or not an array. */
export function arrayField(object: JsonObject, key: string): unknown[]
{
	const value = object[key];
	return Array.isArray(value) ? value : [];
}

/** The error's message, for anything a `catch` clause can receive. */
export function errorMessage(error: unknown): string
{
	return error instanceof Error ? error.message : String(error);
}
