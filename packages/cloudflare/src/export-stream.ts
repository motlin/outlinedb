import type {WorkflowyNode} from "@outlinedb/shared/types";

export interface NodeBatchOptions
{
	/** Nodes per batch. */
	size: number;
	/** Leading nodes to pass over, for resuming a partly applied export; parsed only when {@link onSkipped} is given. */
	skip?: number;
	/** Called with each skipped node, so a resumed run learns which nodes an earlier run already applied. */
	onSkipped?: (node: WorkflowyNode) => void;
}

/**
 * Stream the nodes of a `{"nodes": [...]}` export in batches without holding the whole document.
 * It tracks bracket depth outside strings, so it assumes the first array in the root object is `nodes`
 * (the export has no other keys) and that each node is an object. Stopping iteration early cancels the read.
 */
export async function* nodeBatches(
	body: ReadableStream<Uint8Array>,
	options: NodeBatchOptions,
): AsyncGenerator<WorkflowyNode[]>
{
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let skip = options.skip ?? 0;
	let batch: WorkflowyNode[] = [];
	let depth = 0;
	let inString = false;
	let escaped = false;
	let pending = "";
	let capturing = false;
	try
	{
		for (;;)
		{
			const {done, value} = await reader.read();
			const chunk = done
				? decoder.decode()
				: decoder.decode(
						value,
						{
							stream: true,
						},
					);
			let segmentStart = 0;
			for (let i = 0; i < chunk.length; i++)
			{
				const code = chunk.codePointAt(i) ?? 0;
				if (inString)
				{
					if (escaped)
					{
						escaped = false;
					}
					else if (code === 92)
					{
						escaped = true;
					}
					else if (code === 34)
					{
						inString = false;
					}
					continue;
				}
				if (code === 34)
				{
					inString = true;
				}
				else if (code === 123 || code === 91)
				{
					depth++;
					if (code === 123 && depth === 3)
					{
						capturing = skip === 0 || options.onSkipped !== undefined;
						segmentStart = i;
						pending = "";
					}
				}
				else if (code === 125 || code === 93)
				{
					depth--;
					if (code === 125 && depth === 2)
					{
						if (capturing)
						{
							// oxlint-disable-next-line typescript/no-unsafe-assignment -- applyApiBatch validates every node with its schema
							const node: WorkflowyNode = JSON.parse(pending + chunk.slice(segmentStart, i + 1));
							capturing = false;
							pending = "";
							if (skip > 0)
							{
								options.onSkipped?.(node);
							}
							else
							{
								batch.push(node);
								if (batch.length === options.size)
								{
									yield batch;
									batch = [];
								}
							}
						}
						if (skip > 0)
						{
							skip--;
						}
					}
				}
			}
			if (capturing)
			{
				pending += chunk.slice(segmentStart);
			}
			if (done)
			{
				break;
			}
		}
		if (batch.length > 0)
		{
			yield batch;
		}
	}
	finally
	{
		await reader.cancel().catch(() => {});
	}
}
