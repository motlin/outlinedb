import {describe, expect, it, vi} from "vite-plus/test";
import type {UndoAdapter} from "../src/client/undo-batch.js";
import type {UndoRunner} from "../src/client/undo-view-state.js";

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

const {selectedIdsOf} = await import("../src/client/item-selection.js");
const {useOutlineStore} = await import("../src/client/stores/outline.js");
const {applyOps} = await import("../src/client/undo-batch.js");
const {undoHistory} = await import("../src/client/undo-history.js");
const {queueUndo} = await import("../src/client/undo-view-state.js");

describe("queueUndo with the outline store", () =>
{
	it("undoing a delete restores the original id and reselects it", async () =>
	{
		const restored: [
			string,
			{
				parent_id: string | null;
				index: number;
			},
		][] = [];
		const adapter: UndoAdapter =
		{
			async updateNode()
			{
				return Promise.resolve();
			},
			async deleteNode()
			{
				return Promise.resolve();
			},
			async restoreNode(nodeId, request)
			{
				restored.push([nodeId, request]);
				return Promise.resolve();
			},
			async moveNode()
			{
				return Promise.resolve();
			},
			async completeNode()
			{
				return Promise.resolve();
			},
			async uncompleteNode()
			{
				return Promise.resolve();
			},
			async updateLayout()
			{
				return Promise.resolve();
			},
			async setTagColor()
			{
				return Promise.resolve();
			},
			async removeTagColor()
			{
				return Promise.resolve();
			},
		};
		undoHistory.clear();
		useOutlineStore.getState().clearItemSelection();
		undoHistory.push(
			{
				ops: [
					{
						kind: "delete",
						nodeId: "echo",
						parentId: "p",
						index: 2,
					},
				],
				before:
				{
					zoomedNodeId: null,
					editing: null,
					selectedIds: ["echo"],
				},
				after:
				{
					zoomedNodeId: null,
					editing: null,
					selectedIds: [],
				},
			},
		);
		const runner: UndoRunner =
		{
			flush()
			{
			},
			async settled()
			{
				return Promise.resolve();
			},
			pop: () => undoHistory.popUndo(),
			blur()
			{
			},
			hold: () => () =>
			{
			},
			preview()
			{
			},
			async apply(applied)
			{
				return applyOps(applied, adapter);
			},
			async reconcile()
			{
				return Promise.resolve();
			},
			current: () => (
			{
				zoomedNodeId: null,
				editing: null,
				selectedIds: [],
			}),
			editorFocused: () => false,
			textLength: () => 0,
			zoomTo()
			{
			},
			select(ids)
			{
				useOutlineStore.getState().restoreItemSelection(ids);
			},
			focus()
			{
			},
		};
		await queueUndo("undo", runner);
		expect(
			{
				restored,
				selection: selectedIdsOf(useOutlineStore.getState().itemSelection),
			},
		).toStrictEqual(
			{
				restored: [
					[
						"echo",
						{
							parent_id: "p",
							index: 2,
						},
					],
				],
				selection: ["echo"],
			},
		);
	});
});
