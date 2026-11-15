import {mkdir, readFile, rename, writeFile} from "node:fs/promises";
import path from "node:path";
import type {BlobStore} from "./blob-store.js";

/** The Node host's {@link BlobStore}: each key is a path under `dir`, written to a temp file and renamed into place. */
export function diskBlobStore(dir: string): BlobStore
{
	return {
		async put(key, bytes)
		{
			const target = path.join(dir, key);
			await mkdir(
				path.dirname(target),
				{
					recursive: true,
				},
			);
			const temporary = `${target}.${crypto.randomUUID()}.part`;
			await writeFile(temporary, bytes);
			await rename(temporary, target);
		},
		async get(key)
		{
			try
			{
				return new Uint8Array(await readFile(path.join(dir, key)));
			}
			catch (error)
			{
				if (error instanceof Error && "code" in error && error.code === "ENOENT")
				{
					return null;
				}
				throw error;
			}
		},
	};
}
