import fs from "node:fs";
import {builtinModules} from "node:module";
import path from "node:path";
import {z} from "zod";

export const WEB_ROOT = path.resolve(import.meta.dirname, "..");
const SHARED_ROOT = path.resolve(WEB_ROOT, "../shared");

const sharedPackage = z
	.object(
		{
			exports: z.partialRecord(
				z.string(),
				z.object(
					{
						source: z.string(),
					},
				),
			),
		},
	)
	.parse(JSON.parse(fs.readFileSync(path.join(SHARED_ROOT, "package.json"), "utf8")));
const sharedExports = sharedPackage.exports;

const BUILTINS = new Set(builtinModules);

/** Runtime import specifiers in one module; `import type` / `export type` are erased and skipped. */
function runtimeSpecifiers(source: string): string[]
{
	const specifiers: string[] = [];
	const staticImport = /^\s*(?:import|export)\s+(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/gmu;
	for (const [statement, specifier] of source.matchAll(staticImport))
	{
		if (!/^\s*(?:import|export)\s+type\s/u.test(statement))
		{
			specifiers.push(specifier);
		}
	}
	for (const [, specifier] of source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/gu))
	{
		specifiers.push(specifier);
	}
	return specifiers;
}

function resolveFile(base: string): string | undefined
{
	const stem = base.replace(/\.(js|jsx|ts|tsx)$/u, "");
	return [".ts", ".tsx", "/index.ts", "/index.tsx", ""]
		.map((suffix) => stem + suffix)
		.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
}

/** Local file for a specifier, or undefined for third-party packages and assets outside the graph. */
function resolveSpecifier(specifier: string, importer: string): string | undefined
{
	if (specifier.startsWith("."))
	{
		return resolveFile(path.resolve(path.dirname(importer), specifier));
	}
	if (specifier === "@outlinedb/shared" || specifier.startsWith("@outlinedb/shared/"))
	{
		const subpath = `.${specifier.slice("@outlinedb/shared".length)}`;
		const entry = sharedExports[subpath];
		if (entry === undefined)
		{
			throw new Error(`${importer} imports unexported ${specifier}`);
		}
		return path.join(SHARED_ROOT, entry.source);
	}
	return undefined;
}

/** Every runtime import reachable from the entry, as "importer -> specifier", split into Node builtins and third-party packages. */
export function importsReachableFrom(entry: string):
{
	builtins: string[];
	packages: string[];
}
{
	const builtins: string[] = [];
	const packages: string[] = [];
	const seen = new Set<string>();
	const queue = [entry];
	for (let file = queue.pop(); file !== undefined; file = queue.pop())
	{
		if (seen.has(file) || !/\.(ts|tsx)$/u.test(file))
		{
			continue;
		}
		seen.add(file);
		for (const specifier of runtimeSpecifiers(fs.readFileSync(file, "utf8")))
		{
			const label = `${path.relative(path.resolve(WEB_ROOT, ".."), file)} -> ${specifier}`;
			if (specifier.startsWith("node:") || BUILTINS.has(specifier))
			{
				builtins.push(label);
				continue;
			}
			const resolved = resolveSpecifier(specifier, file);
			if (resolved === undefined)
			{
				packages.push(label);
			}
			else
			{
				queue.push(resolved);
			}
		}
	}
	return {
		builtins,
		packages,
	};
}

/** Every `node:*` or bare Node builtin import reachable from the entry, as "importer -> specifier". */
export function nodeImportsReachableFrom(entry: string): string[]
{
	const offenders: string[] = [];
	const seen = new Set<string>();
	const queue = [entry];
	for (let file = queue.pop(); file !== undefined; file = queue.pop())
	{
		if (seen.has(file) || !/\.(ts|tsx)$/u.test(file))
		{
			continue;
		}
		seen.add(file);
		for (const specifier of runtimeSpecifiers(fs.readFileSync(file, "utf8")))
		{
			if (specifier.startsWith("node:") || BUILTINS.has(specifier))
			{
				offenders.push(`${path.relative(path.resolve(WEB_ROOT, ".."), file)} -> ${specifier}`);
				continue;
			}
			const resolved = resolveSpecifier(specifier, file);
			if (resolved !== undefined)
			{
				queue.push(resolved);
			}
		}
	}
	return offenders;
}
