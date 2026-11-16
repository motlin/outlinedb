// Run: node --test plugins/gtd/scripts/plugin-cache-fresh.test.mts
/* eslint-disable @typescript-eslint/no-floating-promises -- node:test test() calls are fire-and-forget by design */
import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdirSync, mkdtempSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {stalePaths} from "./plugin-cache-fresh.mts";

function tree(files: Record<string, string>): string
{
	const root = mkdtempSync(join(tmpdir(), "plugin-cache-fresh-"));
	for (const [path, content] of Object.entries(files))
	{
		mkdirSync(
			dirname(join(root, path)),
			{
				recursive: true,
			},
		);
		writeFileSync(join(root, path), content);
	}
	return root;
}

test("stalePaths is empty when the cache matches the marketplace source, ignoring Claude Code's .in_use markers", () =>
{
	const source = tree(
		{
			"commands/daily-import.md": "same",
			"scripts/compute-llm-dag.mts": "same",
		},
	);
	const cache = tree(
		{
			"commands/daily-import.md": "same",
			"scripts/compute-llm-dag.mts": "same",
			".in_use/session-1": "",
		},
	);
	assert.deepStrictEqual(stalePaths(cache, source), []);
});

test("stalePaths lists every changed, added, and removed file in sorted order", () =>
{
	const source = tree(
		{
			"commands/daily-import.md": "new",
			"scripts/is-main.mts": "added upstream",
			"skills/same.md": "same",
		},
	);
	const cache = tree(
		{
			"commands/daily-import.md": "old",
			"scripts/removed.mts": "deleted upstream",
			"skills/same.md": "same",
		},
	);
	assert.deepStrictEqual(stalePaths(cache, source), [
		"commands/daily-import.md",
		"scripts/is-main.mts",
		"scripts/removed.mts",
	]);
});
