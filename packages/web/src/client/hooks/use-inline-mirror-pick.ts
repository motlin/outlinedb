import {useQueryClient} from "@tanstack/react-query";
import {useCallback} from "react";
import type {RefObject} from "react";
import {renderEditorHtml} from "../editor-html.js";
import {inlineMirrorRefusal, planInlineMirror} from "../inline-mirror.js";
import {goToNode} from "../navigation.js";
import {readChildren, readNode} from "../node-cache.js";
import {activePaneView, useOutlineStore} from "../stores/outline.js";
import {sortByPriority} from "../tree-position.js";
import {captureOutlineView, runInUndoBatch} from "../undo-batch.js";
import {useAccount} from "./use-account.js";
import {useDateSettings} from "./use-preferences.js";
import {useStableNavigate} from "./use-stable-navigate.js";
import {mirrorNodeAt, useCreateNode, useDeleteNode, useUpdateNode} from "./use-nodes.js";
import type {MirrorPick} from "./use-mirror-menu.js";

const TOAST_TIMEOUT = 5000;

/**
 * Choosing a location in the `((` popup (upstream `MIRROR_SEARCH_POPUP` select): a row that was only `((…))` is
 * replaced by the mirror (and the view follows it when the row was the zoom root); otherwise the row keeps the text
 * before the chip, the mirror takes the next slot and the text after the chip becomes a row after it.
 */
export function useInlineMirrorPick({
	nodeId,
	parentId,
	contentRef,
	resetSaved,
}: {
	nodeId: string;
	parentId: string | null;
	contentRef: RefObject<HTMLElement | null>;
	resetSaved: (name: string) => void;
}): (pick: MirrorPick) => void
{
	const queryClient = useQueryClient();
	const navigate = useStableNavigate();
	const updateNode = useUpdateNode();
	const createNode = useCreateNode();
	const deleteNode = useDeleteNode();
	const dateSettings = useDateSettings();
	const account = useAccount();

	return useCallback(
		({hit, beforeHtml, afterHtml}) =>
		{
			const store = useOutlineStore.getState();
			const lineage: string[] = [];
			for (
				let id: string | null = parentId;
				id !== null && !lineage.includes(id);
				id = readNode(queryClient, id)?.parent_id ?? null
			)
			{
				lineage.push(id);
			}
			const refusal = inlineMirrorRefusal(
				{
					pickId: hit.id,
					rowId: nodeId,
					parentLineage: lineage,
				},
			);
			const plan = planInlineMirror(
				{
					beforeHtml,
					afterHtml,
				},
			);
			const content = contentRef.current;
			if (plan.kind === "split" && content !== null)
			{
				content.innerHTML = renderEditorHtml(plan.before, dateSettings, account);
				resetSaved(plan.before);
			}
			if (refusal !== null)
			{
				store.showAppMessage(
					refusal,
					{
						timeout: TOAST_TIMEOUT,
						type: "failure",
					},
				);
				return;
			}
			const isZoomRoot = activePaneView().zoomedNodeId === nodeId;
			const rowIndex = Math.max(
				sortByPriority(readChildren(queryClient, parentId) ?? []).findIndex((sibling) => sibling.id === nodeId),
				0,
			);
			void runInUndoBatch(captureOutlineView, async () =>
			{
				if (plan.kind === "replace-row")
				{
					const mirrorId = await mirrorNodeAt(queryClient, hit.id, parentId, rowIndex);
					deleteNode.mutate(nodeId);
					if (isZoomRoot && mirrorId !== undefined)
					{
						goToNode(navigate, mirrorId);
					}
					return;
				}
				updateNode.mutate(
					{
						nodeId,
						name: plan.before,
					},
				);
				await mirrorNodeAt(queryClient, hit.id, parentId, rowIndex + 1);
				if (plan.after.trim() !== "")
				{
					createNode.mutate(
						{
							parent_id: parentId ?? undefined,
							index: rowIndex + 2,
							name: plan.after,
						},
					);
				}
			}).catch((error: unknown) =>
			{
				store.addErrorNotification(
					`Failed to mirror: ${error instanceof Error ? error.message : "request failed"}`,
				);
			});
		},
		[
			account,
			contentRef,
			createNode,
			dateSettings,
			deleteNode,
			navigate,
			nodeId,
			parentId,
			queryClient,
			resetSaved,
			updateNode,
		],
	);
}
