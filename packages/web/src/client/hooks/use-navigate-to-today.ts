import {useQueryClient} from "@tanstack/react-query";
import {seedResolvedId} from "../node-cache.js";
import {useStableNavigate} from "./use-stable-navigate.js";
import {editorElement} from "../caret-dom.js";
import {locationUrl} from "../location.js";
import {useOutlineStore} from "../stores/outline.js";
import {navigateToCalendarDate, navigateToToday} from "../today.js";
import type {CalendarTarget, NavigateToCalendarDeps} from "../today.js";

/**
 * The calendar navigation deps bound to the outline store, zooming `zoomTo` when given (an open pane's zoom) and the
 * main outline's URL otherwise.
 */
function useCalendarDeps(zoomTo?: (id: string) => void): () => NavigateToCalendarDeps
{
	const navigate = useStableNavigate();
	const queryClient = useQueryClient();
	return () =>
	{
		const store = useOutlineStore.getState();
		return {
			fetch: globalThis.fetch,
			seedResolved: (id) =>
			{
				seedResolvedId(queryClient, id);
			},
			zoomTo:
				zoomTo ??
				((id) =>
				{
					void navigate(
						locationUrl(
							{
								id,
							},
						),
					);
				}),
			notify: store.addErrorNotification,
			startEditing: store.resumeEditing,
			commitEdit: () =>
			{
				const {editingId} = useOutlineStore.getState();
				if (editingId !== null)
				{
					editorElement(editingId)?.blur();
				}
			},
		};
	};
}

/**
 * `navigateToToday` bound to the router and the outline store; shared by ⌃T, the Today button and the Today row. A pane
 * header's Today passes its pane's zoom.
 */
export function useNavigateToToday(zoomTo?: (id: string) => void): () => Promise<void>
{
	const deps = useCalendarDeps(zoomTo);
	return async () =>
	{
		await navigateToToday(
			{
				...deps(),
				now: new Date(),
			},
		);
	};
}

/** `navigateToCalendarDate` bound to the router and the outline store; used by the day strip. */
export function useNavigateToCalendarDate(): (target: CalendarTarget) => Promise<void>
{
	const deps = useCalendarDeps();
	return async (target) =>
	{
		await navigateToCalendarDate(target, deps());
	};
}
