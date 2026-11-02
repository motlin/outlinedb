/**
 * Expansion state synced with the server's expansion store: hydrate `expandedIds` from `GET /api/v1/expansion` on app
 * load, then poll its change feed (`?version=<version>`, the keys' content version) on a TanStack Query refetch
 * interval, on tab focus, and on each `expansion.changed` frame the events socket carries with a new version, so changes
 * made in another tab, or by an import, show up. A poll costs one SQLite read
 * and answers no ids while the keys still match. The outline store PATCHes each local change itself.
 *
 * The server's store is the source of truth: workflowy.com's own list is read only by whole-tree imports, so an
 * expansion change made on workflowy.com shows after the next import, as upstream's browsers see each other's changes
 * only on reload.
 */

import {useQuery} from "@tanstack/react-query";
import type {QueryClient} from "@tanstack/react-query";
import {useEffect} from "react";
import type {ExpansionChangesResponse} from "../../node-types.js";
import {readJson} from "../read-json.js";
import
{
	disableExpansionPersistence,
	isExpansionPersisted,
	localExpansionChangeState,
	useOutlineStore,
} from "../stores/outline.js";

/** A visible tab polls the change feed this often; an unchanged store answers no ids. */
export const EXPANSION_POLL_MS = 15_000;

/** An expansion GET that has not answered by then is aborted and treated as a failure. */
const EXPANSION_FETCH_TIMEOUT_MS = 30_000;

/**
 * A local change reaches the server's store only after its debounced push lands, so a poll this soon after one may
 * still hold the old value; skip the poll rather than revert it.
 */
const LOCAL_CHANGE_GRACE_MS = 5000;

/**
 * The page-load GET waits out an API server restart (the dev proxy's 502/504, or a refused connection) on this backoff,
 * about 23s in all, instead of logging an error and leaving the page without the account's expanded levels.
 */
const LOAD_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 8000];

let loading: Promise<void> | undefined;
let loadSettled = false;
/** The change feed's cursor: the `version` of the last answer applied. */
let version: string | undefined;

/**
 * Adopt the account's expanded ids and the feed's version; on 503 expansion stays in memory for the session. One GET per
 * page load: later calls (StrictMode's second effect) share it.
 */
export async function loadExpansion(): Promise<void>
{
	loading ??= fetchInitial().finally(() =>
	{
		loadSettled = true;
	});
	return loading;
}

async function fetchInitial(): Promise<void>
{
	try
	{
		const response = await fetchThroughRestart("/api/v1/expansion", LOAD_RETRY_DELAYS_MS);
		if (response.status === 503)
		{
			disableExpansionPersistence();
			return;
		}
		if (!response.ok)
		{
			console.error(`Failed to load expansion: ${response.status}`);
			return;
		}
		const body = await readJson<ExpansionChangesResponse>(response);
		applyExpandedIds(body.expandedIds ?? []);
		({version} = body);
	}
	catch (error)
	{
		console.error("Failed to load expansion", error);
	}
}

/**
 * Whether the page load's expansion GET is still in flight. Its body holds every expanded id in the account (over a
 * megabyte), so a view loaded meanwhile asks the server to expand the account's rows instead of waiting on it.
 */
export function initialExpansionPending(): boolean
{
	return loading !== undefined && !loadSettled;
}

/**
 * Expand the rows a view load found expanded in the account, so they render expanded with the first rows; the page
 * load's GET replaces the whole set when it lands. Ignored once that GET has been applied, which already holds them.
 */
export function adoptViewExpansion(ids: readonly string[]): void
{
	const current = useOutlineStore.getState().expandedIds;
	if (!initialExpansionPending() || ids.every((id) => current.has(id)))
	{
		return;
	}
	useOutlineStore.getState().setExpanded(new Set([...current, ...ids]));
}

/**
 * Ask the change feed whether the keys differ from the version and apply them without PATCHing them back. Skipped
 * before the page load has set a version and right after a local change; a response is discarded, and the version
 * kept, when a local change lands while it is in flight.
 */
export async function pollExpansion(now = Date.now()): Promise<void>
{
	if (!isExpansionPersisted() || version === undefined)
	{
		return;
	}
	const local = localExpansionChangeState();
	if (now - local.at < LOCAL_CHANGE_GRACE_MS)
	{
		return;
	}
	try
	{
		const response = await fetchExpansionBody(`/api/v1/expansion?version=${version}`);
		if (!response.ok)
		{
			console.error(`Failed to poll expansion: ${response.status}`);
			return;
		}
		const body = await readJson<ExpansionChangesResponse>(response);
		if (localExpansionChangeState().count !== local.count)
		{
			return;
		}
		if (body.expandedIds !== null)
		{
			applyExpandedIds(body.expandedIds);
		}
		({version} = body);
	}
	catch (error)
	{
		console.error("Failed to poll expansion", error);
	}
}

function applyExpandedIds(expandedIds: readonly string[]): void
{
	const next = new Set(expandedIds);
	if (!sameIds(useOutlineStore.getState().expandedIds, next))
	{
		useOutlineStore.getState().setExpanded(next);
	}
}

/** A GET that aborts after the timeout. */
async function fetchExpansionBody(url: string): Promise<Response>
{
	const controller = new AbortController();
	const timer = setTimeout(() =>
	{
		controller.abort();
	}, EXPANSION_FETCH_TIMEOUT_MS);
	try
	{
		return await fetch(
			url,
			{
				signal: controller.signal,
			},
		);
	}
	finally
	{
		clearTimeout(timer);
	}
}

/** GET `url`, retrying after each delay while the API server is restarting; the last attempt's outcome is returned. */
async function fetchThroughRestart(url: string, retryDelaysMs: readonly number[]): Promise<Response>
{
	for (const delayMs of retryDelaysMs)
	{
		try
		{
			// oxlint-disable-next-line no-await-in-loop -- each retry waits on the one before it.
			const response = await fetchExpansionBody(url);
			if (response.status !== 502 && response.status !== 504)
			{
				return response;
			}
		}
		catch
		{
			// A refused connection: the API server is between processes.
		}
		// oxlint-disable-next-line no-await-in-loop -- the backoff is sequential by design.
		await new Promise((resolve) =>
		{
			setTimeout(resolve, delayMs);
		});
	}
	return fetchExpansionBody(url);
}

function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean
{
	return a.size === b.size && [...a].every((id) => b.has(id));
}

/**
 * The change-feed poll as TanStack Query options: every {@link EXPANSION_POLL_MS} while the tab is visible (TanStack
 * pauses intervals in the background) and again on focus once the last poll is that old.
 */
export const expansionPollQuery =
{
	queryKey: ["expansion", "changes"],
	queryFn: async () =>
	{
		await pollExpansion();
		return version ?? null;
	},
	refetchInterval: EXPANSION_POLL_MS,
	refetchOnWindowFocus: true,
	staleTime: EXPANSION_POLL_MS,
} as const;

/**
 * The events socket announced the server's keys at `announced` (an `expansion.changed` frame): poll the change feed
 * now, unless the tab already holds that version or has none to ask from yet.
 */
export function expansionVersionAnnounced(queryClient: QueryClient, announced: string): void
{
	if (version === undefined || announced === version)
	{
		return;
	}
	void queryClient.invalidateQueries(
		{
			queryKey: expansionPollQuery.queryKey,
		},
	);
}

export function useExpansionSync(): void
{
	useEffect(() =>
	{
		void loadExpansion();
	}, []);
	useQuery(expansionPollQuery);
}
