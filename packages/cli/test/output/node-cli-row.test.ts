import {describe, expect, it} from "vite-plus/test";
import {nodeToCliRow} from "../../src/output/node-cli-row.js";
import type {Node} from "@outlinedb/shared/types";

function makeNode(overrides: Partial<Node> = {}): Node
{
	return {
		id: "11111111-1111-1111-1111-111111111111",
		shortId: "abcdef012345",
		parentId: "22222222-2222-2222-2222-222222222222",
		name: "Buy milk",
		note: "Whole milk",
		priority: 3,
		layoutMode: "todo",
		createdAt: new Date("2026-01-02T03:04:05.000Z"),
		modifiedAt: new Date("2026-02-03T04:05:06.000Z"),
		completedAt: null,
		collapsed: false,
		mirror:
		{
			isMirror: false,
			originalNodeId: null,
		},
		systemFrom: "2026-01-01T00:00:00.000Z",
		systemTo: "9999-12-31T23:59:59.999Z",
		...overrides,
	};
}

const expectedRow = (overrides: Record<string, unknown> = {}) => (
{
	id: "11111111-1111-1111-1111-111111111111",
	shortId: "abcdef012345",
	parentId: "22222222-2222-2222-2222-222222222222",
	name: "Buy milk",
	note: "Whole milk",
	priority: 3,
	layoutMode: "todo",
	createdAt: "2026-01-02T03:04:05.000Z",
	modifiedAt: "2026-02-03T04:05:06.000Z",
	completedAt: null,
	completed: false,
	collapsed: false,
	isMirror: false,
	originalNodeId: null,
	...overrides,
});

describe("nodeToCliRow", () =>
{
	it("serializes a fully-populated node", () =>
	{
		const row = nodeToCliRow(makeNode());
		expect(row).toStrictEqual(expectedRow());
	});

	it("derives completed=true when completedAt is set", () =>
	{
		const row = nodeToCliRow(
			makeNode(
				{
					completedAt: new Date("2026-03-04T05:06:07.000Z"),
				},
			),
		);
		expect(row).toStrictEqual(
			expectedRow(
				{
					completed: true,
					completedAt: "2026-03-04T05:06:07.000Z",
				},
			),
		);
	});

	it("passes through null name and note", () =>
	{
		const row = nodeToCliRow(
			makeNode(
				{
					name: null,
					note: null,
				},
			),
		);
		expect(row).toStrictEqual(
			expectedRow(
				{
					name: null,
					note: null,
				},
			),
		);
	});

	it("serializes null timestamps as null", () =>
	{
		const row = nodeToCliRow(
			makeNode(
				{
					createdAt: null,
					modifiedAt: null,
				},
			),
		);
		expect(row).toStrictEqual(
			expectedRow(
				{
					createdAt: null,
					modifiedAt: null,
				},
			),
		);
	});

	it("flattens mirror relationship", () =>
	{
		const row = nodeToCliRow(
			makeNode(
				{
					mirror:
					{
						isMirror: true,
						originalNodeId: "33333333-3333-3333-3333-333333333333",
					},
				},
			),
		);
		expect(row).toStrictEqual(
			expectedRow(
				{
					isMirror: true,
					originalNodeId: "33333333-3333-3333-3333-333333333333",
				},
			),
		);
	});

	it("does not leak temporal columns", () =>
	{
		const row = nodeToCliRow(makeNode());
		expect(row).toStrictEqual(expectedRow());
	});
});
