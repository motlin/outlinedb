import {describe, expect, it} from "vite-plus/test";
import
{
	EXPAND_KEYS,
	collapseDeepestOpenLevel,
	createDoublePressDetector,
	expandOrCollapseAll,
	expandShallowestCollapsedLevel,
	handleExpandClick,
	pageHasCollapsed,
	planExpandKey,
	subtreeIds,
} from "../src/client/expansion.js";
import type {ExpansionRow, TreeIndex} from "../src/client/expansion.js";

const ROOT = "root";
const CHILDREN: Record<string, string[]> =
{
	[ROOT]: ["Alpha", "Beta"],
	Alpha: ["A1", "A2"],
	A1: ["A1a"],
	Beta: ["B1"],
};

function makeIndex(hidden: ReadonlySet<string> = new Set()): TreeIndex
{
	const children = (id: string) => CHILDREN[id] ?? [];
	return {
		children,
		isVisible: (id) => !hidden.has(id),
		hasVisibleChildren: (id) => children(id).some((child) => !hidden.has(child)),
		hasAnyChildren: (id) => children(id).length > 0,
	};
}

function rowsFor(expanded: ReadonlySet<string>, index: TreeIndex = makeIndex()): ExpansionRow[]
{
	const rows: ExpansionRow[] = [];
	const walk = (parentId: string, depth: number) =>
	{
		for (const id of index.children(parentId))
		{
			if (!index.isVisible(id))
			{
				continue;
			}
			const hasVisibleChildren = index.hasVisibleChildren(id);
			rows.push(
				{
					id,
					depth,
					hasVisibleChildren,
				},
			);
			if (hasVisibleChildren && expanded.has(id))
			{
				walk(id, depth + 1);
			}
		}
	};
	walk(ROOT, 0);
	return rows;
}

describe("collapseDeepestOpenLevel", () =>
{
	it("collapses the deepest open parents one level per call", () =>
	{
		const first = collapseDeepestOpenLevel(
			new Set(["Alpha", "A1", "Beta"]),
			rowsFor(new Set(["Alpha", "A1", "Beta"])),
		);
		expect(first).toStrictEqual(new Set(["Alpha", "Beta"]));
		const second = collapseDeepestOpenLevel(first, rowsFor(first));
		expect(second).toStrictEqual(new Set());
	});
});

describe("expandShallowestCollapsedLevel", () =>
{
	it("expands the shallowest collapsed parents one level per call", () =>
	{
		const first = expandShallowestCollapsedLevel(new Set(), rowsFor(new Set()));
		expect(first).toStrictEqual(new Set(["Alpha", "Beta"]));
		const second = expandShallowestCollapsedLevel(first, rowsFor(first));
		expect(second).toStrictEqual(new Set(["A1", "Alpha", "Beta"]));
	});
});

describe("expandOrCollapseAll", () =>
{
	it("collapses the item and its whole subtree, leaving other ids alone", () =>
	{
		const result = expandOrCollapseAll(new Set(["Alpha", "A1", "Beta"]), makeIndex(), "Alpha", false);
		expect(result).toStrictEqual(new Set(["Beta"]));
	});

	it("expands every parent in the subtree", () =>
	{
		const result = expandOrCollapseAll(new Set(), makeIndex(), "Alpha", true);
		expect(result).toStrictEqual(new Set(["A1", "Alpha"]));
	});

	it("marks a parent whose only child is hidden, but never a childless row", () =>
	{
		const children: Record<string, string[]> =
		{
			top: ["Gamma", "Leaf"],
			Gamma: ["G1"],
		};
		const index: TreeIndex =
		{
			children: (id) => children[id] ?? [],
			isVisible: (id) => id !== "G1",
			hasVisibleChildren: (id) => (children[id] ?? []).some((child) => child !== "G1"),
			hasAnyChildren: (id) => (children[id] ?? []).length > 0,
		};
		const result = expandOrCollapseAll(new Set(), index, "top", true);
		expect(result).toStrictEqual(new Set(["top", "Gamma"]));
	});

	it("skips hidden items when expanding", () =>
	{
		const index = makeIndex(new Set(["A1"]));
		const result = expandOrCollapseAll(new Set(), index, "Alpha", true);
		expect(result).toStrictEqual(new Set(["Alpha"]));
		expect(subtreeIds(index, "Alpha")).toStrictEqual(["Alpha", "A2"]);
	});
});

describe("pageHasCollapsed", () =>
{
	it("is true while any rendered parent is collapsed", () =>
	{
		expect(pageHasCollapsed(new Set(["Alpha", "Beta"]), rowsFor(new Set(["Alpha", "Beta"])))).toBe(true);
		const all = new Set(["Alpha", "A1", "Beta"]);
		expect(pageHasCollapsed(all, rowsFor(all))).toBe(false);
	});
});

describe("createDoublePressDetector", () =>
{
	it("reports a double press within the window with the state at the first press", () =>
	{
		const detector = createDoublePressDetector(250);
		expect(detector.press("x", false, 0)).toStrictEqual(
			{
				double: false,
			},
		);
		expect(detector.press("x", true, 200)).toStrictEqual(
			{
				double: true,
				wasOpenAtFirst: false,
			},
		);
	});

	it("does not report a double press outside the window", () =>
	{
		const detector = createDoublePressDetector(250);
		expect(detector.press("x", false, 0)).toStrictEqual(
			{
				double: false,
			},
		);
		expect(detector.press("x", true, 300)).toStrictEqual(
			{
				double: false,
			},
		);
	});

	it("does not pair presses on different ids", () =>
	{
		const detector = createDoublePressDetector(250);
		expect(detector.press("x", false, 0)).toStrictEqual(
			{
				double: false,
			},
		);
		expect(detector.press("y", false, 100)).toStrictEqual(
			{
				double: false,
			},
		);
	});
});

describe("EXPAND_KEYS", () =>
{
	it("names the mac combos for expand, collapse and toggle", () =>
	{
		expect(EXPAND_KEYS).toStrictEqual(
			{
				expand: "meta+down",
				collapse: "meta+up",
				toggle: "ctrl+space",
			},
		);
	});
});

describe("planExpandKey", () =>
{
	const base =
	{
		id: "Alpha",
		isOpen: false,
		hasVisibleChildren: true,
		now: 0,
		rows: rowsFor(new Set()),
		expanded: new Set<string>(),
	};

	it("expands the shallowest collapsed level on the zoom root", () =>
	{
		const expanded = new Set(["Alpha"]);
		const plan = planExpandKey(
			{
				...base,
				key: "expand",
				target: "root",
				id: ROOT,
				rows: rowsFor(expanded),
				expanded,
				detector: createDoublePressDetector(),
			},
		);
		expect(plan).toStrictEqual(
			{
				type: "level",
				ids: ["Beta"],
				open: true,
			},
		);
	});

	it("acts on a zoomed-in board column itself, not the progressive zoom-root path", () =>
	{
		const detector = createDoublePressDetector();
		const column =
		{
			...base,
			id: "bob",
			target: "root" as const,
			role: "column" as const,
			detector,
		};
		expect([
			planExpandKey(
				{
					...column,
					key: "expand",
				},
			),
			planExpandKey(
				{
					...column,
					key: "toggle",
				},
			),
			planExpandKey(
				{
					...column,
					key: "collapse",
					isOpen: true,
				},
			),
		]).toStrictEqual([
			{
				type: "expand",
				id: "bob",
			},
			{
				type: "toggle",
				id: "bob",
			},
			{
				type: "collapse",
				id: "bob",
			},
		]);
	});

	it("collapses the deepest open level on the zoom root", () =>
	{
		const expanded = new Set(["Alpha", "A1", "Beta"]);
		const plan = planExpandKey(
			{
				...base,
				key: "collapse",
				target: "root",
				id: ROOT,
				rows: rowsFor(expanded),
				expanded,
				detector: createDoublePressDetector(),
			},
		);
		expect(plan).toStrictEqual(
			{
				type: "level",
				ids: ["A1"],
				open: false,
			},
		);
	});

	it("does nothing on the zoom root when no level is left to change", () =>
	{
		const plan = planExpandKey(
			{
				...base,
				key: "collapse",
				target: "root",
				id: ROOT,
				detector: createDoublePressDetector(),
			},
		);
		expect(plan).toStrictEqual(
			{
				type: "none",
			},
		);
	});

	it("toggles the whole page on the zoom root: expand all while anything is collapsed", () =>
	{
		const detector = createDoublePressDetector();
		expect(
			planExpandKey(
				{
					...base,
					key: "toggle",
					target: "root",
					id: ROOT,
					detector,
				},
			),
		).toStrictEqual(
			{
				type: "all",
				id: ROOT,
				open: true,
			},
		);
		const all = new Set(["Alpha", "A1", "Beta"]);
		expect(
			planExpandKey(
				{
					...base,
					key: "toggle",
					target: "root",
					id: ROOT,
					rows: rowsFor(all),
					expanded: all,
					detector,
				},
			),
		).toStrictEqual(
			{
				type: "all",
				id: ROOT,
				open: false,
			},
		);
	});

	it("toggles a row, and a second press within the window collapses all from open", () =>
	{
		const detector = createDoublePressDetector();
		const first = planExpandKey(
			{
				...base,
				key: "toggle",
				target: "row",
				isOpen: true,
				now: 1000,
				detector,
			},
		);
		expect(first).toStrictEqual(
			{
				type: "toggle",
				id: "Alpha",
			},
		);
		const second = planExpandKey(
			{
				...base,
				key: "toggle",
				target: "row",
				isOpen: false,
				now: 1200,
				detector,
			},
		);
		expect(second).toStrictEqual(
			{
				type: "all",
				id: "Alpha",
				open: false,
			},
		);
	});

	it("expands all on a second press from closed", () =>
	{
		const detector = createDoublePressDetector();
		planExpandKey(
			{
				...base,
				key: "toggle",
				target: "row",
				isOpen: false,
				now: 1000,
				detector,
			},
		);
		const second = planExpandKey(
			{
				...base,
				key: "toggle",
				target: "row",
				isOpen: true,
				now: 1100,
				detector,
			},
		);
		expect(second).toStrictEqual(
			{
				type: "all",
				id: "Alpha",
				open: true,
			},
		);
	});

	it("expands a collapsed row and collapses an open one, and leaves the other no-ops alone", () =>
	{
		const detector = createDoublePressDetector();
		expect(
			planExpandKey(
				{
					...base,
					key: "expand",
					target: "row",
					detector,
				},
			),
		).toStrictEqual(
			{
				type: "expand",
				id: "Alpha",
			},
		);
		expect(
			planExpandKey(
				{
					...base,
					key: "expand",
					target: "row",
					isOpen: true,
					detector,
				},
			),
		).toStrictEqual(
			{
				type: "none",
			},
		);
		expect(
			planExpandKey(
				{
					...base,
					key: "collapse",
					target: "row",
					isOpen: true,
					detector,
				},
			),
		).toStrictEqual(
			{
				type: "collapse",
				id: "Alpha",
			},
		);
		expect(
			planExpandKey(
				{
					...base,
					key: "collapse",
					target: "row",
					detector,
				},
			),
		).toStrictEqual(
			{
				type: "none",
			},
		);
	});

	it("does nothing on a leaf row", () =>
	{
		const detector = createDoublePressDetector();
		for (const key of ["expand", "collapse", "toggle"] as const)
		{
			expect(
				planExpandKey(
					{
						...base,
						key,
						target: "row",
						hasVisibleChildren: false,
						detector,
					},
				),
			).toStrictEqual(
				{
					type: "none",
				},
			);
		}
	});
});

describe("handleExpandClick", () =>
{
	it("toggles on the first click and expands or collapses the whole subtree on a second click within 250ms", () =>
	{
		const detector = createDoublePressDetector();
		expect(
			handleExpandClick(
				{
					now: 0,
					id: "x",
					isOpen: true,
					hasChildren: true,
					detector,
				},
			),
		).toStrictEqual(
			{
				type: "toggle",
			},
		);
		expect(
			handleExpandClick(
				{
					now: 100,
					id: "x",
					isOpen: false,
					hasChildren: true,
					detector,
				},
			),
		).toStrictEqual(
			{
				type: "all",
				open: false,
			},
		);
	});

	it("expands all when the row was collapsed at the first click", () =>
	{
		const detector = createDoublePressDetector();
		expect(
			handleExpandClick(
				{
					now: 0,
					id: "x",
					isOpen: false,
					hasChildren: true,
					detector,
				},
			),
		).toStrictEqual(
			{
				type: "toggle",
			},
		);
		expect(
			handleExpandClick(
				{
					now: 100,
					id: "x",
					isOpen: true,
					hasChildren: true,
					detector,
				},
			),
		).toStrictEqual(
			{
				type: "all",
				open: true,
			},
		);
	});

	it("toggles again when the second click is outside the window", () =>
	{
		const detector = createDoublePressDetector();
		handleExpandClick(
			{
				now: 0,
				id: "x",
				isOpen: true,
				hasChildren: true,
				detector,
			},
		);
		expect(
			handleExpandClick(
				{
					now: 300,
					id: "x",
					isOpen: false,
					hasChildren: true,
					detector,
				},
			),
		).toStrictEqual(
			{
				type: "toggle",
			},
		);
	});

	it("does nothing on a leaf", () =>
	{
		const detector = createDoublePressDetector();
		expect(
			handleExpandClick(
				{
					now: 0,
					id: "x",
					isOpen: false,
					hasChildren: false,
					detector,
				},
			),
		).toStrictEqual(
			{
				type: "none",
			},
		);
	});
});
