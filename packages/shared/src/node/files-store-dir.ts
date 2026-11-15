import path from "node:path";

/**
 * Where a Node host keeps attachment bytes (`files mirror` downloads, uploads): `OUTLINEDB_FILES_DIR`, else a
 * `files-mirror` directory beside the cache database (`OUTLINEDB_DB_PATH`, default `outlinedb.sqlite` in `cwd`).
 */
export function defaultStoreDir(env: Record<string, string | undefined>, cwd: string): string
{
	const configured = env.OUTLINEDB_FILES_DIR ?? "";
	if (configured !== "")
	{
		return path.resolve(cwd, configured);
	}
	const dbPath = (env.OUTLINEDB_DB_PATH ?? "") || "outlinedb.sqlite";
	return path.join(path.dirname(path.resolve(cwd, dbPath)), "files-mirror");
}
