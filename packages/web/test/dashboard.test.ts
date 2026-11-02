import {afterEach, describe, expect, it} from "vite-plus/test";
import
{
	CARD_PLACEHOLDER,
	dashboardInsertIndex,
	canMoveUnderDashboard,
	dashboardClasses,
	isDashboard,
	shouldExpandOnEnter,
} from "../src/client/dashboard.js";
import {selectItemType} from "../src/client/item-type-select.js";
import {resolveDropTarget} from "../src/client/outline-drop-target.js";
import type {DropRows} from "../src/client/outline-drop-target.js";
import {placeholderFor} from "../src/client/slash-trigger.js";
import {planSplit} from "../src/client/tree-ops.js";
import {ITEM_TYPES, availableItemTypes} from "../src/client/layout-types.js";
import {DEFAULT_FEATURES, isFeatureOn, setAccountFeatures} from "../src/client/features.js";
import {resolveLayoutMode} from "../src/client/components/layout-mode.js";

function storage(value: string | null)
{
	return {
		getItem: (key: string) => (key === "wf.features.dashboards" ? value : null),
	};
}

describe("isFeatureOn", () =>
{
	it("is off by default and on only for 'on'", () =>
	{
		expect(isFeatureOn("dashboards", storage(null))).toBe(false);
		expect(isFeatureOn("dashboards", storage("off"))).toBe(false);
		expect(isFeatureOn("dashboards", storage("on"))).toBe(true);
	});

	it("is off when storage throws", () =>
	{
		expect(
			isFeatureOn(
				"dashboards",
				{
					getItem: () =>
					{
						throw new Error("blocked");
					},
				},
			),
		).toBe(false);
	});
});

describe("isFeatureOn with the account dict", () =>
{
	afterEach(() =>
	{
		setAccountFeatures(null);
	});

	it("lets the loaded account dict win over localStorage", () =>
	{
		setAccountFeatures(
			{
				dashboards: true,
			},
		);
		expect(isFeatureOn("dashboards", storage(null))).toBe(true);
		setAccountFeatures({});
		expect(isFeatureOn("dashboards", storage("on"))).toBe(false);
	});

	it("answers the measured default dict before the account loads", () =>
	{
		setAccountFeatures(null);
		expect([isFeatureOn("dates", storage(null)), isFeatureOn("dashboards", storage(null))]).toStrictEqual([
			true,
			false,
		]);
		expect(Object.keys(DEFAULT_FEATURES)).toHaveLength(17);
	});
});

describe("isDashboard and resolveLayoutMode", () =>
{
	it("requires the flag", () =>
	{
		expect(isDashboard("dashboard", true)).toBe(true);
		expect(isDashboard("dashboard", false)).toBe(false);
		expect(isDashboard("good-dashboard", true)).toBe(false);
	});

	it("gives a dashboard its project class only with the flag on", () =>
	{
		expect(resolveLayoutMode("dashboard", true)).toStrictEqual(
			{
				projectClasses: ["dashboard"],
				isTodo: false,
			},
		);
		expect(resolveLayoutMode("dashboard", false)).toStrictEqual(
			{
				projectClasses: [],
				isTodo: false,
			},
		);
		expect(resolveLayoutMode("good-dashboard", true)).toStrictEqual(
			{
				projectClasses: [],
				isTodo: false,
			},
		);
	});
});

describe("dashboardClasses", () =>
{
	const base =
	{
		layoutMode: null,
		renders: true,
		parentRenders: false,
		isZoomRoot: false,
		flagOn: true,
	};

	it("marks an inline dashboard", () =>
	{
		expect(
			dashboardClasses(
				{
					...base,
					layoutMode: "dashboard",
				},
			),
		).toStrictEqual(
			{
				project: ["dashboard", "dashboard-inline"],
				page: [],
			},
		);
	});

	it("marks a zoomed dashboard and its page", () =>
	{
		expect(
			dashboardClasses(
				{
					...base,
					layoutMode: "dashboard",
					isZoomRoot: true,
				},
			),
		).toStrictEqual(
			{
				project: ["dashboard"],
				page: ["dashboard-page"],
			},
		);
	});

	it("marks direct children of a rendering dashboard as cards, in order", () =>
	{
		expect(
			dashboardClasses(
				{
					...base,
					parentRenders: true,
				},
			),
		).toStrictEqual(
			{
				project: ["show-controls-on-hover", "dashboard-card"],
				page: [],
			},
		);
	});

	it("gives a grandchild and a flag-off tree nothing", () =>
	{
		expect(dashboardClasses(base)).toStrictEqual(
			{
				project: [],
				page: [],
			},
		);
		expect(
			dashboardClasses(
				{
					...base,
					layoutMode: "dashboard",
					parentRenders: true,
					flagOn: false,
				},
			),
		).toStrictEqual(
			{
				project: [],
				page: [],
			},
		);
	});

	it("gives a dashboard that does not render no classes", () =>
	{
		expect(
			dashboardClasses(
				{
					layoutMode: "dashboard",
					renders: false,
					parentRenders: false,
					isZoomRoot: false,
					flagOn: true,
				},
			).project,
		).toStrictEqual([]);
	});
});

describe("behaviors", () =>
{
	it("uses upstream's card placeholder with U+2026", () =>
	{
		expect(CARD_PLACEHOLDER).toBe("Add a title …");
	});

	it("expands on Enter only for a card", () =>
	{
		expect(shouldExpandOnEnter("dashboard", true)).toBe(true);
		expect(shouldExpandOnEnter("dashboard", false)).toBe(false);
		expect(shouldExpandOnEnter("bullets", true)).toBe(false);
	});

	it("refuses to move under a card", () =>
	{
		expect(canMoveUnderDashboard("dashboard", true)).toBe(false);
		expect(canMoveUnderDashboard("dashboard", false)).toBe(true);
		expect(canMoveUnderDashboard(null, true)).toBe(true);
	});
});

describe("item type picker", () =>
{
	const ctx =
	{
		isRoot: false,
		isMainDocumentRoot: false,
		readOnly: false,
		isTableCell: false,
	};

	it("hides Dashboard with the flag off and lists it after Table with the flag on", () =>
	{
		expect(availableItemTypes(ctx, false).map((t) => t.key)).not.toContain("dashboard");
		const keys = availableItemTypes(ctx, true).map((t) => t.key);
		expect(keys[keys.indexOf("table") + 1]).toBe("dashboard");
	});

	it("allows Dashboard in a table cell", () =>
	{
		expect(
			availableItemTypes(
				{
					...ctx,
					isTableCell: true,
				},
				true,
			).map((t) => t.key),
		).toContain("dashboard");
	});
});

describe("wiring", () =>
{
	it("inserts a card at the top or bottom", () =>
	{
		expect(dashboardInsertIndex("top", 4)).toBe(0);
		expect(dashboardInsertIndex("bottom", 4)).toBe(4);
	});

	it("shows the card placeholder for an empty card title", () =>
	{
		expect(
			placeholderFor(
				{
					focused: false,
					empty: true,
					dashboardCard: true,
				},
			),
		).toBe("Add a title …");
		expect(
			placeholderFor(
				{
					focused: false,
					empty: true,
					dashboardCard: true,
					layoutMode: "divider",
				},
			),
		).toBeUndefined();
	});

	it("Enter at the end of a card creates its first child and expands it", () =>
	{
		const plan = planSplit(
			{
				node:
				{
					id: "card",
					parent_id: "dash",
					index: 2,
					hasVisibleChildren: false,
					isExpanded: false,
					isZoomRoot: false,
					isEmpty: false,
					hasNextSibling: true,
					canOutdent: true,
					role: "card",
				},
				html: "Title",
				selection:
				{
					start: 5,
					end: 5,
				},
				shapeLayout: null,
			},
		);
		expect(plan).toMatchObject(
			{
				kind: "create",
				parentId: "card",
				index: 0,
				expand: "card",
			},
		);
	});

	it("expands every child when turned into a dashboard", () =>
	{
		const expanded: string[][] = [];
		selectItemType(
			ITEM_TYPES.find((type) => type.key === "dashboard")!,
			["d"],
			{
				update: () =>
				{
				},
				expandAll: (ids) =>
				{
					expanded.push([...ids]);
				},
				childIds: () => ["a", "b"],
				layoutMode: () => null,
			},
		);
		expect(expanded).toStrictEqual([["a", "b"]]);
	});

	it("refuses a drop target whose parent is a dashboard", () =>
	{
		const rows: DropRows =
		{
			left: () => 0,
			parentOf: (id) => (id === "card" ? "dash" : null),
			indexOf: () => 0,
			isRendered: () => true,
			nextInDocument: () => null,
			previousInDocument: () => null,
			isCollapsed: () => false,
			isDescendantOf: () => false,
		};
		const input =
		{
			x: 500,
			rows,
			predecessorId: "card",
			movingIds: new Set(["m"]),
			zoomRootId: "root",
		};
		expect(resolveDropTarget(input)).toMatchObject(
			{
				parentId: "card",
			},
		);
		expect(
			resolveDropTarget(
				{
					...input,
					canMoveUnder: () => false,
				},
			),
		).toBeNull();
	});
});
