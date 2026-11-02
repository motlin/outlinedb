import {describe, expect, it, vi} from "vite-plus/test";

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

const {bulletClickAction, nodeUrl, planZoomFocus, zoomSteps} = await import("../src/client/navigation.js");

const ZOOMED = "11111111-1111-4111-8111-111111111111";
const TARGET = "22222222-2222-4222-8222-222222222222";
const CHILD = "33333333-3333-4333-8333-333333333333";
const PARENT = "44444444-4444-4444-8444-444444444444";

const base =
{
	zoomedId: ZOOMED,
	targetId: TARGET,
	firstChildId: null,
	parentOfZoomed: PARENT,
	previousEditingId: null,
	previousOffset: 0,
};

describe("planZoomFocus first_child", () =>
{
	it("edits the first visible child at offset 0 and scrolls to the top", () =>
	{
		expect(
			planZoomFocus(
				"first_child",
				{
					...base,
					firstChildId: CHILD,
				},
			),
		).toStrictEqual(
			{
				route: nodeUrl(TARGET),
				editId: CHILD,
				offset: 0,
				scrollTop: true,
			},
		);
	});

	it("edits the zoom title of a leaf at offset 0", () =>
	{
		expect(planZoomFocus("first_child", base)).toStrictEqual(
			{
				route: nodeUrl(TARGET),
				editId: TARGET,
				offset: 0,
				scrollTop: true,
			},
		);
	});

	it("keeps the old caret offset when the planned row is the row that had focus", () =>
	{
		expect(
			planZoomFocus(
				"first_child",
				{
					...base,
					previousEditingId: TARGET,
					previousOffset: 3,
				},
			),
		).toStrictEqual(
			{
				route: nodeUrl(TARGET),
				editId: TARGET,
				offset: 3,
				scrollTop: true,
			},
		);
	});

	it("resets the offset when the planned row differs from the row that had focus", () =>
	{
		expect(
			planZoomFocus(
				"first_child",
				{
					...base,
					firstChildId: CHILD,
					previousEditingId: TARGET,
					previousOffset: 3,
				},
			),
		).toStrictEqual(
			{
				route: nodeUrl(TARGET),
				editId: CHILD,
				offset: 0,
				scrollTop: true,
			},
		);
	});

	it("does nothing when the target is already zoomed", () =>
	{
		expect(
			planZoomFocus(
				"first_child",
				{
					...base,
					targetId: ZOOMED,
					firstChildId: CHILD,
				},
			),
		).toBeNull();
	});

	it("edits nothing when zooming home with no children", () =>
	{
		expect(
			planZoomFocus(
				"first_child",
				{
					...base,
					targetId: null,
				},
			),
		).toStrictEqual(
			{
				route: "/",
				editId: null,
				offset: 0,
				scrollTop: true,
			},
		);
	});
});

describe("planZoomFocus last_selected", () =>
{
	it("zooms out to the parent and edits the node zoomed out of without scrolling", () =>
	{
		expect(
			{
				parent: planZoomFocus(
					"last_selected",
					{
						...base,
						previousEditingId: null,
					},
				),
				home: planZoomFocus(
					"last_selected",
					{
						...base,
						parentOfZoomed: null,
					},
				),
			},
		).toStrictEqual(
			{
				parent:
				{
					route: nodeUrl(PARENT),
					editId: ZOOMED,
					offset: 0,
					scrollTop: false,
				},
				home:
				{
					route: "/",
					editId: ZOOMED,
					offset: 0,
					scrollTop: false,
				},
			},
		);
	});

	it("keeps the caret offset when the zoomed row itself had focus, and resets it for any other row", () =>
	{
		expect(
			{
				same: planZoomFocus(
					"last_selected",
					{
						...base,
						previousEditingId: ZOOMED,
						previousOffset: 3,
					},
				),
				other: planZoomFocus(
					"last_selected",
					{
						...base,
						previousEditingId: CHILD,
						previousOffset: 3,
					},
				),
			},
		).toStrictEqual(
			{
				same:
				{
					route: nodeUrl(PARENT),
					editId: ZOOMED,
					offset: 3,
					scrollTop: false,
				},
				other:
				{
					route: nodeUrl(PARENT),
					editId: ZOOMED,
					offset: 0,
					scrollTop: false,
				},
			},
		);
	});

	it("does nothing at the root", () =>
	{
		expect(
			planZoomFocus(
				"last_selected",
				{
					...base,
					zoomedId: null,
					parentOfZoomed: null,
				},
			),
		).toBeNull();
	});
});

describe("bulletClickAction", () =>
{
	const plain =
	{
		metaKey: false,
		ctrlKey: false,
		button: 0,
		armed: true,
		inSelection: false,
	};

	it("zooms on a plain left click", () =>
	{
		expect(bulletClickAction(plain)).toBe("zoom");
	});

	it("leaves a meta, ctrl or middle click to the browser", () =>
	{
		expect(
			{
				meta: bulletClickAction(
					{
						...plain,
						metaKey: true,
					},
				),
				ctrl: bulletClickAction(
					{
						...plain,
						ctrlKey: true,
					},
				),
				middle: bulletClickAction(
					{
						...plain,
						button: 1,
					},
				),
			},
		).toStrictEqual(
			{
				meta: "browser",
				ctrl: "browser",
				middle: "browser",
			},
		);
	});

	it("ignores a click the press did not arm, even with a modifier", () =>
	{
		expect(
			{
				plain: bulletClickAction(
					{
						...plain,
						armed: false,
					},
				),
				meta: bulletClickAction(
					{
						...plain,
						armed: false,
						metaKey: true,
					},
				),
			},
		).toStrictEqual(
			{
				plain: "ignore",
				meta: "ignore",
			},
		);
	});

	it("clears the selection on a selected row's bullet before the modifier check", () =>
	{
		expect(
			{
				plain: bulletClickAction(
					{
						...plain,
						inSelection: true,
					},
				),
				meta: bulletClickAction(
					{
						...plain,
						inSelection: true,
						metaKey: true,
					},
				),
			},
		).toStrictEqual(
			{
				plain: "clear-selection",
				meta: "clear-selection",
			},
		);
	});
});

describe("zoomSteps", () =>
{
	it("focuses after the zoom-out animation and before it for zoom-in", () =>
	{
		expect(
			{
				out: zoomSteps(
					{
						animate: true,
						isOut: true,
						hasEdit: true,
					},
				),
				into: zoomSteps(
					{
						animate: true,
						isOut: false,
						hasEdit: true,
					},
				),
				still: zoomSteps(
					{
						animate: false,
						isOut: true,
						hasEdit: true,
					},
				),
				noEdit: zoomSteps(
					{
						animate: true,
						isOut: true,
						hasEdit: false,
					},
				),
			},
		).toStrictEqual(
			{
				out: ["navigate", "animate-out", "focus"],
				into: ["animate-in", "navigate", "focus"],
				still: ["navigate", "focus"],
				noEdit: ["navigate", "animate-out"],
			},
		);
	});
});
