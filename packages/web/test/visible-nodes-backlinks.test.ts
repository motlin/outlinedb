// @vitest-environment happy-dom
import {QueryClient} from "@tanstack/react-query";
import {describe, expect, it} from "vite-plus/test";
import type {BacklinksResponse, NodeResponse} from "../src/node-types.js";
import {searchFilter} from "../src/client/search-filter.js";
import {nodeKeys} from "../src/client/node-cache.js";
import {collectVisibleNodeIds} from "../src/client/hooks/use-visible-nodes.js";

function node(id: string, parentId: string | null, overrides: Partial<NodeResponse> = {}): NodeResponse
{
	return {
		id,
		parent_id: parentId,
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
		hasChildren: false,
		...overrides,
	};
}

function fixture()
{
	const client = new QueryClient();
	client.setQueryData(nodeKeys.children("T"), [node("C", "T")]);
	const backlinks: BacklinksResponse =
	{
		rootId: "R",
		items: [
			{
				node: node(
					"B1",
					"R",
					{
						isMirror: true,
						originalNodeId: "S1",
					},
				),
				sourceId: "S1",
				crumbs: [],
			},
			{
				node: node(
					"B2",
					"R",
					{
						isMirror: true,
						originalNodeId: "S2",
					},
				),
				sourceId: "S2",
				crumbs: [],
			},
		],
	};
	client.setQueryData(nodeKeys.backlinks("T"), backlinks);
	return client;
}

describe("collectVisibleNodeIds with a Backlinks section", () =>
{
	it("lists the references row and its backlink items after the zoom root's children when the section is open", () =>
	{
		expect(collectVisibleNodeIds(fixture(), "T", new Set(["R"]), true, new Set(), null)).toStrictEqual([
			"C",
			"R",
			"B1",
			"B2",
		]);
	});

	it("lists only the references row while the section is collapsed", () =>
	{
		expect(collectVisibleNodeIds(fixture(), "T", new Set(), true, new Set(), null)).toStrictEqual(["C", "R"]);
	});

	it("leaves the section out of a search", () =>
	{
		const search = searchFilter(
			{
				matchIds: ["C"],
				nameMatchIds: ["C"],
				noteMatchIds: [],
				metaMatchIds: [],
				ancestorIds: [],
				halfExpandedIds: [],
				rootHalfExpanded: false,
				completedMatchCount: 0,
				matchCount: 1,
				revealsCompleted: false,
			},
			new Set(),
			new Map(),
		);
		expect(collectVisibleNodeIds(fixture(), "T", new Set(["R"]), true, new Set(), search)).not.toContain("R");
	});
});
