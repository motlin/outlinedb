import {describe, expect, it} from "vite-plus/test";
import
{
	IDLE_BULLET_DRAG,
	bulletDragReducer,
	copyDropEffects,
	dragActionOf,
	dropBulletDrag,
	hidesSourceBullet,
	planCopyDrop,
} from "../src/client/bullet-drag-state.js";

const facts = () => (
{
	childCount: 3,
	wasLeaf: false,
	wasCollapsed: false,
	defaultToBottom: true,
});

describe("dragActionOf", () =>
{
	it("lets Alt win over Shift, and no modifier moves", () =>
	{
		expect([
			dragActionOf(
				{
					altKey: true,
					shiftKey: true,
				},
			),
			dragActionOf(
				{
					altKey: false,
					shiftKey: true,
				},
			),
			dragActionOf(
				{
					altKey: true,
					shiftKey: false,
				},
			),
			dragActionOf(
				{
					altKey: false,
					shiftKey: false,
				},
			),
		]).toStrictEqual(["duplicate", "mirror", "duplicate", "move"]);
	});
});

describe("hidesSourceBullet", () =>
{
	it("hides it for a single move or mirror drag only", () =>
	{
		expect([
			hidesSourceBullet("duplicate", false),
			hidesSourceBullet("mirror", false),
			hidesSourceBullet("move", false),
			hidesSourceBullet("mirror", true),
		]).toStrictEqual([false, true, true, false]);
	});
});

describe("planCopyDrop", () =>
{
	it("copies onto the row's own slot at that index, flashes the source and puts the caret in the copy", () =>
	{
		expect(
			planCopyDrop(
				{
					action: "duplicate",
					target:
					{
						parentId: "P",
						index: 0,
						ambiguous: false,
					},
					draggingIds: ["a"],
					selection: false,
				},
			),
		).toStrictEqual(
			{
				kind: "duplicate",
				ids: ["a"],
				parentId: "P",
				index: 0,
				flashIds: ["a"],
				after:
				{
					kind: "caret",
				},
			},
		);
	});

	it("keeps index 0 for a collapsed target instead of the default end", () =>
	{
		expect(
			planCopyDrop(
				{
					action: "mirror",
					target:
					{
						parentId: "Q",
						index: 0,
						ambiguous: true,
					},
					draggingIds: ["a"],
					selection: false,
				},
			),
		).toStrictEqual(
			{
				kind: "mirror",
				ids: ["a"],
				parentId: "Q",
				index: 0,
				flashIds: ["a"],
				after:
				{
					kind: "caret",
				},
			},
		);
	});

	it("selects the copies after a selection drag, and plans nothing for a move", () =>
	{
		const target =
		{
			parentId: "P",
			index: 2,
			ambiguous: false,
		};
		expect(
			{
				selection: planCopyDrop(
					{
						action: "duplicate",
						target,
						draggingIds: ["b", "c"],
						selection: true,
					},
				)?.after,
				move: planCopyDrop(
					{
						action: "move",
						target,
						draggingIds: ["b"],
						selection: false,
					},
				),
				empty: planCopyDrop(
					{
						action: "mirror",
						target,
						draggingIds: [],
						selection: false,
					},
				),
			},
		).toStrictEqual(
			{
				selection:
				{
					kind: "select",
				},
				move: null,
				empty: null,
			},
		);
	});
});

describe("the drag reducer with an action", () =>
{
	const started = bulletDragReducer(
		IDLE_BULLET_DRAG,
		{
			type: "start",
			id: "a",
			x: 0,
			y: 0,
			itemIds: ["a"],
			home:
			{
				parentId: "P",
				index: 0,
			},
			action: "duplicate",
			selection: false,
		},
	);

	it("keeps the action through move, hover and leave, and resets it on cancel", () =>
	{
		const dragging = bulletDragReducer(
			started,
			{
				type: "move",
				x: 0,
				y: 5,
			},
		);
		const target =
		{
			parentId: "P",
			index: 0,
			ambiguous: false,
		};
		const hovered = bulletDragReducer(
			dragging,
			{
				type: "hover",
				target,
				indicator: null,
			},
		);
		const left = bulletDragReducer(
			hovered,
			{
				type: "leave",
			},
		);

		expect([
			dragging.action,
			hovered.action,
			left.action,
			bulletDragReducer(
				left,
				{
					type: "cancel",
				},
			).action,
		]).toStrictEqual(["duplicate", "duplicate", "duplicate", "move"]);
	});

	it("releases a copy drop as a copy plan and no move plan", () =>
	{
		const dragging = bulletDragReducer(
			started,
			{
				type: "move",
				x: 0,
				y: 5,
			},
		);
		const hovered = bulletDragReducer(
			dragging,
			{
				type: "hover",
				target:
				{
					parentId: "P",
					index: 0,
					ambiguous: false,
				},
				indicator: null,
			},
		);

		const {plan, copy} = dropBulletDrag(hovered, facts);

		expect(
			{
				move: plan.move,
				copy,
			},
		).toStrictEqual(
			{
				move: null,
				copy:
				{
					kind: "duplicate",
					ids: ["a"],
					parentId: "P",
					index: 0,
					flashIds: ["a"],
					after:
					{
						kind: "caret",
					},
				},
			},
		);
	});
});

describe("copyDropEffects", () =>
{
	const caret =
	{
		kind: "duplicate",
		ids: ["a"],
		parentId: "P",
		index: 0,
		flashIds: ["a"],
		after:
		{
			kind: "caret",
		},
	} as const;

	it("puts the caret in a rendered copy and flashes the source", () =>
	{
		expect(copyDropEffects(caret, ["n0"], () => true)).toStrictEqual(
			{
				select: null,
				caretId: "n0",
				flashIds: ["a"],
			},
		);
	});

	it("leaves focus alone for a copy inside a collapsed parent", () =>
	{
		expect(copyDropEffects(caret, ["n0"], () => false)).toStrictEqual(
			{
				select: null,
				caretId: null,
				flashIds: ["a"],
			},
		);
	});

	it("selects every copy after a selection drag", () =>
	{
		expect(
			copyDropEffects(
				{
					...caret,
					ids: ["a", "b"],
					flashIds: ["a", "b"],
					after:
					{
						kind: "select",
					},
				},
				["n0", "n1"],
				() => true,
			),
		).toStrictEqual(
			{
				select: ["n0", "n1"],
				caretId: null,
				flashIds: ["a", "b"],
			},
		);
	});
});
