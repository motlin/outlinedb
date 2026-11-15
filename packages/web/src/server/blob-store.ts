/**
 * Where attachment bytes live once they are ours: R2 on the Worker, a directory on the Node host. Keys are the
 * content-addressed `blobs/<ab>/<sha256>` paths that `file_blobs.local_path` records, the layout `files mirror` writes.
 */
export interface BlobStore
{
	put(key: string, bytes: Uint8Array<ArrayBuffer>): Promise<void>;
	/** The stored bytes, or null when nothing is stored under `key`. */
	get(key: string): Promise<Uint8Array<ArrayBuffer> | null>;
}

/** The store key of a blob: two-character fan-out directory, then the full hash. */
export function blobKey(sha256: string): string
{
	return `blobs/${sha256.slice(0, 2)}/${sha256}`;
}

/** The lowercase hex SHA-256 of `bytes`, with Web Crypto so it runs on both hosts. */
export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string>
{
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
