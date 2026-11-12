import {describe, expect, it, vi} from "vite-plus/test";
import {QueryClient} from "@tanstack/react-query";
import type {NodeResponse} from "../src/node-types.js";

vi.stubGlobal(
	"localStorage",
	{
		getItem: () => null,
		setItem: () =>
		{
		},
	},
);
vi.stubGlobal("matchMedia", () => (
{
	matches: false,
	addEventListener: () =>
	{
	},
}));
vi.stubGlobal(
	"document",
	{
		documentElement:
		{
			dataset: {},
		},
		body:
		{
			classList:
			{
				toggle: () => true,
				contains: () => false,
			},
		},
	},
);
vi.stubGlobal("addEventListener", () => {});

const {useOutlineStore} = await import("../src/client/stores/outline.js");
const {nodeKeys} = await import("../src/client/node-cache.js");
const {currentNavigableIds, currentExpansionRows} = await import("../src/client/hooks/use-visible-nodes.js");

function makeNode(id: string, parentId: string | null): NodeResponse
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
	};
}

describe("currentNavigableIds", () =>
{
	it("reads the cache at call time, so a row created after the last render is navigable", () =>
	{
		const queryClient = new QueryClient();
		useOutlineStore.setState(
			{
				zoomedNodeId: "root",
				expandedIds: new Set(),
				showCompleted: true,
				animatingCompletionIds: new Set(),
			},
		);
		queryClient.setQueryData(nodeKeys.children("root"), [makeNode("alpha", "root"), makeNode("bravo", "root")]);
		const before = currentNavigableIds(queryClient);
		queryClient.setQueryData(nodeKeys.children("root"), [
			makeNode("alpha", "root"),
			makeNode("bravo", "root"),
			makeNode("charlie", "root"),
		]);
		const after = currentNavigableIds(queryClient);
		expect(
			{
				before,
				after,
			},
		).toStrictEqual(
			{
				before: ["root", "alpha", "bravo"],
				after: ["root", "alpha", "bravo", "charlie"],
			},
		);
	});
});

describe("a mirror inside its own original", () =>
{
	function cyclicalClient()
	{
		const queryClient = new QueryClient();
		const mirror: NodeResponse =
		{
			...makeNode("Mmmm", "Kkkk"),
			isMirror: true,
			originalNodeId: "Oooo",
		};
		queryClient.setQueryData(nodeKeys.children("Pppp"), [makeNode("Oooo", "Pppp")]);
		queryClient.setQueryData(nodeKeys.children("Oooo"), [makeNode("Kkkk", "Oooo")]);
		queryClient.setQueryData(nodeKeys.children("Kkkk"), [mirror]);
		queryClient.setQueryData(nodeKeys.children("Mmmm"), [makeNode("Kkkk", "Oooo")]);
		useOutlineStore.setState(
			{
				zoomedNodeId: "Pppp",
				expandedIds: new Set(["Oooo", "Kkkk", "Mmmm"]),
				showCompleted: true,
				animatingCompletionIds: new Set(),
			},
		);
		return queryClient;
	}

	it("lists the rows down to the first mirror's collapsed children instead of overflowing the stack", () =>
	{
		expect(currentNavigableIds(cyclicalClient())).toStrictEqual(["Pppp", "Oooo", "Kkkk", "Mmmm", "Kkkk"]);
	});

	it("lists the expansion rows one level deeper each", () =>
	{
		expect(currentExpansionRows(cyclicalClient()).map((row) => row.depth)).toStrictEqual([0, 1, 2, 3]);
	});
});
