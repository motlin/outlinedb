/** The row whose next editing focus leaves the scroll where it is. */
let quietId: string | null = null;

/**
 * Focus `id`'s editor next without scrolling it into view: a row resumed after a navigation swap keeps the scroll the
 * swap set (top, or the position Back/Forward restored), as upstream does, instead of jumping to the row.
 */
export function focusQuietlyNext(id: string): void
{
	quietId = id;
}

/** Whether `id`'s editor, focusing now, may scroll itself into view; a quiet focus is used up by the call. */
export function focusScrolls(id: string): boolean
{
	if (quietId !== id)
	{
		return true;
	}
	quietId = null;
	return false;
}

/** The row whose next editing focus centers it in the view. */
let centerId: string | null = null;

/** Center `id`'s row in the view when its editor next focuses (upstream `scrollTo`, used by ⌥⌘↓). */
export function focusCenterNext(id: string): void
{
	centerId = id;
}

/** Whether `id`'s editor, focusing now, centers its row; the request is used up by the call. */
export function focusCenters(id: string): boolean
{
	if (centerId !== id)
	{
		return false;
	}
	centerId = null;
	return true;
}

/** Whether a row already partly in the view keeps the scroll when it takes focus (upstream `lM4`). */
export function focusKeepsScroll(
	rect:
	{
		top: number;
		bottom: number;
	},
	viewportHeight: number,
): boolean
{
	return rect.bottom > 0 && rect.top < viewportHeight;
}
