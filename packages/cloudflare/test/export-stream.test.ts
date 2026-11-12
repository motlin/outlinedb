import {describe, expect, it} from "vite-plus/test";
import {nodeBatches} from "../src/export-stream";

function streamOf(text: string, chunk: number): ReadableStream<Uint8Array>
{
	const bytes = new TextEncoder().encode(text);
	let offset = 0;
	return new ReadableStream(
		{
			pull(controller)
			{
				if (offset >= bytes.length)
				{
					controller.close();
					return;
				}
				controller.enqueue(bytes.slice(offset, offset + chunk));
				offset += chunk;
			},
		},
	);
}

async function collect(stream: ReadableStream<Uint8Array>, size: number, skip = 0): Promise<unknown[][]>
{
	const batches: unknown[][] = [];
	for await (const batch of nodeBatches(
		stream,
		{
			size,
			skip,
		},
	))
	{
		batches.push(batch);
	}
	return batches;
}

const nodes = [
	{
		id: "a",
		name: String.raw`quote " and } brace { and \ slash`,
		priority: 1,
	},
	{
		id: "b",
		name: "emoji \u{1F600} and [bracket]",
		data:
		{
			layoutMode: "bullets",
		},
		priority: 2,
	},
	{
		id: "c",
		name: "plain",
		priority: 3,
	},
];
const text = JSON.stringify(
	{
		nodes,
	},
);

describe("nodeBatches", () =>
{
	it("splits the nodes array into batches, whatever the chunk size", async () =>
	{
		for (const chunk of [1, 3, 7, 4096])
		{
			await expect(collect(streamOf(text, chunk), 2)).resolves.toStrictEqual([[nodes[0], nodes[1]], [nodes[2]]]);
		}
	});

	it("skips the first nodes without parsing them", async () =>
	{
		await expect(collect(streamOf(text, 5), 2, 2)).resolves.toStrictEqual([[nodes[2]]]);
	});

	it("yields nothing for an empty or missing nodes array", async () =>
	{
		await expect(collect(streamOf('{"nodes":[]}', 4), 2)).resolves.toStrictEqual([]);
		await expect(collect(streamOf("{}", 4), 2)).resolves.toStrictEqual([]);
	});
});
