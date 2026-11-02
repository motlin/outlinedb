import {useQueryClient} from "@tanstack/react-query";
import {lineSplitRequests} from "../line-split.js";
import {plainText} from "../rich-text.js";
import {HOME_TARGET} from "@outlinedb/shared/types";
import {readChildren, readNode} from "../node-cache.js";
import type {ItemTypeSelectDeps} from "../item-type-select.js";
import {activePaneView, useOutlineStore} from "../stores/outline.js";
import {structureTable} from "../table-actions.js";
import {useTableDeps} from "./use-table-actions.js";
import {useCreateNode, useUpdateNode} from "./use-nodes.js";

/** What choosing a "Turn into" type needs from the outline: layout writes, expansion and the cached tree. */
export function useItemTypeSelectDeps(): ItemTypeSelectDeps
{
	const queryClient = useQueryClient();
	const updateNode = useUpdateNode();
	const createNode = useCreateNode();
	const tableDeps = useTableDeps();
	return {
		structureTable: (nodeId, on) =>
		{
			void structureTable(tableDeps, nodeId, on);
		},
		update: (nodeId, layoutMode, extra) =>
		{
			updateNode.mutate(
				{
					nodeId,
					layoutMode,
					...extra,
				},
			);
		},
		plainName: (nodeId) => plainText(readNode(queryClient, nodeId)?.name ?? "", ""),
		createAfter: (nodeId, lines) =>
		{
			for (const request of lineSplitRequests(
				queryClient,
				lines.map((line) => (
				{
					afterId: nodeId,
					...line,
				})),
			))
			{
				createNode.mutate(request);
			}
		},
		hasNote: (nodeId) => (readNode(queryClient, nodeId)?.note ?? "") !== "",
		expandAll: (ids) =>
		{
			const {expandedIds, replaceExpanded} = activePaneView();
			replaceExpanded(new Set([...expandedIds, ...ids]));
		},
		childIds: (nodeId) =>
			(readChildren(queryClient, nodeId === HOME_TARGET ? null : nodeId) ?? []).map((child) => child.id),
		createChild: (parentId) =>
		{
			const id = crypto.randomUUID();
			createNode.mutate(
				{
					id,
					parent_id: parentId === HOME_TARGET ? undefined : parentId,
					name: "",
					index: 0,
				},
			);
			return id;
		},
		startEditing: (nodeId) =>
		{
			useOutlineStore.getState().resumeEditing(nodeId, 0);
		},
		layoutMode: (nodeId) => readNode(queryClient, nodeId)?.data.layoutMode ?? null,
	};
}
