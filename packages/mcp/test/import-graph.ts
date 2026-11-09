import fs from "node:fs";
import {builtinModules} from "node:module";
import path from "node:path";
import {z} from "zod";

export const MCP_ROOT = path.resolve(import.meta.dirname, "..");
const PACKAGES_ROOT = path.resolve(MCP_ROOT, "..");

const packageJson = z.object({
	name: z.string(),
	exports: z.partialRecord(z.string(), z.object({source: z.string()})),
});

/** Source file behind every `@outlinedb/*` package export, keyed by the full specifier. */
function workspaceExports(): Map<string, string> {
	const sources = new Map<string, string>();
	for (const dir of fs.readdirSync(PACKAGES_ROOT)) {
		const manifest = path.join(PACKAGES_ROOT, dir, "package.json");
		if (!fs.existsSync(manifest)) {
			continue;
		}
		const parsed = packageJson.safeParse(JSON.parse(fs.readFileSync(manifest, "utf8")));
		if (!parsed.success) {
			continue;
		}
		for (const [subpath, entry] of Object.entries(parsed.data.exports)) {
			if (entry !== undefined) {
				sources.set(parsed.data.name + subpath.slice(1), path.join(PACKAGES_ROOT, dir, entry.source));
			}
		}
	}
	return sources;
}

const BUILTINS = new Set(builtinModules);

/** Runtime import specifiers in one module; `import type` / `export type` are erased and skipped. */
function runtimeSpecifiers(source: string): string[] {
	const specifiers: string[] = [];
	const staticImport = /^\s*(?:import|export)\s+(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/gmu;
	for (const [statement, specifier] of source.matchAll(staticImport)) {
		if (specifier !== undefined && !/^\s*(?:import|export)\s+type\s/u.test(statement)) {
			specifiers.push(specifier);
		}
	}
	for (const [, specifier] of source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/gu)) {
		if (specifier !== undefined) {
			specifiers.push(specifier);
		}
	}
	return specifiers;
}

function resolveFile(base: string): string | undefined {
	const stem = base.replace(/\.(js|jsx|ts|tsx)$/u, "");
	return [".ts", ".tsx", "/index.ts", "/index.tsx", ""]
		.map((suffix) => stem + suffix)
		.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
}

export interface ImportGraph {
	/** Every local file reached, relative to `packages/`. */
	files: string[];
	/** `node:*` or bare Node builtin imports, as "importer -> specifier". */
	builtins: string[];
	/** Third-party package imports, as "importer -> specifier". */
	packages: string[];
}

/** Every runtime import reachable from the entry, following relative and `@outlinedb/*` imports across packages. */
export function importGraphFrom(entry: string): ImportGraph {
	const exports = workspaceExports();
	const graph: ImportGraph = {files: [], builtins: [], packages: []};
	const seen = new Set<string>();
	const queue = [entry];
	for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
		if (seen.has(file) || !/\.(ts|tsx)$/u.test(file)) {
			continue;
		}
		seen.add(file);
		const relative = path.relative(PACKAGES_ROOT, file);
		graph.files.push(relative);
		for (const specifier of runtimeSpecifiers(fs.readFileSync(file, "utf8"))) {
			const label = `${relative} -> ${specifier}`;
			if (specifier.startsWith("node:") || BUILTINS.has(specifier)) {
				graph.builtins.push(label);
			} else if (specifier.startsWith(".")) {
				const resolved = resolveFile(path.resolve(path.dirname(file), specifier));
				if (resolved !== undefined) {
					queue.push(resolved);
				}
			} else if (specifier.startsWith("@outlinedb/")) {
				const resolved = exports.get(specifier);
				if (resolved === undefined) {
					throw new Error(`${relative} imports unexported ${specifier}`);
				}
				queue.push(resolved);
			} else {
				graph.packages.push(label);
			}
		}
	}
	return graph;
}
