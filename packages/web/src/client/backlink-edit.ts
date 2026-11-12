import type {QueryClient} from "@tanstack/react-query";

/**
 * Where the caret goes when an edit made through a backlink row removes its link, so the row vanishes (upstream
 * `eE.applyLocalEdit`): the end of the previous visible row, or the start of the next one when the row was the first,
 * or Home when the backlink item was the zoom root.
 */
export function backlinkEditFallback(
	rows: readonly string[],
	id: string,
	zoomedId: string | null = null,
):
	|
	  {
			id: string;
			offset: 0 | "end";
	  }
	|
	  {
			home: true;
	  }
{
	if (zoomedId === id)
	{
		return {
			home: true,
		};
	}
	const index = rows.indexOf(id);
	const previous = rows[index - 1];
	if (index > 0 && previous !== undefined)
	{
		return {
			id: previous,
			offset: "end",
		};
	}
	const next = rows[index + 1];
	if (index !== -1 && next !== undefined)
	{
		return {
			id: next,
			offset: 0,
		};
	}
	return {
		home: true,
	};
}

type RowsReader = (queryClient: QueryClient) => readonly string[];

let readRows: RowsReader = () => [];

/** The outline registers how to read the rows the caret can visit, so the save path needs no import of the outline. */
export function setNavigableRowsReader(read: RowsReader): void
{
	readRows = read;
}

/** The rows the caret can visit right now, in display order. */
export function readNavigableRows(queryClient: QueryClient): readonly string[]
{
	return readRows(queryClient);
}
