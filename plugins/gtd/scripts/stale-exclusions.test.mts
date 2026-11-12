// Run: node --test plugins/gtd/scripts/stale-exclusions.test.mts
/* eslint-disable @typescript-eslint/no-floating-promises -- node:test test() calls are fire-and-forget by design */
import {test} from "node:test";
import assert from "node:assert/strict";
import {parseSkipPaths, selectStalePaths} from "./stale-exclusions.mts";

test("selectStalePaths keeps only missing paths under the root, sorted", () =>
{
	const skipPaths = ["/r/b/target", "/r/a/node_modules", "/r/live/dist", "/elsewhere/gone/target", "/rx/gone/target"];
	const exists = (path: string): boolean => path === "/r/live/dist";
	assert.deepStrictEqual(selectStalePaths(skipPaths, "/r", exists), ["/r/a/node_modules", "/r/b/target"]);
});

test("selectStalePaths returns nothing when every path exists", () =>
{
	assert.deepStrictEqual(
		selectStalePaths(["/r/a/dist"], "/r", () => true),
		[],
	);
});

test("parseSkipPaths reads `defaults read` array output, quoted or bare, and tolerates absence", () =>
{
	const output = '(\n    "/r/with space/target",\n    /r/bare/dist,\n    "/r/last/build"\n)\n';
	assert.deepStrictEqual(parseSkipPaths(output), ["/r/with space/target", "/r/bare/dist", "/r/last/build"]);
	assert.deepStrictEqual(parseSkipPaths(""), []);
});
