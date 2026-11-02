export interface NumberedRow
{
	id: string;
	layoutMode?: string | null;
	numberedStart?: number | null;
}

const isNumbered = (row: NumberedRow): boolean => row.layoutMode === "numbered";

/**
 * Upstream's outline numbering (`item:render` middleware): a numbered row follows the previous
 * rendered row's number when that row is numbered, else starts at its own `numberedStart ?? 1`.
 */
export function renderedNumbers(rows: readonly NumberedRow[]): Map<string, number>
{
	const numbers = new Map<string, number>();
	let previous: number | null = null;
	for (const row of rows)
	{
		if (isNumbered(row))
		{
			const number: number = previous === null ? (row.numberedStart ?? 1) : previous + 1;
			numbers.set(row.id, number);
			previous = number;
		}
		else
		{
			previous = null;
		}
	}
	return numbers;
}

/**
 * Upstream's `LK4` sibling walk, used on the zoom root and during a search. 0 for a row that is not numbered.
 */
export function siblingNumber(siblings: readonly NumberedRow[], id: string): number
{
	const index = siblings.findIndex((row) => row.id === id);
	const row = siblings[index];
	if (row === undefined || !isNumbered(row))
	{
		return 0;
	}
	if (typeof row.numberedStart === "number")
	{
		return row.numberedStart;
	}
	let count = 1;
	for (let i = index - 1; i >= 0; i--)
	{
		const sibling = siblings[i];
		if (sibling === undefined || !isNumbered(sibling))
		{
			break;
		}
		if (sibling.numberedStart !== null && sibling.numberedStart !== undefined && sibling.numberedStart !== 0)
		{
			return count + sibling.numberedStart;
		}
		count++;
	}
	return count;
}
