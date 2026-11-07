import {useQuery, useQueryClient} from "@tanstack/react-query";
import {useEffect} from "react";
import {navigableIds} from "../caret-navigation.js";
import {readNode} from "../node-cache.js";
import {runShowCompletedToggle} from "../show-completed-toggle.js";
import {flushEditing, useOutlineStore} from "../stores/outline.js";
import {preferencesQuery, serverShowCompleted} from "./use-preferences.js";
import {collectVisibleNodeIds} from "./use-visible-nodes.js";

/** Show/hide completed with upstream's slide animations and caret fallback. */
export function useShowCompletedToggle(): () => void {
	const queryClient = useQueryClient();
	return () => {
		const state = useOutlineStore.getState();
		const {zoomedNodeId, expandedIds} = state;
		runShowCompletedToggle({
			showCompleted: state.showCompleted,
			editingId: state.editingId,
			rowsFor: (showCompleted) =>
				navigableIds(
					zoomedNodeId,
					collectVisibleNodeIds(queryClient, zoomedNodeId, expandedIds, showCompleted, new Set()),
				),
			isCompleted: (id) => (readNode(queryClient, id)?.completedAt ?? null) !== null,
			actions: {
				...state,
				resumeEditing: (id, caretOffset) => {
					// The hidden row's blur no longer commits once editing moves, so save its text first
					flushEditing();
					state.resumeEditing(id, caretOffset);
				},
			},
		});
	};
}

/** Adopt the account's show-completed setting whenever `/api/v1/preferences` reports a value. */
export function useShowCompletedSync(): void {
	const {data} = useQuery(preferencesQuery);
	const showCompleted = serverShowCompleted(data);
	useEffect(() => {
		if (showCompleted !== null) {
			useOutlineStore.getState().adoptShowCompleted(showCompleted);
		}
	}, [showCompleted]);
}
