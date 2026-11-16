import {globSync, readFileSync} from "node:fs";
import {join, matchesGlob, resolve} from "node:path";
import {describe, expect, it} from "vite-plus/test";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");

describe("vitest project includes", () =>
{
	it("cover every test file under packages/*/test", () =>
	{
		const configSource = readFileSync(join(REPO_ROOT, "vitest.config.ts"), "utf8");
		const includes = [...configSource.matchAll(/include:\s*\[([^\]]*)\]/gu)].flatMap((match) =>
			[...(match[1] ?? "").matchAll(/"([^"]+)"/gu)].map((pattern) => pattern[1] ?? ""),
		);
		const testFiles = globSync(
			"packages/*/test/**/*.test.*",
			{
				cwd: REPO_ROOT,
				exclude: (name) => name === "node_modules",
			},
		);
		const uncovered = testFiles
			.filter((file) => !file.endsWith(".snap") && !includes.some((pattern) => matchesGlob(file, pattern)))
			.toSorted();
		expect(includes.length).toBeGreaterThan(0);
		expect(uncovered).toStrictEqual([]);
	});
});
