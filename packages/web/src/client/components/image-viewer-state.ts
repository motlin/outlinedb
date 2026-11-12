import {useSyncExternalStore} from "react";

/** The node whose image the full-screen viewer shows (upstream `WF.Files.image.full.show`), or null when it is closed. */
let shownId: string | null = null;
const listeners = new Set<() => void>();

function emit(): void
{
	for (const listener of listeners)
	{
		listener();
	}
}

function getShownImageId(): string | null
{
	return shownId;
}

export function showImageViewer(nodeId: string): void
{
	if (shownId !== nodeId)
	{
		shownId = nodeId;
		emit();
	}
}

export function hideImageViewer(): void
{
	if (shownId !== null)
	{
		shownId = null;
		emit();
	}
}

function subscribe(listener: () => void): () => void
{
	listeners.add(listener);
	return () =>
	{
		listeners.delete(listener);
	};
}

export function useShownImageId(): string | null
{
	return useSyncExternalStore(subscribe, getShownImageId, () => null);
}
