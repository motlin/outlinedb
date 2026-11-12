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
	buildDropRows,
	ghostCloneStyle,
	hitX,
	isOutsideViewport,
	rotateOrigin,
	dragItems,
	dropClearsSelection,
	dropHoverOf,
	dropIndicatorFor,
	isFoundDateRow,
	planDrop,
} from "../src/client/bullet-drag-state.js";
import {readFileSync} from "node:fs";
import type {BulletDragState} from "../src/client/bullet-drag-state.js";
import {emptySelection, selectionOf} from "../src/client/item-selection.js";
import type {TreeView} from "../src/client/item-selection.js";
import {resolveDropTarget} from "../src/client/outline-drop-target.js";
import {fileURLToPath} from "node:url";

describe("bullet drag copy", () =>
{
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
});

describe("bullet drag state", () =>
{
	const armed: BulletDragState = bulletDragReducer(
		IDLE_BULLET_DRAG,
		{
			type: "start",
			id: "delta",
			x: 100,
			y: 200,
			itemIds: ["delta"],
			home:
			{
				parentId: "dnd",
				index: 3,
			},
		},
	);

	const dragging: BulletDragState = bulletDragReducer(
		armed,
		{
			type: "move",
			x: 100,
			y: 203,
		},
	);

	describe("isOutsideViewport", () =>
	{
		it("is true past any window edge", () =>
		{
			const size =
			{
				width: 949,
				height: 710,
			};
			expect([
				isOutsideViewport(
					{
						x: 2000,
						y: 600,
					},
					size,
				),
				isOutsideViewport(
					{
						x: 0,
						y: 0,
					},
					size,
				),
				isOutsideViewport(
					{
						x: -1,
						y: 5,
					},
					size,
				),
			]).toStrictEqual([true, false, true]);
		});

		it("keeps the target when the indicator is cleared by leaving", () =>
		{
			const target =
			{
				parentId: "dnd",
				index: 2,
				ambiguous: false,
			};
			const hovering = bulletDragReducer(
				dragging,
				{
					type: "hover",
					target,
					indicator:
					{
						kind: "at",
						rowId: "bravo",
						paneId: "p0",
					},
				},
			);
			expect(
				bulletDragReducer(
					hovering,
					{
						type: "leave",
					},
				),
			).toStrictEqual(
				{
					...hovering,
					indicator: null,
				},
			);
		});
	});

	describe("hitX", () =>
	{
		it("clamps the pointer to the page bounds inset by 6px", () =>
		{
			expect([
				hitX(
					10,
					{
						left: 0,
						right: 933,
					},
				),
				hitX(
					2000,
					{
						left: 0,
						right: 933,
					},
				),
			]).toStrictEqual([10, 927]);
		});
	});

	describe("rotateOrigin", () =>
	{
		it("uses the bullet content box and the ghost position", () =>
		{
			expect([
				rotateOrigin(
					{
						left: 81,
						top: 140,
						contentWidth: 18,
						contentHeight: 24,
					},
					{
						left: 121,
						top: 161,
					},
				),
				rotateOrigin(
					{
						left: 81,
						top: 168,
						contentWidth: 18,
						contentHeight: 24,
					},
					{
						left: 121,
						top: 178,
					},
				),
			]).toStrictEqual(["-11px 1.5px", "-11px 7px"]);
		});
	});

	describe("ghostCloneStyle", () =>
	{
		it("has no visibility override", () =>
		{
			expect(ghostCloneStyle(1)).toStrictEqual(
				{
					left: "0",
					top: "10px",
					opacity: "0.8",
					zIndex: "4",
				},
			);
		});
	});

	describe("pane-aware drop indicator", () =>
	{
		it("marks only the row in the pane under the pointer", () =>
		{
			expect([
				dropHoverOf(
					{
						kind: "in",
						parentId: "alpha",
						paneId: "p1",
					},
					"alpha",
					"p0",
				),
				dropHoverOf(
					{
						kind: "in",
						parentId: "alpha",
						paneId: "p1",
					},
					"alpha",
					"p1",
				),
			]).toStrictEqual([null, "in"]);
			expect(
				dropIndicatorFor(
					{
						parentId: "dnd",
						index: 2,
						ambiguous: false,
					},
					["alpha", "bravo", "charlie"],
					"p1",
				),
			).toStrictEqual(
				{
					kind: "at",
					rowId: "bravo",
					paneId: "p1",
				},
			);
		});
	});

	describe("bulletDragReducer", () =>
	{
		it("arms on mousedown without dragging anything", () =>
		{
			expect(armed).toStrictEqual(
				{
					action: "move",
					selection: false,
					phase: "armed",
					sourceId: "delta",
					origin:
					{
						x: 100,
						y: 200,
					},
					home:
					{
						parentId: "dnd",
						index: 3,
					},
					itemIds: ["delta"],
					draggingIds: [],
					indicator: null,
					ghostTransform: null,
					target: null,
				},
			);
		});

		it("stays armed below the 3px threshold", () =>
		{
			expect(
				bulletDragReducer(
					armed,
					{
						type: "move",
						x: 102,
						y: 200,
					},
				),
			).toStrictEqual(armed);
		});

		it("starts dragging at 3px and moves the ghost by the pointer delta", () =>
		{
			expect(dragging).toStrictEqual(
				{
					action: "move",
					selection: false,
					phase: "dragging",
					sourceId: "delta",
					origin:
					{
						x: 100,
						y: 200,
					},
					home:
					{
						parentId: "dnd",
						index: 3,
					},
					itemIds: ["delta"],
					draggingIds: ["delta"],
					indicator: null,
					ghostTransform: "translate3d(0px, 3px, 0px)",
					target: null,
				},
			);
			expect(
				bulletDragReducer(
					dragging,
					{
						type: "move",
						x: 90,
						y: 250,
					},
				).ghostTransform,
			).toBe("translate3d(-10px, 50px, 0px)");
		});

		it("records the hovered target and its indicator only while dragging", () =>
		{
			const hover =
			{
				type: "hover",
				target:
				{
					parentId: "charlie",
					index: 0,
					ambiguous: false,
				},
				indicator:
				{
					kind: "in",
					parentId: "charlie",
					paneId: "p0",
				},
			} as const;
			expect(bulletDragReducer(armed, hover)).toStrictEqual(armed);
			expect(bulletDragReducer(dragging, hover)).toStrictEqual(
				{
					...dragging,
					target:
					{
						parentId: "charlie",
						index: 0,
						ambiguous: false,
					},
					indicator:
					{
						kind: "in",
						parentId: "charlie",
						paneId: "p0",
					},
				},
			);
		});

		it("clears the indicator but keeps the last target when the pointer leaves the window", () =>
		{
			const hovered = bulletDragReducer(
				dragging,
				{
					type: "hover",
					target:
					{
						parentId: "charlie",
						index: 0,
						ambiguous: false,
					},
					indicator:
					{
						kind: "in",
						parentId: "charlie",
						paneId: "p0",
					},
				},
			);
			expect(
				bulletDragReducer(
					hovered,
					{
						type: "leave",
					},
				),
			).toStrictEqual(
				{
					...dragging,
					target:
					{
						parentId: "charlie",
						index: 0,
						ambiguous: false,
					},
					indicator: null,
				},
			);
		});

		it("cancels back to idle", () =>
		{
			expect(
				bulletDragReducer(
					dragging,
					{
						type: "cancel",
					},
				),
			).toStrictEqual(
				{
					action: "move",
					selection: false,
					phase: "idle",
					sourceId: null,
					origin: null,
					home: null,
					itemIds: [],
					draggingIds: [],
					indicator: null,
					ghostTransform: null,
					target: null,
				},
			);
		});

		it("drags every item the press armed once the drag starts", () =>
		{
			const selectionArmed = bulletDragReducer(
				IDLE_BULLET_DRAG,
				{
					type: "start",
					id: "charlie",
					x: 100,
					y: 200,
					itemIds: ["bravo", "charlie"],
					home:
					{
						parentId: "dnd",
						index: 1,
					},
				},
			);
			expect(
				bulletDragReducer(
					selectionArmed,
					{
						type: "move",
						x: 100,
						y: 203,
					},
				).draggingIds,
			).toStrictEqual(["bravo", "charlie"]);
		});
	});

	describe("dragItems", () =>
	{
		// DnD{Alpha, Bravo, Charlie{C1}, Delta}; all expanded.
		const children: Record<string, string[]> =
		{
			dnd: ["alpha", "bravo", "charlie", "delta"],
			charlie: ["c1"],
		};
		const parents = new Map(
			Object.entries(children).flatMap(([parentId, ids]) => ids.map((id) => [id, parentId] as const)),
		);
		const tree: TreeView =
		{
			zoomRootId: "dnd",
			parentOf: (id) => parents.get(id) ?? null,
			visibleOrder: ["dnd", "alpha", "bravo", "charlie", "c1", "delta"],
			nextPotentiallyVisibleSiblingOf: () => null,
			previousPotentiallyVisibleSiblingOf: () => null,
		};
		const childIdsOf = (id: string) => children[id] ?? [];
		const items = (sourceId: string, ids: readonly string[]) =>
			dragItems(
				{
					sourceId,
					selection: ids.length === 0 ? emptySelection() : selectionOf(ids),
					tree,
					childIdsOf,
				},
			);

		it("drags only the pressed row when it is not a selection entry", () =>
		{
			expect([items("delta", []), items("c1", ["charlie"])]).toStrictEqual([
				{
					ids: ["delta"],
					home:
					{
						parentId: "dnd",
						index: 3,
					},
					selection: false,
				},
				{
					ids: ["c1"],
					home:
					{
						parentId: "charlie",
						index: 0,
					},
					selection: false,
				},
			]);
		});

		it("drags the whole selection in document order when the pressed row is an entry", () =>
		{
			expect(items("bravo", ["charlie", "bravo"])).toStrictEqual(
				{
					ids: ["bravo", "charlie"],
					home:
					{
						parentId: "dnd",
						index: 1,
					},
					selection: true,
				},
			);
		});

		it("has no home for a selection that is not one contiguous sibling block", () =>
		{
			expect([items("alpha", ["alpha", "charlie"]), items("bravo", ["bravo", "c1"])]).toStrictEqual([
				{
					ids: ["alpha", "charlie"],
					home: null,
					selection: true,
				},
				{
					ids: ["bravo", "c1"],
					home: null,
					selection: true,
				},
			]);
		});
	});

	describe("dropClearsSelection", () =>
	{
		const plan = (flashParentId: string | null) => (
		{
			move:
			{
				ids: ["bravo", "charlie"],
				parentId: "alpha",
				index: 0,
			},
			expandId: null,
			flashParentId,
			animate: flashParentId !== null,
			flashIds: ["bravo", "charlie"],
		});

		it("keeps the selection unless the rows dropped into a collapsed parent", () =>
		{
			expect([
				dropClearsSelection(plan(null)),
				dropClearsSelection(plan("alpha")),
				dropClearsSelection(
					{
						move: null,
						expandId: null,
						flashParentId: null,
						animate: false,
						flashIds: [],
					},
				),
			]).toStrictEqual([false, true, false]);
		});
	});

	describe("dropBulletDrag", () =>
	{
		const leafFacts =
		{
			childCount: 0,
			wasLeaf: true,
			wasCollapsed: false,
			defaultToBottom: false,
		};
		const dndFacts =
		{
			childCount: 5,
			wasLeaf: false,
			wasCollapsed: false,
			defaultToBottom: false,
		};
		const factsOf = (parentId: string) => (parentId === "dnd" ? dndFacts : leafFacts);
		const nothing =
		{
			move: null,
			expandId: null,
			flashParentId: null,
			animate: false,
			flashIds: [],
		};
		const stays =
		{
			...nothing,
			flashIds: ["delta"],
		};
		const dropOn = (parentId: string, index: number) =>
			dropBulletDrag(
				bulletDragReducer(
					dragging,
					{
						type: "hover",
						target:
						{
							parentId,
							index,
							ambiguous: false,
						},
						indicator: null,
					},
				),
				factsOf,
			);

		it("moves nothing when the parent and index are unchanged", () =>
		{
			expect([dropOn("dnd", 3), dropOn("dnd", 4)]).toStrictEqual([
				{
					state: IDLE_BULLET_DRAG,
					plan: stays,
					copy: null,
				},
				{
					state: IDLE_BULLET_DRAG,
					plan: stays,
					copy: null,
				},
			]);
		});

		it("plans the drop with the facts about the target's parent", () =>
		{
			expect([dropOn("dnd", 2), dropOn("charlie", 0)]).toStrictEqual([
				{
					state: IDLE_BULLET_DRAG,
					copy: null,
					plan:
					{
						move:
						{
							ids: ["delta"],
							parentId: "dnd",
							index: 2,
						},
						expandId: null,
						flashParentId: null,
						animate: false,
						flashIds: ["delta"],
					},
				},
				{
					state: IDLE_BULLET_DRAG,
					copy: null,
					plan:
					{
						move:
						{
							ids: ["delta"],
							parentId: "charlie",
							index: 0,
						},
						expandId: "charlie",
						flashParentId: null,
						animate: false,
						flashIds: ["delta"],
					},
				},
			]);
		});

		it("moves nothing when released before the drag started or with no target", () =>
		{
			expect([dropBulletDrag(armed, factsOf), dropBulletDrag(dragging, factsOf)]).toStrictEqual([
				{
					state: IDLE_BULLET_DRAG,
					plan: nothing,
					copy: null,
				},
				{
					state: IDLE_BULLET_DRAG,
					plan: nothing,
					copy: null,
				},
			]);
		});
	});

	describe("dropping on a left-bar slot", () =>
	{
		it("moves to the slot the left bar stored, with a collapsed parent landing at its default end", () =>
		{
			const hovering = bulletDragReducer(
				dragging,
				{
					type: "hover",
					target:
					{
						parentId: "alpha",
						index: 0,
						ambiguous: true,
					},
					indicator: null,
				},
			);
			const {plan} = dropBulletDrag(hovering, () => (
			{
				childCount: 2,
				wasLeaf: false,
				wasCollapsed: true,
				defaultToBottom: false,
			}));
			expect(plan.move).toStrictEqual(
				{
					ids: ["delta"],
					parentId: "alpha",
					index: 0,
				},
			);
		});
	});

	describe("planDrop", () =>
	{
		const facts =
		{
			childCount: 0,
			wasLeaf: false,
			wasCollapsed: false,
			defaultToBottom: false,
		};
		const nothing =
		{
			move: null,
			expandId: null,
			flashParentId: null,
			animate: false,
			flashIds: ["bravo", "charlie"],
		};

		it("drops into a collapsed parent at the top, keeps it collapsed, flashes it and animates", () =>
		{
			expect(
				planDrop(
					{
						target:
						{
							parentId: "alpha",
							index: 0,
							ambiguous: true,
						},
						draggingIds: ["delta"],
						home:
						{
							parentId: "dnd",
							index: 3,
						},
						...facts,
						childCount: 2,
						wasCollapsed: true,
					},
				),
			).toStrictEqual(
				{
					move:
					{
						ids: ["delta"],
						parentId: "alpha",
						index: 0,
					},
					expandId: null,
					flashParentId: "alpha",
					animate: true,
					flashIds: ["delta"],
				},
			);
		});

		it("drops into a collapsed defaultToBottom parent after its last child", () =>
		{
			expect(
				planDrop(
					{
						target:
						{
							parentId: "alpha",
							index: 0,
							ambiguous: true,
						},
						draggingIds: ["delta"],
						home:
						{
							parentId: "dnd",
							index: 3,
						},
						...facts,
						childCount: 2,
						wasCollapsed: true,
						defaultToBottom: true,
					},
				).move,
			).toStrictEqual(
				{
					ids: ["delta"],
					parentId: "alpha",
					index: 2,
				},
			);
		});

		it("expands a leaf it drops into, without the flash or the animation", () =>
		{
			expect(
				planDrop(
					{
						target:
						{
							parentId: "charlie",
							index: 0,
							ambiguous: false,
						},
						draggingIds: ["delta"],
						home:
						{
							parentId: "dnd",
							index: 3,
						},
						...facts,
						wasLeaf: true,
					},
				),
			).toStrictEqual(
				{
					move:
					{
						ids: ["delta"],
						parentId: "charlie",
						index: 0,
					},
					expandId: "charlie",
					flashParentId: null,
					animate: false,
					flashIds: ["delta"],
				},
			);
		});

		it("moves several dragged rows as one block", () =>
		{
			expect(
				planDrop(
					{
						target:
						{
							parentId: "dnd",
							index: 0,
							ambiguous: false,
						},
						draggingIds: ["bravo", "charlie"],
						home:
						{
							parentId: "dnd",
							index: 1,
						},
						...facts,
						childCount: 4,
					},
				),
			).toStrictEqual(
				{
					move:
					{
						ids: ["bravo", "charlie"],
						parentId: "dnd",
						index: 0,
					},
					expandId: null,
					flashParentId: null,
					animate: false,
					flashIds: ["bravo", "charlie"],
				},
			);
		});

		it("moves nothing when dropped back where the rows are", () =>
		{
			const home =
			{
				parentId: "dnd",
				index: 1,
			};
			const at = (index: number) =>
				planDrop(
					{
						target:
						{
							parentId: "dnd",
							index,
							ambiguous: false,
						},
						draggingIds: ["bravo", "charlie"],
						home,
						...facts,
						childCount: 4,
					},
				);
			expect([at(1), at(2), at(3)]).toStrictEqual([nothing, nothing, nothing]);
		});
	});

	describe("dropIndicatorFor", () =>
	{
		const children = ["alpha", "bravo", "charlie"];

		it("draws the line inside the parent for the first slot", () =>
		{
			expect(
				dropIndicatorFor(
					{
						parentId: "dnd",
						index: 0,
						ambiguous: false,
					},
					children,
					"p0",
				),
			).toStrictEqual(
				{
					kind: "in",
					paneId: "p0",
					parentId: "dnd",
				},
			);
		});

		it("draws the line under the child before the slot", () =>
		{
			expect(
				dropIndicatorFor(
					{
						parentId: "dnd",
						index: 2,
						ambiguous: false,
					},
					children,
					"p0",
				),
			).toStrictEqual(
				{
					kind: "at",
					paneId: "p0",
					rowId: "bravo",
				},
			);
		});

		it("draws nothing without a target", () =>
		{
			expect(dropIndicatorFor(null, children, "p0")).toBeNull();
		});
	});

	describe("buildDropRows", () =>
	{
		// DnD > [Alpha(collapsed) > [A1, A2], Bravo > [B1], Charlie, Delta]; A1 and A2 are not rendered.
		const parents: Record<string, string> =
		{
			alpha: "dnd",
			a1: "alpha",
			a2: "alpha",
			bravo: "dnd",
			b1: "bravo",
			charlie: "dnd",
			delta: "dnd",
		};
		const children: Record<string, string[]> =
		{
			dnd: ["alpha", "bravo", "charlie", "delta"],
			alpha: ["a1", "a2"],
			bravo: ["b1"],
		};
		const depth = (id: string): number => (id === "dnd" ? 0 : 1 + depth(parents[id] ?? "dnd"));
		const rows = buildDropRows(
			{
				order: ["dnd", "alpha", "bravo", "b1", "charlie", "delta"],
				parentOf: (id) => parents[id] ?? null,
				childIdsOf: (id) => children[id] ?? [],
				isCollapsed: (id) => id === "alpha",
				left: (id) => 80 + 36 * depth(id),
			},
		);

		it("walks rendered rows in document order", () =>
		{
			expect(
				["dnd", "alpha", "b1", "delta"].map((id) => [rows.previousInDocument(id), rows.nextInDocument(id)]),
			).toStrictEqual([
				[null, "alpha"],
				["dnd", "bravo"],
				["bravo", "charlie"],
				["charlie", null],
			]);
		});

		it("answers parent, index, rendering, collapse and ancestry from the tree", () =>
		{
			expect(
				{
					parent: rows.parentOf("b1"),
					index: rows.indexOf("charlie"),
					renderedA1: rows.isRendered("a1"),
					renderedB1: rows.isRendered("b1"),
					collapsed: rows.isCollapsed("alpha"),
					descendant: rows.isDescendantOf("b1", "dnd"),
					notDescendant: rows.isDescendantOf("b1", "alpha"),
					left: rows.left("b1"),
				},
			).toStrictEqual(
				{
					parent: "bravo",
					index: 2,
					renderedA1: false,
					renderedB1: true,
					collapsed: true,
					descendant: true,
					notDescendant: false,
					left: 152,
				},
			);
		});

		it("feeds the drop-target resolver", () =>
		{
			expect(
				resolveDropTarget(
					{
						x: 90,
						rows,
						predecessorId: "b1",
						movingIds: new Set(["delta"]),
						zoomRootId: "dnd",
					},
				),
			).toStrictEqual(
				{
					parentId: "dnd",
					index: 2,
					ambiguous: false,
				},
			);
		});
	});

	describe("drop rotate animation CSS", () =>
	{
		it("swings the moved bullet half a turn under its new collapsed parent", () =>
		{
			const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8")
				.replaceAll(/\s+/gu, "")
				.replaceAll(";}", "}");
			expect(
				{
					rule: css.includes(
						".moved-bullet-rotate{position:fixed;z-index:200;width:18px;height:18px;border-radius:14px;pointer-events:none;color:var(--wf-text-primary);animation:animateMovedBulletUnderneathNewParent0.4sease-outforwards}",
					),
					keyframes: css.includes(
						"@keyframesanimateMovedBulletUnderneathNewParent{0%{transform:rotate(0deg)}100%{transform:rotate(-180deg)}}",
					),
				},
			).toStrictEqual(
				{
					rule: true,
					keyframes: true,
				},
			);
		});
	});

	describe("Found Dates drag", () =>
	{
		/** A row whose nearest enclosing `.project` carries `classes`. */
		const rowUnder = (classes: string[] | null) => (
		{
			parentElement:
			{
				closest: () =>
					classes === null
						? null
						:
							{
								classList:
								{
									contains: (name: string) => classes.includes(name),
								},
							},
			},
		});

		it("recognises a row listed under the Found Dates container by its upstream class", () =>
		{
			expect(
				{
					found: isFoundDateRow(rowUnder(["font-custom", "project", "open", "[&_>.name>.itemMenu]:hidden"])),
					nested: isFoundDateRow(rowUnder(["project", "open"])),
					top: isFoundDateRow(rowUnder(null)),
				},
			).toStrictEqual(
				{
					found: true,
					nested: false,
					top: false,
				},
			);
		});

		// Day > [Lunch]; the Found Dates rows (Ship, from elsewhere) render after it but are not in the day's tree.
		const rows = buildDropRows(
			{
				order: ["day", "lunch"],
				parentOf: (id) =>
					(
					{
						lunch: "day",
						ship: "alpha",
						alpha: "projects",
					})[id] ?? null,
				childIdsOf: (id) => (id === "day" ? ["lunch"] : id === "alpha" ? ["ship"] : []),
				isCollapsed: () => false,
				left: (id) => (id === "day" ? 80 : 116),
			},
		);

		it("drops a found row onto the day among its children, never into Found Dates", () =>
		{
			const target = (predecessorId: string) =>
				resolveDropTarget(
					{
						x: 120,
						rows,
						predecessorId,
						movingIds: new Set(["ship"]),
						zoomRootId: "day",
					},
				);
			expect(
				{
					onDay: target("lunch"),
					onFound: target("ship"),
				},
			).toStrictEqual(
				{
					onDay:
					{
						parentId: "day",
						index: 1,
						ambiguous: false,
					},
					onFound: null,
				},
			);
		});
	});
});

describe("bullet halo css", () =>
{
	const styles = readFileSync(fileURLToPath(new URL("../src/client/styles.css", import.meta.url)), "utf8");
	const uncommented = styles.replaceAll(/\/\*[\s\S]*?\*\//gu, "");
	const selectors = [...uncommented.matchAll(/([^{}]+)\{[^{}]*\}/gu)].map((match) =>
		match[1].trim().replaceAll(/\s+/gu, " "),
	);

	describe("bullet halo rules", () =>
	{
		it("has no selector naming .diamond, as upstream has none", () =>
		{
			expect(selectors.filter((selector) => selector.includes(".diamond"))).toStrictEqual([]);
		});

		it("scopes the hover halo to .is-desktop and orders it after the collapsed rule", () =>
		{
			const hover = ".is-desktop .bullet:hover > .bulletHalo, .is-desktop .dragging > .bullet > .bulletHalo";
			const collapsed = ".collapsed > .name > .bullet > .bulletHalo, .bullet.bullet--show-halo > .bulletHalo";
			expect(selectors.includes(hover)).toBe(true);
			expect(selectors.indexOf(hover)).toBeGreaterThan(selectors.indexOf(collapsed));
			expect(selectors.includes(".bullet:hover > .bulletHalo")).toBe(false);
		});
	});
});
