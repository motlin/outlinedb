#!/usr/bin/env node
// Keep installed plugin caches in step with their marketplace source, for the daily review's
// import barrier (plugins/gtd/commands/daily-import.md).
//
// Claude Code caches a plugin under ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>, and
// `claude plugin update` compares only the version. This repo never bumps it, so every pushed fix
// is reported "already at latest" and the session keeps running the old scripts: a stale
// compute-llm-dag.mts once printed nothing, exited 0, and the review planned no tasks.
//
// Usage: plugin-cache-fresh.mts <plugin@marketplace>...
// Refreshes each marketplace clone, diffs every plugin's cache against its source there, and
// reinstalls the stale ones. Exit 0: every cache was already fresh. Exit 2: at least one was
// reinstalled, so the running session still holds the old commands and skills and must reload.
// Exit 1: the check or the reinstall failed.

import {execFileSync} from "node:child_process";
import {readFileSync, readdirSync} from "node:fs";
import {homedir} from "node:os";
import {join, relative} from "node:path";
import {isMain} from "./is-main.mts";
import {arrayField, errorMessage, expectObject, readJsonFile, stringField} from "./json.mts";

/** Claude Code's per-session lock directory inside a cached plugin; never part of the source. */
const IGNORED_NAMES = new Set([".in_use"]);

function listFiles(root: string): Map<string, string>
{
	const files = new Map<string, string>();
	const visit = (directory: string): void =>
	{
		for (const entry of readdirSync(
			directory,
			{
				withFileTypes: true,
			},
		))
		{
			if (IGNORED_NAMES.has(entry.name))
			{
				continue;
			}
			const path = join(directory, entry.name);
			if (entry.isDirectory())
			{
				visit(path);
			}
			else if (entry.isFile())
			{
				files.set(relative(root, path), path);
			}
		}
	};
	visit(root);
	return files;
}

/** Relative paths that differ between the cached plugin and its marketplace source, sorted. */
export function stalePaths(cacheDirectory: string, sourceDirectory: string): string[]
{
	const cached = listFiles(cacheDirectory);
	const source = listFiles(sourceDirectory);
	const paths = new Set([...cached.keys(), ...source.keys()]);
	return [...paths]
		.filter((path) =>
		{
			const cachedPath = cached.get(path);
			const sourceFile = source.get(path);
			return (
				cachedPath === undefined ||
				sourceFile === undefined ||
				!readFileSync(cachedPath).equals(readFileSync(sourceFile))
			);
		})
		.toSorted();
}

const PLUGINS_DIRECTORY = join(homedir(), ".claude", "plugins");

function claude(arguments_: string[]): void
{
	execFileSync(
		"claude",
		["plugin", ...arguments_],
		{
			stdio: ["ignore", "inherit", "inherit"],
		},
	);
}

function installPath(pluginId: string): string
{
	const installed = expectObject(
		expectObject(readJsonFile(join(PLUGINS_DIRECTORY, "installed_plugins.json")), "installed_plugins.json").plugins,
		"installed_plugins.json plugins",
	);
	const [entry] = arrayField(installed, pluginId);
	const path = entry === undefined ? undefined : stringField(expectObject(entry, pluginId), "installPath");
	if (path === undefined)
	{
		throw new Error(`${pluginId} is not installed`);
	}
	return path;
}

function sourcePath(pluginName: string, marketplace: string): string
{
	const known = expectObject(
		readJsonFile(join(PLUGINS_DIRECTORY, "known_marketplaces.json")),
		"known_marketplaces.json",
	);
	const location = stringField(expectObject(known[marketplace], marketplace), "installLocation");
	if (location === undefined)
	{
		throw new Error(`marketplace ${marketplace} has no installLocation`);
	}
	const manifest = expectObject(
		readJsonFile(join(location, ".claude-plugin", "marketplace.json")),
		"marketplace.json",
	);
	const plugin = arrayField(manifest, "plugins")
		.map((value) => expectObject(value, "marketplace plugin"))
		.find((value) => value.name === pluginName);
	const source = plugin === undefined ? undefined : stringField(plugin, "source");
	if (source === undefined)
	{
		throw new Error(`marketplace ${marketplace} has no local source for ${pluginName}`);
	}
	return join(location, source);
}

function parsePluginId(pluginId: string): [string, string]
{
	const [name, marketplace, ...rest] = pluginId.split("@");
	if (!name || !marketplace || rest.length > 0)
	{
		throw new Error(`expected <plugin>@<marketplace>, got "${pluginId}"`);
	}
	return [name, marketplace];
}

function main(pluginIds: string[]): number
{
	if (pluginIds.length === 0)
	{
		throw new Error("usage: plugin-cache-fresh.mts <plugin@marketplace>...");
	}
	const parsed = pluginIds.map((pluginId) => [pluginId, ...parsePluginId(pluginId)] as const);
	for (const marketplace of new Set(parsed.map((entry) => entry[2])))
	{
		claude(["marketplace", "update", marketplace]);
	}
	let refreshed = false;
	for (const [pluginId, name, marketplace] of parsed)
	{
		const source = sourcePath(name, marketplace);
		const stale = stalePaths(installPath(pluginId), source);
		if (stale.length === 0)
		{
			process.stdout.write(`${pluginId}: fresh\n`);
			continue;
		}
		process.stdout.write(
			`${pluginId}: stale (${stale.length} files: ${stale.slice(0, 5).join(", ")}), reinstalling\n`,
		);
		claude(["uninstall", pluginId, "--keep-data"]);
		claude(["install", pluginId]);
		const remaining = stalePaths(installPath(pluginId), source);
		if (remaining.length > 0)
		{
			throw new Error(`${pluginId} is still stale after reinstalling: ${remaining.join(", ")}`);
		}
		process.stdout.write(`${pluginId}: reinstalled\n`);
		refreshed = true;
	}
	return refreshed ? 2 : 0;
}

if (isMain(import.meta.url))
{
	try
	{
		process.exitCode = main(process.argv.slice(2));
	}
	catch (error)
	{
		process.stderr.write(`plugin-cache-fresh: ${errorMessage(error)}\n`);
		process.exitCode = 1;
	}
}
