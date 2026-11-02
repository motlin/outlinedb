import type {QueryClient} from "@tanstack/react-query";
import {cachedAncestorLayouts} from "./layouts-cache.js";
import {copyItemsHtml, copyItemsPlainText, linkParents} from "./export-format.js";
import type {ChildAccessor, ExportItem, FormatOptions} from "./export-format.js";
import {highlightSearchMatches} from "./highlight-html.js";
import {isSearchExpanded} from "./search-filter.js";
import type {SearchFilter} from "./search-filter.js";
import {readChildren, readNode} from "./node-cache.js";
import {sortByPriority} from "./tree-position.js";
import {recordCut} from "./cut-registry.js";
import {cutBannerText, rowsWithDescendants, selectedMarkup} from "./copy-cut-plan.js";

export interface CopyCutDeps
{
	/** The selected ids in display order; empty when there is no item selection. */
	selected: () => string[];
	/** The rows as export trees (children loaded from the cache). */
	items: (ids: readonly string[]) => ExportItem[];
	childFilter: ChildAccessor;
	/** Renderers for the copied name/note html (the search highlight); stored markup when absent. */
	format?: FormatOptions;
	canCut: (id: string) => boolean;
	/** Child ids of a row, for the big-cut count; undefined when the subtree is not loaded. */
	childIds: (id: string) => string[] | undefined;
	deleteRows: (ids: string[]) => void;
	clearSelection: () => void;
	showBanner(text: string, restore: () => void): void;
	/** Undo the cut of exactly `ids`. */
	restore: (ids: readonly string[]) => void;
	schedule(run: () => void): void;
}

/** The clipboard half of a copy: the Formatted html and the line-per-name text. */
export function planCopy(
	items: ExportItem[],
	childFilter: ChildAccessor,
	options?: FormatOptions,
):
{
	html: string;
	text: string;
}
{
	return {
		html: copyItemsHtml(items, childFilter, options),
		text: copyItemsPlainText(items, childFilter, options),
	};
}

/** The copy renderers while a search is committed: matched words keep their `contentMatch` highlight. */
export function searchFormatOptions(query: string): FormatOptions | undefined
{
	return query === ""
		? undefined
		:
			{
				renderName: (html) => highlightSearchMatches(html, query),
				renderNote: (html) => highlightSearchMatches(html, query),
			};
}

/** Upstream's copy childFilter: rows keep children only when expanded or zoomed, minus hidden completed ones. */
export function makeChildFilter({
	expandedIds,
	zoomedId,
	showCompleted,
	search = null,
}: {
	expandedIds: ReadonlySet<string>;
	zoomedId: string | null;
	showCompleted: boolean;
	/** The committed search: only the rows it renders are copied, under the rows it expands. */
	search?: SearchFilter | null;
}): ChildAccessor
{
	if (search !== null)
	{
		const completedShown = showCompleted || search.result.revealsCompleted;
		return (item) =>
			item.id === zoomedId || isSearchExpanded(item.id, search)
				? item.children.filter(
						(child) =>
							(!child.completed || completedShown) &&
							(search.matchIds.has(child.id) ||
								search.ancestorIds.has(child.id) ||
								search.createdIds.has(child.id) ||
								search.expansion.get(item.id) === true),
					)
				: [];
	}
	return (item) =>
		item.id === zoomedId || expandedIds.has(item.id)
			? item.children.filter((child) => !child.completed || showCompleted)
			: [];
}

/** Build the export trees for `ids` from the cache, each top row's parent a stub so `data-parent` is written. */
export function exportItemsFromCache(queryClient: QueryClient, ids: readonly string[]): ExportItem[]
{
	const build = (id: string): ExportItem | undefined =>
	{
		const node = readNode(queryClient, id);
		if (node === undefined)
		{
			return undefined;
		}
		const children = sortByPriority(readChildren(queryClient, id) ?? [])
			.map((child) => build(child.id))
			.filter((child): child is ExportItem => child !== undefined);
		return {
			id: node.id,
			name: node.name ?? "",
			note: node.note ?? "",
			layoutMode: node.data.layoutMode,
			numberedStart: node.numberedStart ?? null,
			completed: node.completedAt !== null,
			parent: null,
			children,
		};
	};
	return ids.flatMap((id) =>
	{
		const item = build(id);
		if (item === undefined)
		{
			return [];
		}
		const parentId = readNode(queryClient, id)?.parent_id ?? null;
		const top: ExportItem =
		{
			...item,
		};
		if (parentId === null)
		{
			linkParents([top]);
			return [top];
		}
		const parent: ExportItem =
		{
			id: parentId,
			name: "",
			note: "",
			layoutMode: null,
			numberedStart: null,
			completed: false,
			parent: null,
			children: [top],
			aboveLayouts: cachedAncestorLayouts(queryClient, id).layouts.map((layout) => layout.layoutMode),
		};
		linkParents([parent]);
		return [top];
	});
}

export interface ClipboardLike
{
	defaultPrevented: boolean;
	preventDefault: () => void;
	clipboardData:
	{
		setData: (type: string, value: string) => void;
	} | null;
}

function writeClipboard(event: ClipboardLike, deps: CopyCutDeps, ids: readonly string[]): boolean
{
	const data = event.clipboardData;
	if (data === null)
	{
		return false;
	}
	const {html, text} = planCopy(deps.items(ids), deps.childFilter, deps.format);
	data.setData("text/html", html);
	data.setData("text/plain", text);
	event.preventDefault();
	return true;
}

/** `copy` with an item selection: both formats go on the clipboard and the selection is kept. */
export function handleCopy(event: ClipboardLike, deps: CopyCutDeps): boolean
{
	const ids = deps.selected();
	if (ids.length === 0 || event.defaultPrevented)
	{
		return false;
	}
	return writeClipboard(event, deps, ids);
}

/**
 * `cut` with an item selection: copy the cuttable rows, then delete them as one undo step with no confirm, clear the
 * selection, and (for a large cut) open the Restore banner.
 */
export function handleCut(event: ClipboardLike, deps: CopyCutDeps): boolean
{
	const selected = deps.selected();
	if (selected.length === 0 || event.defaultPrevented)
	{
		return false;
	}
	const ids = selected.filter((id) => deps.canCut(id));
	if (ids.length === 0)
	{
		return false;
	}
	if (!writeClipboard(event, deps, ids))
	{
		return false;
	}
	recordCut(ids);
	const {big, hasKids} = rowsWithDescendants(ids, deps.childIds);
	deps.schedule(() =>
	{
		deps.deleteRows(ids);
		deps.clearSelection();
		if (big)
		{
			deps.showBanner(cutBannerText(ids.length, hasKids), () =>
			{
				deps.restore(ids);
			});
		}
	});
	return true;
}

/** What the zoom-root title's selection holds, or null when the selection is not inside that one title. */
export interface TitleSelection
{
	stored: string;
	start: number;
	end: number;
	text: string;
}

/**
 * Upstream `mh2`: with no item selection, copy/cut inside the zoom-root title writes the raw Workflowy markup of the
 * selected substring as `text/html` (and `selection.toString()` as `text/plain`). Cut also removes the range through
 * the editor. Every other row and note keeps the native copy/cut.
 */
export function handleTitleCopyCut(
	event: ClipboardLike,
	cut: boolean,
	selection: TitleSelection | null,
	removeRange: () => void,
): boolean
{
	if (selection === null || event.defaultPrevented || selection.start === selection.end)
	{
		return false;
	}
	const data = event.clipboardData;
	if (data === null)
	{
		return false;
	}
	data.setData("text/plain", selection.text);
	data.setData("text/html", selectedMarkup(selection.stored, selection.start, selection.end));
	event.preventDefault();
	if (cut)
	{
		removeRange();
	}
	return true;
}
