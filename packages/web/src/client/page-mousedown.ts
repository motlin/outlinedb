export interface PageMouseDown
{
	selectionActive: boolean;
	button: number;
	meta: boolean;
	alt: boolean;
	ctrl: boolean;
	shift: boolean;
	/** The press landed on the bullet of a selected row. */
	onSelectedBullet: boolean;
}

/** Upstream's `wy4`: a plain left mousedown inside the page container clears the item selection. */
export function shouldClearSelectionOnPageMouseDown(event: PageMouseDown): boolean
{
	return (
		event.selectionActive &&
		event.button === 0 &&
		!event.meta &&
		!event.alt &&
		!event.ctrl &&
		!event.shift &&
		!event.onSelectedBullet
	);
}
