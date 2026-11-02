import type {QueryClient} from "@tanstack/react-query";
import {RequestStatusError} from "./request-error.js";

export type SyncEvent =
	| "write-failed-network"
	| "write-failed-client"
	| "write-succeeded"
	| "browser-offline"
	| "browser-online";

export const SYNC_WARNING_TITLE = "Warning: We are unable to save your changes right now.";
export const SYNC_WARNING_TEXT = "Your changes will be saved when we can reconnect to the server.";

/** Upstream warns on the 2nd consecutive failed push. */
const WARN_AFTER_FAILURES = 2;
/** Upstream's watchdog (`a94`): a push in flight this long marks the app as stalled. */
const STALL_AFTER_MS = 120_000;

export function syncHealth(
	state:
	{
		failures: number;
	},
	event: SyncEvent,
):
{
	failures: number;
	warn: boolean;
}
{
	let failures = state.failures;
	if (event === "write-failed-network" || event === "browser-offline")
	{
		failures += 1;
	}
	else if (event === "write-succeeded")
	{
		failures = 0;
	}
	return {
		failures,
		warn: failures >= WARN_AFTER_FAILURES,
	};
}

export function classifyWriteFailure(error: unknown): "write-failed-network" | "write-failed-client"
{
	if (error instanceof TypeError || (error instanceof RequestStatusError && error.status >= 500))
	{
		return "write-failed-network";
	}
	return "write-failed-client";
}

export function isStalled({
	oldestInFlightStartedAt,
	now,
}: {
	oldestInFlightStartedAt: number | null;
	now: number;
}): boolean
{
	return oldestInFlightStartedAt !== null && now - oldestInFlightStartedAt >= STALL_AFTER_MS;
}

export function oldestInFlightStart(
	mutations: readonly
	{
		state:
		{
			status: string;
			submittedAt: number;
		};
	}[],
): number | null
{
	let oldest: number | null = null;
	for (const {state} of mutations)
	{
		if (state.status === "pending" && (oldest === null || state.submittedAt < oldest))
		{
			oldest = state.submittedAt;
		}
	}
	return oldest;
}

/** Feeds settled mutations into `onEvent`. Returns the unsubscribe. */
export function watchMutations(queryClient: QueryClient, onEvent: (event: SyncEvent) => void): () => void
{
	return queryClient.getMutationCache().subscribe((cacheEvent) =>
	{
		if (cacheEvent.type !== "updated")
		{
			return;
		}
		const {action, mutation} = cacheEvent;
		if (action.type === "error")
		{
			onEvent(classifyWriteFailure(mutation.state.error));
		}
		else if (action.type === "success")
		{
			onEvent("write-succeeded");
		}
	});
}
