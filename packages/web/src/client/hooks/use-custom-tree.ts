/**
 * Applies the account's Custom tree (upstream's `custom-tree` module): Hotkeys nodes become keymap overrides and
 * Themes nodes become themes with adopted stylesheets. The tree is read from `/api/v1/custom-tree` and re-read after
 * each successful mutation that can change it, standing in for upstream's `operation.applied` re-apply.
 */

import {useQuery, useQueryClient} from "@tanstack/react-query";
import type {QueryClient} from "@tanstack/react-query";
import {useEffect} from "react";
import type {CustomTreeResponse} from "../../node-types.js";
import {readJson} from "../read-json.js";
import {applyThemeSheets, parseCustomThemes} from "../custom-themes.js";
import {parseCustomHotkeys} from "../keys/custom-hotkeys.js";
import {HOTKEYS} from "../keys/keymap.js";
import {useCustomKeymapStore} from "../stores/custom-keymap.js";
import {useCustomThemesStore} from "../stores/custom-themes.js";

export const CUSTOM_ROOT_STORAGE_KEY = "wf-custom-root-id";

/** The root id the user chose in this browser, if any. */
export function chosenCustomRootId(): string | undefined
{
	try
	{
		return localStorage.getItem(CUSTOM_ROOT_STORAGE_KEY) ?? undefined;
	}
	catch
	{
		return undefined;
	}
}

export async function fetchCustomTree(rootId: string | undefined): Promise<CustomTreeResponse>
{
	const query = rootId === undefined ? "" : `?rootId=${encodeURIComponent(rootId)}`;
	const response = await fetch(`/api/v1/custom-tree${query}`);
	if (!response.ok)
	{
		throw new Error("Failed to fetch the custom tree");
	}
	return readJson<CustomTreeResponse>(response);
}

/** Applies one read of the tree; a missing root turns every customization off. */
export function applyCustomTree(data: CustomTreeResponse): void
{
	useCustomKeymapStore.getState().set(parseCustomHotkeys(data.sections.Hotkeys ?? [], HOTKEYS));
	const {themes, css} = parseCustomThemes(data.sections.Themes ?? []);
	useCustomThemesStore.getState().set(Object.values(themes));
	applyThemeSheets(css);
}

export function useCustomTree(): void
{
	const queryClient = useQueryClient();
	const {data} = useQuery(
		{
			queryKey: ["custom-tree", chosenCustomRootId() ?? null],
			queryFn: async () => fetchCustomTree(chosenCustomRootId()),
		},
	);
	useEffect(() =>
	{
		if (data !== undefined)
		{
			applyCustomTree(data);
		}
	}, [data]);
	useEffect(() => invalidateCustomTreeOnWrites(queryClient), [queryClient]);
}

const PARENT_KEYS: ReadonlySet<string> = new Set(["parent_id", "parentId"]);

/**
 * Whether `value` (a mutation's variables or answer) names one of `watched` anywhere in it, or puts something under
 * Home (a `null` parent: a new top-level node may become the Custom root). Walks a few levels of objects and arrays.
 */
function namesWatched(value: unknown, watched: ReadonlySet<string>, depth = 0): boolean
{
	if (typeof value === "string")
	{
		return watched.has(value);
	}
	if (depth > 4 || typeof value !== "object" || value === null)
	{
		return false;
	}
	if (Array.isArray(value))
	{
		return value.some((item) => namesWatched(item, watched, depth + 1));
	}
	return Object.entries(value).some(
		([key, item]) => (item === null && PARENT_KEYS.has(key)) || namesWatched(item, watched, depth + 1),
	);
}

/**
 * Re-read the custom tree after each successful mutation whose variables or answer name a node the cached tree
 * watches (its `watchedIds`) or a top-level parent; a write elsewhere in the outline leaves it alone. Returns the
 * unsubscribe.
 */
export function invalidateCustomTreeOnWrites(queryClient: QueryClient): () => void
{
	return queryClient.getMutationCache().subscribe((event) =>
	{
		if (event.type !== "updated" || event.action.type !== "success")
		{
			return;
		}
		const variables: unknown = event.mutation.state.variables;
		const data: unknown = event.action.data;
		for (const [queryKey, tree] of queryClient.getQueriesData<CustomTreeResponse>(
			{
				queryKey: ["custom-tree"],
			},
		))
		{
			const watched = new Set(tree?.watchedIds);
			if (tree === undefined || namesWatched(variables, watched) || namesWatched(data, watched))
			{
				void queryClient.invalidateQueries(
					{
						queryKey,
						exact: true,
					},
				);
			}
		}
	});
}
