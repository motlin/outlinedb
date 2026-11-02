// Assertion helpers shared by the node:test suites in this directory.
import assert from "node:assert/strict";

/** The element at `index`, failing the test when the list is too short. */
export function at<T>(items: readonly T[], index: number): T
{
	const item = items[index];
	assert.ok(item !== undefined, `expected an element at index ${index} of a ${items.length}-element list`);
	return item;
}

/** The value under `key`, failing the test when the record lacks it. */
export function entry<T>(record: Readonly<Partial<Record<string, T>>>, key: string): T
{
	const value = record[key];
	assert.ok(value !== undefined, `expected a value under key ${key}`);
	return value;
}
