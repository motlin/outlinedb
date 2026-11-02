import type {QueryClient} from "@tanstack/react-query";
import {currentSelectionView} from "./hooks/use-selection-keymap.js";
import type {FocusMaintainEnv} from "./focus-maintain.js";
import {useOutlineStore} from "./stores/outline.js";

/** `maintainFocus` over the live outline store and query cache. */
export function liveFocusEnv(queryClient: QueryClient): FocusMaintainEnv
{
	return {
		firstId: () =>
		{
			const {editingId, itemSelection} = useOutlineStore.getState();
			return editingId ?? itemSelection.entries[0]?.id ?? null;
		},
		position: (id) =>
		{
			const rows = currentSelectionView(queryClient).rows;
			const parentId = rows.find((row) => row.id === id)?.parentId ?? null;
			return {
				parentId,
				index: rows.filter((row) => row.parentId === parentId).findIndex((row) => row.id === id),
			};
		},
		rows: () => currentSelectionView(queryClient).rows,
		selectionActive: () => useOutlineStore.getState().itemSelection.entries.length > 0,
		editorFocused: () => useOutlineStore.getState().editingId !== null,
		resume: (id) =>
		{
			useOutlineStore.getState().resumeEditing(id, Number.MAX_SAFE_INTEGER);
		},
		defer: (callback) =>
		{
			setTimeout(callback, 0);
		},
	};
}
