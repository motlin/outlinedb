import fs from "node:fs";
import path from "node:path";

/** The local cache database file name, placed at the project root when OUTLINEDB_DB_PATH is unset. */
export const DEFAULT_DB_FILE = "outlinedb.sqlite";

/** The nearest ancestor of `start` holding the cache database or a package.json, or `start` itself when none does. */
export function findProjectRoot(start: string = process.cwd()): string
{
	let dir = path.resolve(start);

	while (dir !== path.dirname(dir))
	{
		if (fs.existsSync(path.join(dir, DEFAULT_DB_FILE)) || fs.existsSync(path.join(dir, "package.json")))
		{
			return dir;
		}
		dir = path.dirname(dir);
	}

	return path.resolve(start);
}

/** The cache database at the project root, so running from a subdirectory opens the same file instead of creating a stray one. */
export function defaultDbPath(start: string = process.cwd()): string
{
	return path.join(findProjectRoot(start), DEFAULT_DB_FILE);
}
