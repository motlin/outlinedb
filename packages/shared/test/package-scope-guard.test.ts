import fs from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vite-plus/test";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const SKIPPED_DIRS = new Set(["node_modules", "dist", "build", "coverage", ".wrangler", "__snapshots__"]);
const OLD_SCOPE = "@workflowy/";

function packageJsonFiles(): string[]
{
	const packages = fs
		.readdirSync(path.join(REPO_ROOT, "packages"))
		.map((name) => path.join("packages", name, "package.json"));
	return ["package.json", ...packages].filter((file) => fs.existsSync(path.join(REPO_ROOT, file)));
}

function sourceFiles(dir: string): string[]
{
	return fs
		.readdirSync(
			dir,
			{
				withFileTypes: true,
			},
		)
		.flatMap((entry) =>
		{
			if (SKIPPED_DIRS.has(entry.name))
			{
				return [];
			}
			const full = path.join(dir, entry.name);
			if (entry.isDirectory())
			{
				return sourceFiles(full);
			}
			return /\.(ts|tsx|mts|js|mjs)$/u.test(entry.name) ? [full] : [];
		});
}

function oldScopeEntries(file: string): string[]
{
	const json = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, file), "utf8")) as Record<string, unknown>;
	const names = [
		json.name,
		...["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap((key) =>
			Object.keys((json[key] as Record<string, string> | undefined) ?? {}),
		),
	];
	return names
		.filter((name): name is string => typeof name === "string" && name.startsWith(OLD_SCOPE))
		.map((name) => `${file}: ${name}`);
}

function oldScopeImports(file: string): string[]
{
	const relative = path.relative(REPO_ROOT, file);
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => /(?:from\s+|import\s*\(\s*|vi\.mock\(\s*)["']@workflowy\//u.test(line))
		.map((line) => `${relative}: ${line.trim()}`);
}

describe("package scope guard", () =>
{
	it("names no workspace package or dependency in the @workflowy scope", () =>
	{
		expect(packageJsonFiles().flatMap((file) => oldScopeEntries(file))).toStrictEqual([]);
	});

	it("imports no module from the @workflowy scope", () =>
	{
		const roots = ["packages", "scripts"]
			.map((dir) => path.join(REPO_ROOT, dir))
			.filter((dir) => fs.existsSync(dir));
		expect(roots.flatMap((dir) => sourceFiles(dir)).flatMap((file) => oldScopeImports(file))).toStrictEqual([]);
	});
});
