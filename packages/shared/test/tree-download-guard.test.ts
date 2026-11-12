import {globSync, readFileSync} from "node:fs";
import {describe, expect, it} from "vite-plus/test";

/** Every non-test source file, with its text. */
function sources():
{
	file: string;
	text: string;
}[]
{
	return globSync(
		"packages/*/src/**/*.{ts,tsx}",
		{
			exclude: (name) => name === "node_modules",
		},
	)
		.filter((file) => !file.endsWith(".generated.ts"))
		.toSorted()
		.map((file) => (
		{
			file,
			text: readFileSync(file, "utf8"),
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
	it("are read only by the batch imports, the explicit Cloudflare seed and the manual probe", () =>
	{
		expect(filesMatching(/getTreeSnapshot\(/u)).toStrictEqual([
			// CLI `cache import-api`: an explicit batch import.
			"packages/cli/src/commands/cache/import-api.ts",
			// CLI `cache sync-node`: an explicit batch import.
			"packages/cli/src/commands/cache/sync-node.ts",
			// CLI `internal probe`: a manual, sandbox-only diagnostic.
			"packages/cli/src/commands/internal/probe.ts",
			// The Cloudflare reseed, reached only through POST /api/admin/seed.
			"packages/cloudflare/src/user-store.ts",
			// The definition.
			"packages/shared/src/api/workflowy-internal-client.ts",
		]);
	});

	it("are requested from /get_tree_data/ only by getTreeSnapshot", () =>
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
		expect(requests).toStrictEqual(["packages/shared/src/api/workflowy-internal-client.ts getTreeSnapshot"]);
	});

	it("have no expanded-keys-only reader left", () =>
	{
		expect(filesMatching(/getExpandedKeys/u)).toStrictEqual([]);
	});
});
