import {readFileSync} from "node:fs";
import {z} from "zod";

const sharedRoot = new URL("../../../shared/", import.meta.url);

const SharedPackageSchema = z.object(
	{
		exports: z.record(
			z.string(),
			z.object(
				{
					source: z.string(),
					import: z.string(),
				},
			),
		),
	},
);

/**
 * Lists the @outlinedb/shared subpaths that the caller's resolver loads from somewhere other than the source entry,
 * such as the gitignored dist build. `importPackage` must run the import from the calling test file so the
 * resolution under test is that package's, not this helper's.
 */
export async function subpathsNotLoadedFromSource(
	importPackage: (specifier: string) => Promise<unknown>,
): Promise<string[]>
{
	const {exports} = SharedPackageSchema.parse(JSON.parse(readFileSync(new URL("package.json", sharedRoot), "utf8")));
	const mismatches: string[] = [];
	for (const [subpath, entry] of Object.entries(exports))
	{
		const specifier = `@outlinedb/shared${subpath.slice(1)}`;
		const viaPackage = await importPackage(specifier);
		const viaSource: unknown = await import(new URL(entry.source, sharedRoot).href);
		if (viaPackage !== viaSource)
		{
			mismatches.push(specifier);
		}
	}
	return mismatches;
}
