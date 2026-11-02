/** Where the export dialog opens from: the item selection, the main menu, and what each hands the dialog. */

export interface ExportRequest
{
	nodeIds: string[];
	/** True exports every child of the roots whatever search is active, as upstream's "Export all" does. */
	ignoreSearch: boolean;
}

/** `show_export` on rows: those rows, honoring the active search. */
export function selectionExportRequest(items: readonly string[]): ExportRequest
{
	return {
		nodeIds: [...items],
		ignoreSearch: false,
	};
}

/**
 * The main menu's Export: the zoomed item, or at Home every top-level item ignoring search (upstream's legacy
 * export-all). Never opens the dialog with no items; at an empty Home it does not open at all.
 */
export async function openMenuExport(
	zoomedId: string | null,
	fetchTopLevelIds: () => Promise<string[]>,
	open: (request: ExportRequest) => void,
): Promise<void>
{
	if (zoomedId !== null)
	{
		open(
			{
				nodeIds: [zoomedId],
				ignoreSearch: false,
			},
		);
		return;
	}
	const nodeIds = await fetchTopLevelIds();
	if (nodeIds.length > 0)
	{
		open(
			{
				nodeIds,
				ignoreSearch: true,
			},
		);
	}
}

/** Drops rows a search hides: rows that neither match, hold a match, were created in the search nor sit under a fully expanded parent. */
export function filterBySearch<
	T extends
	{
		id: string;
		children: T[];
	},
>(
	items: T[],
	shows: (id: string, parentId: string | null) => boolean,
	parentId: string | null = null,
	keepRoots = true,
): T[]
{
	return items
		.filter((item) => (keepRoots && parentId === null) || shows(item.id, parentId))
		.map((item) => (
		{
			...item,
			children: filterBySearch(item.children, shows, item.id, false),
		}));
}
