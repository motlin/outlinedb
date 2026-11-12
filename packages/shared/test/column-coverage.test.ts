import {readdirSync, readFileSync, statSync} from "node:fs";
import {extname, join} from "node:path";
import {assert, describe, expect, it} from "vite-plus/test";

/**
 * Phase 4c: column-coverage test — the dead-column tripwire.
 *
 * This test fails when a column defined in `schema.ts` is never referenced by
 * any read site outside of `schema.ts` itself and the migrations folder. That
 * is exactly the failure mode that produced the `nodeMetadata.cp` dead column:
 * a column was defined and written on import, but nothing downstream ever read
 * it back. Catching that statically means the next dead column is rejected
 * before it lands rather than discovered months later.
 *
 * Approach: regex-parse `schema.ts` for `sqliteTable` blocks and the column
 * property names within them, then scan the rest of the `packages/` source
 * tree for each name. A column counts as covered if it appears anywhere as a
 * property access (`.column`), an object key (`column:`), or a quoted string
 * (`"column"` or `'column'`).
 */

const currentDirectory = import.meta.dirname;
const repoRoot = join(currentDirectory, "../../..");
const packagesDirectory = join(repoRoot, "packages");
const schemaPath = join(packagesDirectory, "shared/src/db/schema.ts");

/**
 * Columns that no read site references by name, yet are still legitimately
 * read. The temporal-merge engine in `importer.ts` reads `systemFrom` and
 * `systemTo` generically — it receives the column objects as parameters rather
 * than naming them per table — so a per-table by-name scan never sees them.
 * Treating the merge engine as a generic reader for those two columns keeps
 * the test honest without weakening it for every other column.
 */
const allowlistedColumns = new Set(["systemFrom", "systemTo"]);

/**
 * `table.column` pairs whose read site lands in a later, already-planned step.
 * Clef label suggestions: the persistence step (plan
 * `.llm/plans/2026-11-04-clef-tagging-preprocessing.md`, step 5) reads
 * `labelKind` and `contentFrom`; remove these entries when it does.
 */
const pendingReadSites = new Set(["nodeLabelSuggestions.labelKind", "nodeLabelSuggestions.contentFrom"]);

interface SchemaColumn
{
	table: string;
	column: string;
}

/**
 * Extract `{table, column}` pairs from `schema.ts`. Each `export const X =
 * sqliteTable("name", { ... })` block contributes the property names declared
 * in its column-definition object, ignoring the trailing index/PK callback.
 */
function extractSchemaColumns(source: string): SchemaColumn[]
{
	const columns: SchemaColumn[] = [];
	const tablePattern = /export const (\w+) = sqliteTable\(\s*(["'])[^"']+\2,/gu;

	let match: RegExpExecArray | null;
	while ((match = tablePattern.exec(source)) !== null)
	{
		const tableConstant = match[1];
		assert(tableConstant !== undefined);
		const blockStart = source.indexOf("{", match.index + match[0].length);
		expect(blockStart, `column-definition block for ${tableConstant}`).toBeGreaterThan(-1);

		let depth = 0;
		let blockEnd = blockStart;
		for (let index = blockStart; index < source.length; index++)
		{
			const character = source[index];
			if (character === "{")
			{
				depth++;
			}
			else if (character === "}")
			{
				depth--;
				if (depth === 0)
				{
					blockEnd = index;
					break;
				}
			}
		}

		const block = source.slice(blockStart + 1, blockEnd);
		const columnPattern = /(?:^|\n)\s*(\w+):\s*(?:text|integer|blob)\(/gu;
		let columnMatch: RegExpExecArray | null;
		while ((columnMatch = columnPattern.exec(block)) !== null)
		{
			const [, column] = columnMatch;
			if (column !== undefined)
			{
				columns.push(
					{
						table: tableConstant,
						column,
					},
				);
			}
		}
	}

	return columns;
}

/**
 * Recursively collect every `.ts` file under `packages/`, skipping build
 * output (`dist`), dependencies (`node_modules`), the migrations folder, the
 * schema file itself, and test files. A column referenced only by a migration
 * or by a test does not count as a real downstream read site.
 */
function collectSourceFiles(): string[]
{
	const skipDirectories = new Set(["node_modules", "dist", "migrations", "test"]);
	const files: string[] = [];

	const walk = (directory: string): void =>
	{
		for (const entry of readdirSync(directory))
		{
			const entryPath = join(directory, entry);
			if (statSync(entryPath).isDirectory())
			{
				if (!skipDirectories.has(entry))
				{
					walk(entryPath);
				}
			}
			else if (extname(entry) === ".ts" && entryPath !== schemaPath)
			{
				files.push(entryPath);
			}
		}
	};

	walk(packagesDirectory);
	return files;
}

describe("column coverage", () =>
{
	it("every schema column is referenced by a read site outside migrations", () =>
	{
		const schemaSource = readFileSync(schemaPath, "utf8");
		const schemaColumns = extractSchemaColumns(schemaSource);

		expect(schemaColumns.length).toBeGreaterThan(0);

		const sourceFiles = collectSourceFiles();
		expect(sourceFiles.length).toBeGreaterThan(0);

		const sourceText = sourceFiles.map((file) => readFileSync(file, "utf8")).join("\n");

		const deadColumns = schemaColumns.filter(({table, column}) =>
		{
			if (allowlistedColumns.has(column) || pendingReadSites.has(`${table}.${column}`))
			{
				return false;
			}
			const referencePattern = new RegExp(`[.'"]${column}\\b|\\b${column}:`, "u");
			return !referencePattern.test(sourceText);
		});

		const deadColumnNames = deadColumns.map(({table, column}) => `${table}.${column}`);
		expect(deadColumnNames, "columns defined in schema.ts with no downstream read site").toStrictEqual([]);
	});
});
