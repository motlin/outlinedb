import {globSync, readFileSync} from "node:fs";
import {join, resolve} from "node:path";
import {describe, expect, it} from "vite-plus/test";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");

/** A `sql` template that opens with a statement keyword: a whole statement written as raw SQL. */
const RAW_STATEMENT = /\bsql`\s*(?:SELECT|INSERT|UPDATE|DELETE|WITH|REPLACE)\b/giu;

/** How many raw SQL statements each non-test source file holds, keyed by its path from the repo root. */
function rawStatementCounts(): Record<string, number>
{
	const counts = globSync(
		"packages/*/src/**/*.{ts,tsx}",
		{
			cwd: REPO_ROOT,
			exclude: (name) => name === "node_modules",
		},
	)
		.filter((file) => !file.endsWith(".generated.ts"))
		.toSorted()
		.map((file) => [file, readFileSync(join(REPO_ROOT, file), "utf8").match(RAW_STATEMENT)?.length ?? 0] as const)
		.filter(([, count]) => count > 0);
	return Object.fromEntries(counts);
}

describe("raw SQL statements", () =>
{
	it("appear only where Drizzle cannot express them, each with a comment saying why", () =>
	{
		expect(rawStatementCounts()).toStrictEqual(
			{
				// sqlite_master is not in the Drizzle schema.
				"packages/cli/src/commands/cache/temporal-rollback.ts": 1,
				// Drizzle names a CTE's computed column without its CTE, ambiguous across the query's joins.
				"packages/cli/src/commands/calendar/fix-photo-groups.ts": 1,
				// sqlite_master and the FTS5 virtual table node_fts are not in the Drizzle schema.
				"packages/cli/src/services/embedding-generator.ts": 3,
				// FTS5 MATCH and rank on node_fts.
				"packages/cli/src/services/search.ts": 1,
				// An insert from json_each: Drizzle's insert binds every value, past a Durable Object's parameter cap.
				"packages/shared/src/cache/node-tags.ts": 1,
				// total_changes(), a select without a FROM table.
				"packages/web/src/server/node-events.ts": 1,
				// Recursive CTEs.
				"packages/web/src/server/ops/search.ts": 1,
				"packages/web/src/server/ops/tag-index.ts": 2,
				// The recursive subtree CTE, its json_each seeds, and total_changes().
				"packages/web/src/server/tree-snapshot.ts": 4,
				"packages/web/src/server/view-tree.ts": 1,
			},
		);
	});
});
