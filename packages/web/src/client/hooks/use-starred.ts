/**
 * Stars (starred pages and saved searches) over `/api/v1/stars`, which syncs with
 * workflowy.com's own account-global stars. Mutations update the `["stars"]` query
 * optimistically and roll back on failure. Recency is per browser, as upstream.
 */

import {useQuery, useQueryClient} from "@tanstack/react-query";
import type {QueryClient} from "@tanstack/react-query";
import {useEffect, useMemo, useRef} from "react";
import {z} from "zod";
import {applyToggle, locationKey, moveKey, shouldRecordView, uniqueId} from "@outlinedb/shared";
import type {Star, StarredLocation} from "@outlinedb/shared";
import type {StarsResponse} from "../../node-types.js";
import {nodeKeys, readDetail} from "../node-cache.js";
import {readJson} from "../read-json.js";
import {useOutlineStore} from "../stores/outline.js";

export interface StarsState
{
	stars: readonly Star[];
	/** The internal API is not configured (503), so stars cannot load or change. */
	unavailable: boolean;
}

export const starKeys =
{
	all: ["stars"] as const,
};

export const STARS_UNAVAILABLE_TOOLTIP = "Stars need a workflowy.com login (WORKFLOWY_USERNAME/PASSWORD)";

export const LAST_VIEWED_STORAGE_KEY = "outlinedb-star-last-viewed";

const EMPTY: StarsState =
{
	stars: [],
	unavailable: false,
};

const JSON_HEADERS =
{
	"Content-Type": "application/json",
};

function starUrl(key: string): string
{
	return `/api/v1/stars/${encodeURIComponent(key)}`;
}

/**
 * `GET /api/v1/stars`. With a `queryClient`, the starred nodes the reply carries seed their detail cache (unless it
 * already holds them), so the left bar's starred rows need no request of their own.
 */
export async function fetchStars(queryClient?: QueryClient): Promise<StarsState>
{
	const response = await fetch("/api/v1/stars");
	if (response.status === 503)
	{
		return {
			stars: [],
			unavailable: true,
		};
	}
	if (!response.ok)
	{
		throw new Error(`Failed to fetch stars: ${response.status}`);
	}
	const {stars, nodes} = await readJson<StarsResponse>(response);
	if (queryClient !== undefined)
	{
		for (const node of nodes)
		{
			if (readDetail(queryClient, node.id) === undefined)
			{
				queryClient.setQueryData(nodeKeys.detail(node.id), node);
			}
		}
	}
	return {
		stars,
		unavailable: false,
	};
}

/** Apply `next` to the cache, run `request`, and restore the previous cache if it fails. */
async function optimistic(
	queryClient: QueryClient,
	next: (stars: readonly Star[]) => readonly Star[],
	request: () => Promise<Response>,
	failure: string,
): Promise<void>
{
	await queryClient.cancelQueries(
		{
			queryKey: starKeys.all,
		},
	);
	const previous = queryClient.getQueryData<StarsState>(starKeys.all) ?? EMPTY;
	queryClient.setQueryData<StarsState>(
		starKeys.all,
		{
			...previous,
			stars: next(previous.stars),
		},
	);
	try
	{
		const response = await request();
		if (!response.ok)
		{
			throw new Error(`${failure}: ${response.status}`);
		}
	}
	catch (error)
	{
		queryClient.setQueryData(starKeys.all, previous);
		throw error;
	}
}

function currentStars(queryClient: QueryClient): readonly Star[]
{
	return queryClient.getQueryData<StarsState>(starKeys.all)?.stars ?? [];
}

/** Star or unstar `loc` (`force` sets the state); resolves to whether it is starred afterwards. */
export async function toggleStar(queryClient: QueryClient, loc: StarredLocation, force?: boolean): Promise<boolean>
{
	const before = currentStars(queryClient);
	const {stars, value} = applyToggle(before, loc, force);
	if (stars === before)
	{
		return value;
	}
	const key = locationKey(loc);
	await optimistic(
		queryClient,
		() => stars,
		async () =>
			value
				? fetch(
						starUrl(key),
						{
							method: "PUT",
							headers: JSON_HEADERS,
							body: JSON.stringify(loc),
						},
					)
				: fetch(
						starUrl(key),
						{
							method: "DELETE",
						},
					),
		value ? "Failed to star location" : "Failed to unstar location",
	);
	if (typeof window !== "undefined")
	{
		window.dispatchEvent(
			new CustomEvent(
				"starring.starred",
				{
					detail:
					{
						location: loc,
						value,
					},
				},
			),
		);
	}
	return value;
}

/** Move `srcKey` before or after `targetKey` and store the resulting order. */
export async function moveStar(
	queryClient: QueryClient,
	srcKey: string,
	targetKey: string,
	after: boolean,
): Promise<void>
{
	const before = currentStars(queryClient);
	const keys = moveKey(
		before.map((s) => s.key),
		srcKey,
		targetKey,
		after,
	);
	if (keys.every((key, index) => key === before[index]?.key))
	{
		return;
	}
	const byKey = new Map(before.map((s) => [s.key, s]));
	await optimistic(
		queryClient,
		() =>
			keys
				.flatMap((key) => byKey.get(key) ?? [])
				.map((s, position) => (
				{
					...s,
					position,
				})),
		async () =>
			fetch(
				"/api/v1/stars/order",
				{
					method: "PUT",
					headers: JSON_HEADERS,
					body: JSON.stringify(
						{
							keys,
						},
					),
				},
			),
		"Failed to reorder stars",
	);
}

/** Rename `key`; `null` clears the custom name. */
export async function renameStar(queryClient: QueryClient, key: string, name: string | null): Promise<void>
{
	await optimistic(
		queryClient,
		(stars) =>
			stars.map((s) =>
				s.key === key
					?
						{
							...s,
							name: name === "" ? null : name,
						}
					: s,
			),
		async () =>
			fetch(
				starUrl(key),
				{
					method: "PATCH",
					headers: JSON_HEADERS,
					body: JSON.stringify(
						{
							name,
						},
					),
				},
			),
		"Failed to rename star",
	);
}

const LastViewedSchema = z.record(z.string(), z.number());

export function readLastViewed(storage: Pick<Storage, "getItem">): Record<string, number>
{
	try
	{
		const raw = storage.getItem(LAST_VIEWED_STORAGE_KEY);
		return raw === null ? {} : (LastViewedSchema.safeParse(JSON.parse(raw)).data ?? {});
	}
	catch
	{
		return {};
	}
}

/** Stamp `loc` as viewed at `now` when it is starred. */
export function recordView(
	storage: Pick<Storage, "getItem" | "setItem">,
	stars: readonly Star[],
	loc: StarredLocation,
	now: number,
): void
{
	const key = locationKey(loc);
	if (!stars.some((s) => s.key === key))
	{
		return;
	}
	try
	{
		storage.setItem(
			LAST_VIEWED_STORAGE_KEY,
			JSON.stringify(
				{
					...readLastViewed(storage),
					[uniqueId(loc)]: now,
				},
			),
		);
	}
	catch
	{
		// Storage can be unavailable (private mode, blocked site data); recency is a convenience.
	}
}

function safeLocalStorage(): Storage | undefined
{
	try
	{
		return globalThis.localStorage;
	}
	catch
	{
		return undefined;
	}
}

export function useStars(): StarsState
{
	const queryClient = useQueryClient();
	const {data} = useQuery(
		{
			queryKey: starKeys.all,
			queryFn: async () => fetchStars(queryClient),
		},
	);
	return data ?? EMPTY;
}

/** Stars in display order (the server already drops ids missing from the cache). */
export function useStarredLocations(): readonly Star[]
{
	return useStars().stars;
}

/** Star mutations bound to the app's QueryClient; failures surface as error notifications. */
export function useStarActions()
{
	const queryClient = useQueryClient();
	const addErrorNotification = useOutlineStore((state) => state.addErrorNotification);
	return useMemo(() =>
	{
		async function notifying<T>(run: () => Promise<T>): Promise<T | undefined>
		{
			try
			{
				return await run();
			}
			catch (error)
			{
				addErrorNotification(error instanceof Error ? error.message : String(error));
				return undefined;
			}
		}
		return {
			toggleStar: async (loc: StarredLocation, force?: boolean) =>
				notifying(async () => toggleStar(queryClient, loc, force)),
			moveStar: async (srcKey: string, targetKey: string, after: boolean) =>
				notifying(async () => moveStar(queryClient, srcKey, targetKey, after)),
			renameStar: async (key: string, name: string | null) =>
				notifying(async () => renameStar(queryClient, key, name)),
		};
	}, [queryClient, addErrorNotification]);
}

/**
 * Record a view of the current zoom/search location when navigation reaches it and it is starred. A star refetch or
 * toggle at the same location stamps nothing (upstream stamps only on `location.change.after`).
 */
export function useRecordStarViews(): void
{
	const {stars} = useStars();
	const nodeId = useOutlineStore((state) => state.zoomedNodeId);
	const query = useOutlineStore((state) => state.urlSearchQuery);
	const starsRef = useRef(stars);
	useEffect(() =>
	{
		starsRef.current = stars;
	}, [stars]);
	const previous = useRef<StarredLocation | null>(null);
	useEffect(() =>
	{
		const next =
		{
			nodeId,
			query,
		};
		// Until the stars load there is nothing to stamp; keep the location pending for the first load
		if (starsRef.current.length === 0 || !shouldRecordView(previous.current, next))
		{
			return;
		}
		previous.current = next;
		const storage = safeLocalStorage();
		if (storage)
		{
			recordView(storage, starsRef.current, next, Date.now());
		}
	}, [nodeId, query]);
}
