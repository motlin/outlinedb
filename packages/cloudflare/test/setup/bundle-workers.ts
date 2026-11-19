import {globSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {build} from "esbuild";
import type {TestProject} from "vite-plus/test/node";

declare module "vitest"
{
	export interface ProvidedContext
	{
		/** Each Worker entry's absolute path, mapped to the file holding its workerd bundle. */
		workerBundles: Record<string, string>;
	}
}

const cloudflareDir = new URL("../../", import.meta.url).pathname;

/** Bundle a Worker entry for workerd, resolving workspace packages through their `source` export. */
async function bundleWorker(entry: string): Promise<string>
{
	const result = await build(
		{
			entryPoints: [entry],
			bundle: true,
			format: "esm",
			write: false,
			platform: "neutral",
			conditions: ["source", "workerd", "worker", "browser"],
			mainFields: ["module", "main"],
			external: ["cloudflare:workers", "node:*"],
		},
	);
	return result.outputFiles[0]?.text ?? "";
}

/**
 * Bundle the Worker and every test entry once for the whole run. Each file bundled the entries it used itself, so
 * every Miniflare file paid an esbuild run of the whole Worker before its first test.
 */
export async function setup(project: TestProject): Promise<() => void>
{
	const dir = mkdtempSync(join(tmpdir(), "outlinedb-worker-bundles-"));
	const entries = [join(cloudflareDir, "src/worker.ts"), ...globSync(join(cloudflareDir, "test/*-entry.ts"))];
	const bundles = await Promise.all(
		entries.map(async (entry, index): Promise<[string, string]> =>
		{
			const file = join(dir, `${index}.mjs`);
			writeFileSync(file, await bundleWorker(entry));
			return [entry, file];
		}),
	);
	project.provide("workerBundles", Object.fromEntries(bundles));
	return () =>
	{
		rmSync(
			dir,
			{
				recursive: true,
				force: true,
			},
		);
	};
}
