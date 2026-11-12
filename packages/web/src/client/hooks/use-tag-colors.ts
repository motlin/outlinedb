import {useMutation, useQuery, useQueryClient} from "@tanstack/react-query";
import type {QueryClient} from "@tanstack/react-query";
import type {TagColorsResponse} from "../../node-types.js";
import {readJson} from "../read-json.js";
import {normalizeTagColors} from "../tag-color-styles.js";
import {captureOutlineView, recordOp, runInUndoBatch} from "../undo-batch.js";
import {tagColorOp} from "../undo-history.js";
import {tagColorKeys} from "../tag-color-keys.js";

/**
 * Per-tag color assignments, as a map of the lowercased tag text (incl. leading
 * #/@) to a Workflowy color name. These are Workflowy's own colors, stored in
 * root metadata `color.tags` and shared with workflowy.com, via /api/v1/tags.
 * Keys are lowercased on read, so look tags up with `tag.toLowerCase()`.
 */
export type TagColors = TagColorsResponse["colors"];

async function fetchTagColors(): Promise<TagColors>
{
	const response = await fetch("/api/v1/tags");
	if (!response.ok)
	{
		throw new Error(`Failed to fetch tag colors: ${response.statusText}`);
	}
	const data = await readJson<TagColorsResponse>(response);
	return normalizeTagColors(data.colors);
}

export async function setTagColor(name: string, color: string): Promise<void>
{
	const response = await fetch(
		`/api/v1/tags/${encodeURIComponent(name)}`,
		{
			method: "PUT",
			headers:
			{
				"Content-Type": "application/json",
			},
			body: JSON.stringify(
				{
					color,
				},
			),
		},
	);
	if (!response.ok)
	{
		throw new Error(`Failed to set tag color: ${response.statusText}`);
	}
}

export async function removeTagColor(name: string): Promise<void>
{
	const response = await fetch(
		`/api/v1/tags/${encodeURIComponent(name)}`,
		{
			method: "DELETE",
		},
	);
	if (!response.ok)
	{
		throw new Error(`Failed to remove tag color: ${response.statusText}`);
	}
}

/**
 * Returns the map of tag colors. Defaults to an empty map while loading so
 * callers can read it unconditionally.
 */
export function useTagColors(): TagColors
{
	const {data} = useQuery(
		{
			queryKey: tagColorKeys.all,
			queryFn: fetchTagColors,
		},
	);
	return data ?? {};
}

/** Runs `change` as one undo step recording the color it moved `tag` from and to. */
async function undoableTagColor(
	queryClient: QueryClient,
	tag: string,
	after: string | null,
	change: () => Promise<unknown>,
): Promise<void>
{
	const before = queryClient.getQueryData<TagColors>(tagColorKeys.all)?.[tag.toLowerCase()];
	await runInUndoBatch(captureOutlineView, async () =>
	{
		await change();
		const op = tagColorOp(tag, before, after);
		if (op !== null)
		{
			recordOp(op);
		}
	});
}

export function useSetTagColor()
{
	const queryClient = useQueryClient();
	return useMutation(
		{
			mutationFn: async ({name, color}: {name: string; color: string}) =>
				undoableTagColor(queryClient, name, color, async () => setTagColor(name, color)),
			async onSettled()
			{
				await queryClient.invalidateQueries(
					{
						queryKey: tagColorKeys.all,
					},
				);
			},
		},
	);
}

export function useRemoveTagColor()
{
	const queryClient = useQueryClient();
	return useMutation(
		{
			mutationFn: async (name: string) =>
				undoableTagColor(queryClient, name, null, async () => removeTagColor(name)),
			async onSettled()
			{
				await queryClient.invalidateQueries(
					{
						queryKey: tagColorKeys.all,
					},
				);
			},
		},
	);
}
