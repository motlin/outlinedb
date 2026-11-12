// Pasting rows copied or cut from the outline (upstream `gui-paste` `CD4` and `Item.pasteUnder`): the html carries the
// rows' short ids, so a cut row moves back with its original id and a copied row is duplicated from the model.
import type {QueryClient} from "@tanstack/react-query";
import {nodeKeys, readChildren, readNode} from "../node-cache.js";
import {sortByPriority} from "../tree-position.js";
import type {NodeResponse} from "../../node-types.js";
import {parseMirrorPaste} from "../mirror-commands.js";
import {RequestStatusError} from "../request-error.js";
import {PASTE_LIMIT_ALERT} from "./apply.js";
import type {PasteTree} from "./apply.js";

const PASTE_ITEM_LIMIT = 10_000;

export type ItemPasteStep =
	|
	  {
			kind: "restore";
			shortId: string;
			id: string;
	  }
	/** `id` is the full id of the cached row to duplicate, or null when it is not cached. */
	|
	  {
			kind: "copy";
			shortId: string;
			id: string | null;
	  }
	/** A mirrored original, or a mirror, pastes as a new mirror of `originalId` (upstream `mirrorProjectTree`). */
	|
	  {
			kind: "mirror";
			shortId: string;
			originalId: string;
	  };

export interface ItemPasteLookup
{
	/** The full id of a row the last cut removed that is still waiting to be pasted. */
	cutId: (shortId: string) => string | undefined;
	/** The full id of a cached row with this short id. */
	resolve: (shortId: string) => string | undefined;
	/** The original a cached row mirrors, or itself when it is an original with mirrors; undefined for a plain row. */
	mirrorOriginal?: (id: string) => string | undefined;
}

/**
 * One step per TOP `.name[data-wfid]` row in the html (`data-chid` rows come along through the model), in order.
 * Null when the html holds no such row; `{alert}` above upstream's 10000-item limit.
 */
export function planItemPaste(
	html: string,
	lookup: ItemPasteLookup,
):
	| ItemPasteStep[]
	|
	  {
			alert: string;
	  }
	| null
{
	if (html.includes("data-wf-mirror"))
	{
		// The Mirror command's clipboard (upstream `Ad4`): each div names the original to mirror.
		return parseMirrorPaste(html).map((originalId) => (
		{
			kind: "mirror",
			shortId: originalId,
			originalId,
		}));
	}
	if (!html.includes("data-wfid"))
	{
		return null;
	}
	const doc = new DOMParser().parseFromString(html, "text/html");
	const tops = [...doc.querySelectorAll(".name[data-wfid]")];
	if (tops.length === 0)
	{
		return null;
	}
	if (doc.querySelectorAll(".name").length > PASTE_ITEM_LIMIT)
	{
		return {
			alert: PASTE_LIMIT_ALERT,
		};
	}
	return tops.map((element): ItemPasteStep =>
	{
		const shortId = element.getAttribute("data-wfid") ?? "";
		const cut = lookup.cutId(shortId);
		if (cut !== undefined)
		{
			return {
				kind: "restore",
				shortId,
				id: cut,
			};
		}
		const id = lookup.resolve(shortId) ?? null;
		const originalId = id === null ? undefined : lookup.mirrorOriginal?.(id);
		return originalId === undefined
			?
				{
					kind: "copy",
					shortId,
					id,
				}
			:
				{
					kind: "mirror",
					shortId,
					originalId,
				};
	});
}

/** Whether every step can run from the model alone (a copy needs its row cached). */
export function stepsRunnable(steps: readonly ItemPasteStep[]): boolean
{
	return steps.every((step) => step.kind !== "copy" || step.id !== null);
}

/** The cached row whose id ends with `shortId`, scanning every cached children list. */
export function resolveShortId(queryClient: QueryClient, shortId: string): string | undefined
{
	for (const [, children] of queryClient.getQueriesData<NodeResponse[]>(
		{
			queryKey: [...nodeKeys.all, "children"],
		},
	))
	{
		const found = children?.find((child) => child.id.replaceAll("-", "").endsWith(shortId));
		if (found !== undefined)
		{
			return found.id;
		}
	}
	return undefined;
}

/** A duplicate of a cached row's model subtree: name, note, completion, layout and (loaded) children, new ids. */
export function copyTreeFromCache(queryClient: QueryClient, id: string): PasteTree | undefined
{
	const node = readNode(queryClient, id);
	if (node === undefined)
	{
		return undefined;
	}
	const children = sortByPriority(readChildren(queryClient, id) ?? [])
		.map((child) => copyTreeFromCache(queryClient, child.id))
		.filter((child): child is PasteTree => child !== undefined);
	return {
		name: node.name ?? "",
		...(node.note === null || node.note === ""
			? {}
			:
				{
					note: node.note,
				}),
		...(node.completedAt === null
			? {}
			:
				{
					completed: true,
				}),
		...(node.data.layoutMode === null
			? {}
			:
				{
					layoutMode: node.data.layoutMode,
				}),
		...(node.numberedStart === null || node.numberedStart === undefined
			? {}
			:
				{
					numberedStart: node.numberedStart,
				}),
		...(children.length === 0
			? {}
			:
				{
					children,
				}),
	};
}

export const CUT_PASTE_WARNING =
	"WARNING: You just pasted deleted (probably cut) item(s) into a place where they can't be moved. Instead of moving them to the new location, they were copied (and if they were shared or embedded or mirrored, the new copies are not). If you didn't intend this, please undo the paste and the cut.";

/** The effects a paste of copied rows needs, injected so the fallback order can be tested. */
export interface PasteStepsIo
{
	/** Restores a cut row at `index`, recording its undo op; rejects with the server's status when refused. */
	restore: (
		step: Extract<
			ItemPasteStep,
			{
				kind: "restore";
			}
		>,
		index: number,
	) => Promise<void>;
	/** Duplicates a cached row at `index`; resolves to the new id. */
	copyFromCache: (id: string, index: number) => Promise<string | undefined>;
	/** Mirrors the original at `index`; resolves to the new mirror's id. */
	mirror: (originalId: string, index: number) => Promise<string | undefined>;
	/** Pastes the html's copy of the `stepIndex`th top row at `index`; resolves to the new id. */
	fallbackCopy: (stepIndex: number, index: number) => Promise<string | undefined>;
}

/**
 * Runs the steps of a paste of copied rows from `baseIndex`: cut rows are restored with their original ids, the rest
 * duplicated from the model. A restore refused (409/503) on the first row is `unmovable` so the caller can paste the
 * whole html as a copy; refused on a later row, that row and every restore after it fall back to the html copy and the
 * result is flagged `fellBack` so the caller can show the warning. Rows already restored stay.
 */
export async function pasteSteps(
	steps: readonly ItemPasteStep[],
	baseIndex: number,
	io: PasteStepsIo,
): Promise<
	|
	  {
			unmovable: true;
	  }
	|
	  {
			unmovable: false;
			lastId: string | null;
			fellBack: boolean;
	  }
>
{
	let at = baseIndex;
	let lastId: string | null = null;
	let fellBack = false;
	for (const [stepIndex, step] of steps.entries())
	{
		if (step.kind === "restore")
		{
			if (!fellBack)
			{
				try
				{
					// oxlint-disable-next-line no-await-in-loop -- each row lands after the previous one
					await io.restore(step, at);
					lastId = step.id;
				}
				catch (error)
				{
					if (!(error instanceof RequestStatusError && (error.status === 409 || error.status === 503)))
					{
						throw error;
					}
					if (at === baseIndex)
					{
						return {
							unmovable: true,
						};
					}
					fellBack = true;
				}
			}
			if (fellBack)
			{
				// oxlint-disable-next-line no-await-in-loop -- each row lands after the previous one
				lastId = (await io.fallbackCopy(stepIndex, at)) ?? lastId;
			}
		}
		else if (step.kind === "mirror")
		{
			// oxlint-disable-next-line no-await-in-loop -- each row lands after the previous one
			lastId = (await io.mirror(step.originalId, at)) ?? lastId;
		}
		else if (step.id !== null)
		{
			// oxlint-disable-next-line no-await-in-loop -- each row lands after the previous one
			lastId = (await io.copyFromCache(step.id, at)) ?? lastId;
		}
		at += 1;
	}
	return {
		unmovable: false,
		lastId,
		fellBack,
	};
}

/** What a cached row mirrors: its original for a mirror, itself for an original with mirrors, else undefined. */
export function mirrorOriginalFromCache(queryClient: QueryClient, id: string): string | undefined
{
	const node = readNode(queryClient, id);
	if (node?.isMirror === true)
	{
		return node.originalNodeId ?? undefined;
	}
	return node?.hasMirrors === true ? id : undefined;
}
