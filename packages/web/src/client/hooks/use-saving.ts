import {useIsMutating} from "@tanstack/react-query";
import type {QueryClient} from "@tanstack/react-query";
import {useEffect, useState} from "react";

import {flushEditing, useOutlineStore} from "../stores/outline.js";

/** Upstream's `Wr1`: a save state shorter than this never reaches the footer, so a fast save never flashes "Saving...". */
const SYNC_STATE_DELAY_MS = 500;

/**
 * Debounces the saving flag. Each `set` replaces the pending change, and a value equal to the last applied one
 * is dropped.
 */
export function createSyncStateDebouncer(
	apply: (saving: boolean) => void,
	delayMs = SYNC_STATE_DELAY_MS,
	initial = false,
): (saving: boolean) => void
{
	let applied = initial;
	let timer: ReturnType<typeof setTimeout> | undefined;
	return (saving) =>
	{
		clearTimeout(timer);
		timer = undefined;
		if (saving === applied)
		{
			return;
		}
		timer = setTimeout(() =>
		{
			timer = undefined;
			applied = saving;
			apply(saving);
		}, delayMs);
	};
}

/** The raw "a write is in flight" state: any TanStack mutation, or an undo/redo replay. */
function useRawSaving(): boolean
{
	const mutating = useIsMutating() > 0;
	const replaying = useOutlineStore((state) => state.replayCount > 0);
	return mutating || replaying;
}

/** Upstream's `syncState === 1` (syncing), debounced by 500ms. */
export function useSaving(): boolean
{
	const raw = useRawSaving();
	const [saving, setSaving] = useState(raw);
	const [set] = useState(() => createSyncStateDebouncer(setSaving, SYNC_STATE_DELAY_MS, raw));
	useEffect(() =>
	{
		set(raw);
	}, [raw, set]);
	return saving;
}

let trackedClient: QueryClient | undefined;

function stampIfIdle(): void
{
	if (trackedClient?.isMutating() === 0 && useOutlineStore.getState().replayCount === 0)
	{
		useOutlineStore.setState(
			{
				lastSavedAt: Date.now(),
			},
		);
	}
}

/** Counts an undo/redo replay (which bypasses `useMutation`) as a write in flight until it settles. */
export async function trackReplay<T>(promise: Promise<T>): Promise<T>
{
	useOutlineStore.setState((state) => (
	{
		replayCount: state.replayCount + 1,
	}));
	try
	{
		return await promise;
	}
	finally
	{
		useOutlineStore.setState((state) => (
		{
			replayCount: Math.max(0, state.replayCount - 1),
		}));
		stampIfIdle();
	}
}

/** Upstream's `Cl0` verdict: leaving the page would lose a write that has not reached the server. */
export function beforeUnloadResult({inFlight, editPending}: {inFlight: number; editPending: boolean}): true | undefined
{
	return inFlight > 0 || editPending ? true : undefined;
}

/**
 * Stamps `lastSavedAt` when the last write settles, and guards `window.onbeforeunload`. The guard first flushes the
 * focused edit, like upstream's `saveFocused()`, so a pending text save becomes an in-flight mutation that is counted.
 */
export function installSaveTracking(queryClient: QueryClient, target?: Pick<Window, "onbeforeunload">): void
{
	trackedClient = queryClient;
	queryClient.getMutationCache().subscribe((event) =>
	{
		if (
			event.type === "updated" &&
			(event.mutation.state.status === "success" || event.mutation.state.status === "error")
		)
		{
			stampIfIdle();
		}
	});
	if (target !== undefined)
	{
		// oxlint-disable-next-line unicorn/prefer-add-event-listener -- upstream assigns window.onbeforeunload
		target.onbeforeunload = (event) =>
		{
			flushEditing();
			const result = beforeUnloadResult(
				{
					inFlight: queryClient.isMutating() + useOutlineStore.getState().replayCount,
					editPending: false,
				},
			);
			if (result)
			{
				event.preventDefault();
			}
			return result;
		};
	}
}
