import {beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import type {NodeResponse} from "../src/node-types.js";
import {LadderTree} from "../src/client/components/ladder-tree.js";

interface QueryResult<T>
{
	data?: T;
	isLoading?: boolean;
	error: Error | null;
}
const queries = vi.hoisted(() => (
{
	children: vi.fn<(id: string) => QueryResult<NodeResponse[]>>(),
	node: vi.fn<(id: string) => QueryResult<NodeResponse>>(),
}));
vi.mock("../src/client/hooks/use-nodes.js", () => (
{
	useChildren: queries.children,
	useNode: queries.node,
}));
const node = (id: string, extra: Partial<NodeResponse> = {}): NodeResponse => (
{
	id,
	parent_id: "alice",
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
	...extra,
});
const render = () =>
	renderToStaticMarkup(
		createElement(
			LadderTree,
			{
				item:
				{
					id: "alice",
					name: "Alice",
				},
				onClose: () =>
				{
				},
			},
		),
	);

beforeEach(() =>
{
	queries.children.mockReset();
	queries.node.mockReturnValue(
		{
			data: node("alice"),
			error: null,
		},
	);
});

describe("ladder task tree", () =>
{
	it("loads every nested branch, including completed tasks, and stops ancestor mirrors", () =>
	{
		const children: Record<string, NodeResponse[]> =
		{
			alice: [
				node(
					"bob",
					{
						hasChildren: true,
					},
				),
				node(
					"eve",
					{
						completedAt: 1,
					},
				),
			],
			bob: [
				node(
					"charlie",
					{
						hasChildren: true,
					},
				),
			],
			charlie: [
				node(
					"mirror",
					{
						hasChildren: true,
						originalNodeId: "alice",
					},
				),
			],
		};
		queries.children.mockImplementation((id: string) => (
		{
			data: children[id],
			isLoading: false,
			error: null,
		}));
		const html = render();
		expect(queries.children.mock.calls).toStrictEqual([["alice"], ["bob"], ["charlie"]]);
		expect([...html.matchAll(/<span[^>]*>(.*?)<\/span>/gu)].map((match) => match[1])).toStrictEqual([
			"bob",
			"charlie",
			"mirror",
			"eve (completed)",
		]);
	});

	it("renders note text safely without interpreting markup as executable HTML", () =>
	{
		queries.node.mockReturnValue(
			{
				data: node(
					"alice",
					{
						note: "<b>Alice &amp; Bob</b>",
					},
				),
				error: null,
			},
		);
		queries.children.mockReturnValue(
			{
				data: [],
				isLoading: false,
				error: null,
			},
		);
		expect([...render().matchAll(/<p[^>]*>(.*?)<\/p>/gu)].map((match) => match[1])).toStrictEqual([
			"Alice &amp; Bob",
			"No subtasks.",
		]);
	});

	it("shows failed branches with a retry instead of silently hiding descendants", () =>
	{
		queries.children.mockReturnValue(
			{
				error: new Error("Test request failed"),
				isLoading: false,
			},
		);
		expect([...render().matchAll(/<p[^>]*>(.*?)<\/p>/gu)].map((match) => match[1])).toStrictEqual([
			'Could not load subtasks. <button type="button">Retry</button>',
		]);
	});
});
