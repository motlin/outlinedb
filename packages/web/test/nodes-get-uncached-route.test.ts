import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import type {ServerContext} from "../src/server/context.js";
import {httpAppFor} from "./http-app-for.js";
import {mirrorContext} from "./helpers/local-context.js";

const FULL = "11111111-2222-3333-4444-555555555555";

function setup()
{
	const ctx: ServerContext = mirrorContext();
	ctx.cacheService.insertNode(
		{
			id: "Alpha",
			name: "Alpha",
			note: null,
			priority: 0,
			createdAt: 100,
			modifiedAt: 200,
			completedAt: null,
		},
		null,
	);
	const app = httpAppFor(ctx);
	return {
		ctx,
		get: async (id: string) => app.fetch(new Request(`http://x/api/v1/nodes/${id}`)),
	};
}

describe("GET /api/v1/nodes/:id for uncached nodes", () =>
{
	afterEach(() =>
	{
		vi.restoreAllMocks();
	});

	it.each([FULL, "abcdef123456"])(
		"answers 404 for %s, which the local tables lack, without reading workflowy.com or storing anything",
		async (id) =>
		{
			const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no request expected"));
			const {ctx, get} = setup();

			const res = await get(id);

			expect(
				{
					status: res.status,
					cached: ctx.cacheService.getNode(FULL) !== undefined,
					fetches: fetch.mock.calls.length,
				},
			).toStrictEqual(
				{
					status: 404,
					cached: false,
					fetches: 0,
				},
			);
		},
	);
});
