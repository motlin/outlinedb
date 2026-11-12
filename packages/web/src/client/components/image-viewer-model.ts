export interface ViewerRow
{
	id: string;
	hasAttachment: boolean;
}

/**
 * Upstream's `show_prev_file` / `show_next_file`: from the shown row, walk the visible rows inside the zoom and stop
 * at the first one with an attachment (any file type). Null at the end of the zoom, so the button goes inactive.
 */
export function adjacentAttachment(
	rows: readonly ViewerRow[],
	currentId: string,
	direction: "prev" | "next",
): string | null
{
	const start = rows.findIndex((row) => row.id === currentId);
	if (start === -1)
	{
		return null;
	}
	const step = direction === "next" ? 1 : -1;
	for (let index = start + step; index >= 0 && index < rows.length; index += step)
	{
		if (rows[index]?.hasAttachment === true)
		{
			return rows[index]?.id ?? null;
		}
	}
	return null;
}

/** The rendered rows of the current view, in document order, each flagged when it shows a `.file-preview`. */
export function visibleViewerRows(doc: Document): ViewerRow[]
{
	const rows: ViewerRow[] = [];
	for (const element of doc.querySelectorAll("[projectid]"))
	{
		const id = element.getAttribute("projectid");
		if (id !== null)
		{
			rows.push(
				{
					id,
					hasAttachment: element.querySelector(":scope > .file-preview") !== null,
				},
			);
		}
	}
	return rows;
}
