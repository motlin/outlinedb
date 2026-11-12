import {describe, expect, it} from "vite-plus/test";
import type {NodeResponse} from "../src/node-types.js";
import {CHILDREN_BATCH_SIZE, createChildrenBatcher} from "../src/client/children-batcher.js";

function node(id: string): NodeResponse
{
	return {
		id,
		parent_id: null,
		name: id,
		note: null,
		priority: 0,
		data:
		{
			layoutMode: null,
		},
		createdAt: null,
		modifiedAt: null,
		completedAt: null,
	};
}

/** A batch fetch that records each request's ids and answers every known id with one child named after it. */
function recordingPost(unknown: ReadonlySet<string> = new Set())
{
	const requests: string[][] = [];
	const post = async (parentIds: string[]): Promise<Record<string, NodeResponse[]>> =>
	{
		requests.push(parentIds);
		await Promise.resolve();
		return Object.fromEntries(parentIds.filter((id) => !unknown.has(id)).map((id) => [id, [node(`${id}-child`)]]));
	};
	return {
		requests,
		post,
	};
}

describe("createChildrenBatcher", () =>
{
	it("coalesces the loads of one tick into a single request without duplicate ids", async () =>
	{
		const {requests, post} = recordingPost();
		const load = createChildrenBatcher(post);

		const results = await Promise.all([load("a"), load("b"), load("a")]);

		expect(
			{
				requests,
				results: results.map((nodes) => nodes.map((child) => child.id)),
			},
		).toStrictEqual(
			{
				requests: [["a", "b"]],
				results: [["a-child"], ["b-child"], ["a-child"]],
			},
		);
	});

	it("splits a large tick into requests of at most the batch size", async () =>
	{
		const {requests, post} = recordingPost();
		const load = createChildrenBatcher(post);
		const ids = Array.from(
			{
				length: CHILDREN_BATCH_SIZE * 2 + 1,
			},
			(_, index) => `n${index}`,
		);

		await Promise.all(ids.map(async (id) => load(id)));

		expect(requests.map((batch) => batch.length)).toStrictEqual([CHILDREN_BATCH_SIZE, CHILDREN_BATCH_SIZE, 1]);
	});

	it("rejects only the loads whose parent the server does not know", async () =>
	{
		const {post} = recordingPost(new Set(["gone"]));
		const load = createChildrenBatcher(post);

		const results = await Promise.allSettled([load("kept"), load("gone")]);

		expect(results.map((result) => result.status)).toStrictEqual(["fulfilled", "rejected"]);
	});

	it("rejects every load of a request that fails", async () =>
	{
		const load = createChildrenBatcher(async () => Promise.reject(new Error("offline")));

		const results = await Promise.allSettled([load("a"), load("b")]);

		expect(results.map((result) => result.status)).toStrictEqual(["rejected", "rejected"]);
	});
});
