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

/** Delete every object in `bucket` whose key starts with `prefix`, a listing page at a time. */
export async function deleteR2Prefix(bucket: R2Bucket, prefix: string): Promise<void>
{
	let cursor: string | undefined;
	do
	{
		// oxlint-disable-next-line no-await-in-loop -- one listing page at a time
		const listed = await bucket.list(
			{
				prefix,
				...(cursor === undefined
					? {}
					:
						{
							cursor,
						}),
			},
		);
		if (listed.objects.length > 0)
		{
			// oxlint-disable-next-line no-await-in-loop -- one listing page at a time
			await bucket.delete(listed.objects.map((object) => object.key));
		}
		cursor = listed.truncated ? listed.cursor : undefined;
	}
	while (cursor !== undefined);
}
