import {useMemo} from "react";
import {useQueryClient} from "@tanstack/react-query";
import type {QueryClient} from "@tanstack/react-query";
import {confirmAction} from "../alert.js";
import {captureOutlineView, runInUndoBatch} from "../undo-batch.js";
import {activePaneView, useOutlineStore} from "../stores/outline.js";
import type {TableDeps} from "../table-actions.js";
import {nodeKeys} from "../node-cache.js";
import {copyNodesAt, fetchChildren, useCreateNode, useDeleteNode, useMoveNode, useUpdateNode} from "./use-nodes.js";

type Create = (request: {id: string; parent_id: string; name: string; index: number}) => void;
type Remove = (id: string) => void;
type Move = (request: {nodeId: string; parent_id: string; index: number}) => void;
type Update = (request: {
	nodeId: string;
	tableSet:
	{
		path: string[];
		value: unknown;
	}[];
}) => void;

/** The table commands' side effects wired to the node mutations, the outline's expansion and its caret. */
export function makeTableDeps(
	queryClient: QueryClient,
	mutations:
	{
		create: Create;
		remove: Remove;
		move: Move;
		update: Update;
	},
): TableDeps
{
	return {
		queryClient,
		create: mutations.create,
		remove: mutations.remove,
		move: (id, parentId, index) =>
		{
			mutations.move(
				{
					nodeId: id,
					parent_id: parentId,
					index,
				},
			);
		},
		duplicate: async (ids, parentId, index) => copyNodesAt(queryClient, "duplicate", ids, parentId, index),
		setTable: (id, path, value) =>
		{
			mutations.update(
				{
					nodeId: id,
					tableSet: [
						{
							path,
							value,
						},
					],
				},
			);
		},
		expand: (ids) =>
		{
			const view = activePaneView();
			view.replaceExpanded(new Set([...view.expandedIds, ...ids]));
		},
		focus: (id, caret) =>
		{
			useOutlineStore.getState().resumeEditing(id, caret === "end" ? Number.MAX_SAFE_INTEGER : 0);
		},
		loadChildren: async (parentId) =>
			queryClient.query(
				{
					queryKey: nodeKeys.children(parentId),
					queryFn: async () => fetchChildren(parentId),
					staleTime: 30_000,
				},
			),
		confirm: async (message) => confirmAction(message, "Are you sure?", "Delete"),
		batch: async (fn) => runInUndoBatch(captureOutlineView, fn),
	};
}

/** `makeTableDeps` over the app's own mutation hooks, for the table components. */
export function useTableDeps(): TableDeps
{
	const queryClient = useQueryClient();
	const {mutate: create} = useCreateNode();
	const {mutate: remove} = useDeleteNode();
	const {mutate: move} = useMoveNode();
	const {mutate: update} = useUpdateNode();
	return useMemo(
		() =>
			makeTableDeps(
				queryClient,
				{
					create,
					remove,
					move,
					update,
				},
			),
		[queryClient, create, remove, move, update],
	);
}
