import {describe, expect, it} from "vite-plus/test";
import {PROJECT_INDENT_WIDTH, resolveDropTarget} from "../src/client/outline-drop-target.js";
import type {DropRows} from "../src/client/outline-drop-target.js";

interface FixtureNode
{
	readonly id: string;
	readonly children?: readonly FixtureNode[];
}

const BASE_LEFT = 80;

function fixtureRows(root: FixtureNode, collapsed: ReadonlySet<string>): DropRows
{
	const order: string[] = [];
	const parents = new Map<string, string>();
	const indexes = new Map<string, number>();
	const depths = new Map<string, number>();
	const walk = (node: FixtureNode, depth: number): void =>
	{
		order.push(node.id);
		depths.set(node.id, depth);
		(node.children ?? []).forEach((child, index) =>
		{
			parents.set(child.id, node.id);
			indexes.set(child.id, index);
			walk(child, depth + 1);
		});
	};
	walk(root, -1);
	const parentOf = (id: string): string | null => parents.get(id) ?? null;
	const isDescendantOf = (id: string, ancestorId: string): boolean =>
	{
		for (let current = parentOf(id); current !== null; current = parentOf(current))
		{
			if (current === ancestorId)
			{
				return true;
			}
		}
		return false;
	};
	const step = (id: string, delta: number): string | null => order[order.indexOf(id) + delta] ?? null;
	return {
		left: (id) => (depths.get(id) ?? 0) * PROJECT_INDENT_WIDTH + BASE_LEFT,
		parentOf,
		indexOf: (id) => indexes.get(id) ?? 0,
		isRendered: (id) => ![...collapsed].some((collapsedId) => isDescendantOf(id, collapsedId)),
		nextInDocument: (id) => step(id, 1),
		previousInDocument: (id) => step(id, -1),
		isCollapsed: (id) => collapsed.has(id),
		isDescendantOf,
	};
}

const dnd: FixtureNode =
{
	id: "DnD",
	children: [
		{
			id: "Alpha",
			children: [
				{
					id: "A1",
				},
				{
					id: "A2",
				},
			],
		},
		{
			id: "Bravo",
			children: [
				{
					id: "B1",
				},
			],
		},
		{
			id: "Charlie",
		},
		{
			id: "Delta",
		},
	],
};

const collapsedRows = fixtureRows(dnd, new Set(["Alpha", "Bravo"]));
const expandedAlphaRows = fixtureRows(dnd, new Set(["Bravo"]));

function resolve(rows: DropRows, predecessorId: string | null, x: number, movingIds: readonly string[] = ["Delta"])
{
	return resolveDropTarget(
		{
			x,
			rows,
			predecessorId,
			movingIds: new Set(movingIds),
			zoomRootId: "DnD",
		},
	);
}

describe("resolveDropTarget", () =>
{
	it("uses upstream's desktop indent width", () =>
	{
		expect(PROJECT_INDENT_WIDTH).toBe(36);
	});

	it("drops after a collapsed predecessor when the pointer is left of its indent threshold", () =>
	{
		expect(resolve(collapsedRows, "Alpha", 90)).toStrictEqual(
			{
				parentId: "DnD",
				index: 1,
				ambiguous: false,
			},
		);
	});

	it("drops into a collapsed predecessor as its first child, flagged ambiguous", () =>
	{
		expect(resolve(collapsedRows, "Alpha", 110)).toStrictEqual(
			{
				parentId: "Alpha",
				index: 0,
				ambiguous: true,
			},
		);
	});

	it("treats the zoom root as a container", () =>
	{
		expect(resolve(collapsedRows, "DnD", 90)).toStrictEqual(
			{
				parentId: "DnD",
				index: 0,
				ambiguous: false,
			},
		);
	});

	it("drops into a leaf predecessor past the indent threshold", () =>
	{
		expect(resolve(collapsedRows, "Charlie", 110)).toStrictEqual(
			{
				parentId: "Charlie",
				index: 0,
				ambiguous: false,
			},
		);
	});

	it("walks back past a moving predecessor", () =>
	{
		expect(resolve(collapsedRows, "Delta", 90)).toStrictEqual(
			{
				parentId: "DnD",
				index: 3,
				ambiguous: false,
			},
		);
	});

	it("outdents one level per ancestor while the pointer stays left of the threshold", () =>
	{
		expect(resolve(expandedAlphaRows, "A2", 90)).toStrictEqual(
			{
				parentId: "DnD",
				index: 1,
				ambiguous: false,
			},
		);
	});

	it("cannot move past a deeper successor", () =>
	{
		expect(resolve(expandedAlphaRows, "Alpha", 90)).toStrictEqual(
			{
				parentId: "Alpha",
				index: 0,
				ambiguous: false,
			},
		);
	});

	it("refuses a drop inside the moving subtree", () =>
	{
		expect(
			{
				left: resolve(expandedAlphaRows, "A1", 90, ["Alpha"]),
				deep: resolve(expandedAlphaRows, "A1", 150, ["Alpha"]),
			},
		).toStrictEqual(
			{
				left: null,
				deep: null,
			},
		);
	});

	it("inserts at the successor's place when no predecessor is left", () =>
	{
		const rows: DropRows =
		{
			...collapsedRows,
			previousInDocument: (id) => (id === "Alpha" ? null : collapsedRows.previousInDocument(id)),
		};
		expect(
			{
				walkedOff: resolve(rows, "Alpha", 90, ["Alpha"]),
				missing: resolve(collapsedRows, null, 90),
			},
		).toStrictEqual(
			{
				walkedOff:
				{
					parentId: "DnD",
					index: 1,
					ambiguous: false,
				},
				missing: null,
			},
		);
	});
});
