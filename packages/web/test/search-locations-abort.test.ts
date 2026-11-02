import {describe, expect, it} from "vite-plus/test";
import type {ServerContext} from "../src/server/context.js";
import {httpAppFor} from "./http-app-for.js";

describe("POST /api/search/locations", () =>
{
	it("answers 499 without reading the tree for a request the client already aborted", async () =>
	{
		const ctx =
		{
			get db(): never
			{
				throw new Error("the tree must not be read");
			},
			config:
			{
				features:
				{
					treeSnapshot: true,
				},
			},
		} as unknown as ServerContext;
		const controller = new AbortController();
		controller.abort();
		const response = await httpAppFor(ctx).fetch(
			new Request(
				"http://x/api/search/locations",
				{
					method: "POST",
					body: JSON.stringify(
						{
							query: "a",
						},
					),
					signal: controller.signal,
				},
			),
		);
		expect(
			{
				status: response.status,
				body: await response.text(),
			},
		).toStrictEqual(
			{
				status: 499,
				body: "",
			},
		);
	});
});
