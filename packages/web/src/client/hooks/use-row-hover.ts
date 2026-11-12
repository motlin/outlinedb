import {useEffect, useSyncExternalStore} from "react";
import {pickHoverProbeOffsets, resolveHoveredRow} from "../gutter-hover.js";
import {getHoveredRowId, setHoveredRowId, subscribeHoveredRow} from "../hovered-row.js";
import {useOutlineStore} from "../stores/outline.js";

const THROTTLE_MS = 50;

/** Whether `rowId` is the hovered row, by a direct hover or the gutter probe. */
export function useIsRowHovered(rowId: string): boolean
{
	return useSyncExternalStore(
		subscribeHoveredRow,
		() => getHoveredRowId() === rowId,
		() => false,
	);
}

/** Installs upstream's throttled document `mousemove` hover controller, once. */
export function useRowHoverController(): void
{
	useEffect(() =>
	{
		let last = 0;
		const onMove = (event: MouseEvent) =>
		{
			const now = Date.now();
			if (now - last < THROTTLE_MS)
			{
				return;
			}
			last = now;
			const offsets = pickHoverProbeOffsets(useOutlineStore.getState().panes.length > 0);
			setHoveredRowId(
				resolveHoveredRow(
					event.target,
					(dx) => document.elementFromPoint(event.clientX + dx, event.clientY),
					offsets,
				),
			);
		};
		document.addEventListener("mousemove", onMove);
		return () =>
		{
			document.removeEventListener("mousemove", onMove);
			setHoveredRowId(null);
		};
	}, []);
}
