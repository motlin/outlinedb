import {realpathSync} from "node:fs";
import {fileURLToPath} from "node:url";

/**
 * True when the module at `moduleUrl` is the script node was started with.
 *
 * Compares real paths: node resolves symlinks for `import.meta.url` but leaves `process.argv[1]` as typed, so a plain
 * string compare is false whenever the script is reached through a symlink (`~/.claude` is one) and the script silently
 * exits 0 having done nothing.
 */
export function isMain(moduleUrl: string, scriptPath: string | undefined = process.argv[1]): boolean
{
	if (scriptPath === undefined)
	{
		return false;
	}
	try
	{
		return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(scriptPath);
	}
	catch
	{
		return false;
	}
}
