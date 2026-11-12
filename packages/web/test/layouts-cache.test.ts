// @vitest-environment happy-dom
import {QueryClient} from "@tanstack/react-query";
import {describe, expect, it} from "vite-plus/test";
import {cachedCanRender} from "../src/client/layouts-cache.js";
import {nodeKeys} from "../src/client/node-cache.js";
import type {NodeResponse} from "../src/node-types.js";

function node(id: string, parentId: string | null, layoutMode: string | null): NodeResponse
{
	return {
		id,
		parent_id: parentId,
		name: id,
		data:
		{
			layoutMode,
		},
	} as unknown as NodeResponse;
}

describe("cachedCanRender", () =>
{
	it("is false for a plain parent under every complex layout, so Enter on its rows makes siblings", () =>
	{
		const queryClient = new QueryClient();
		queryClient.setQueryData(nodeKeys.detail("zoom"), node("zoom", null, null));
		queryClient.setQueryData(nodeKeys.detail("plain"), node("plain", "zoom", null));
		expect(
			{
				board: cachedCanRender(queryClient, "plain", "board", "zoom"),
				dashboard: cachedCanRender(queryClient, "plain", "dashboard", "zoom"),
				table: cachedCanRender(queryClient, "plain", "table", "zoom"),
			},
		).toStrictEqual(
			{
				board: false,
				dashboard: false,
				table: false,
			},
		);
	});
});
