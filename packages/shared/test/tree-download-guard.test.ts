import {globSync, readFileSync} from "node:fs";
import {join, resolve} from "node:path";
import {describe, expect, it} from "vite-plus/test";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");

/** Every non-test source file, with its text, keyed by its path from the repo root whatever the working directory. */
function sources():
{
	file: string;
	text: string;
}[]
{
	return globSync(
		"packages/*/src/**/*.{ts,tsx}",
		{
			cwd: REPO_ROOT,
			exclude: (name) => name === "node_modules",
		},
	)
		.filter((file) => !file.endsWith(".generated.ts"))
		.toSorted()
		.map((file) => (
		{
			file,
			text: readFileSync(join(REPO_ROOT, file), "utf8"),
		}));
}

/** The files whose text matches `pattern`. */
function filesMatching(pattern: RegExp): string[]
{
	return sources()
		.filter(({text}) => pattern.test(text))
		.map(({file}) => file);
}

describe("whole-tree downloads (get_tree_data, about 54 MB live)", () =>
{
	it("are read whole only by the CLI's batch imports and manual probe, never in the Worker", () =>
	{
		expect(filesMatching(/getTreeSnapshot\(/u)).toStrictEqual([
			// CLI `cache import-api`: an explicit batch import.
			"packages/cli/src/commands/cache/import-api.ts",
			// CLI `cache sync-node`: an explicit batch import.
			"packages/cli/src/commands/cache/sync-node.ts",
			// CLI `internal probe`: a manual, sandbox-only diagnostic.
			"packages/cli/src/commands/internal/probe.ts",
			// The definition.
			"packages/shared/src/api/workflowy-internal-client.ts",
		]);
	});

	it("are streamed item by item only by the per-account import, the one download the Worker makes", () =>
	{
		expect(filesMatching(/streamTreeData\(/u)).toStrictEqual([
			// The per-account import, started only by the account's own POST /api/v1/workflowy-import.
			"packages/cloudflare/src/workflowy-import.ts",
			// The definition, which getTreeSnapshot also reads through.
			"packages/shared/src/api/workflowy-internal-client.ts",
		]);
	});

	it("are requested from /get_tree_data/ only by streamTreeData", () =>
	{
		const requests = sources().flatMap(({file, text}) =>
			text.split("\n").flatMap((line, index, lines) =>
			{
				if (!/\(\s*["'`]\/get_tree_data\//u.test(line))
				{
					return [];
				}
				const method = lines
					.slice(0, index + 1)
					.toReversed()
					.map((candidate) => /^\t(?:(?:private|public|static|async)\s+)*(\w+)\(/u.exec(candidate)?.[1])
					.find((name) => name !== undefined);
				return [`${file} ${method}`];
			}),
		);
		expect(requests).toStrictEqual(["packages/shared/src/api/workflowy-internal-client.ts streamTreeData"]);
	});

	it("have no expanded-keys-only reader left", () =>
	{
		expect(filesMatching(/getExpandedKeys/u)).toStrictEqual([]);
	});
});
