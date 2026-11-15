import type {BlobStore} from "@outlinedb/web/server-app";

/** The Worker's {@link BlobStore}: one R2 bucket shared by every user, each Durable Object's keys under its own prefix. */
export function r2BlobStore(bucket: R2Bucket, prefix: string): BlobStore
{
	return {
		async put(key, bytes)
		{
			await bucket.put(`${prefix}/${key}`, bytes);
		},
		async get(key)
		{
			const object = await bucket.get(`${prefix}/${key}`);
			return object === null ? null : new Uint8Array(await object.arrayBuffer());
		},
	};
}
