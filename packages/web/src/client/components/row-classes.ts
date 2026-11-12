/** Upstream `WF.Mirrors.isMirrorRoot`: a mirror, or an original that has mirrors. Both draw the diamond bullet. */
export function isMirrorRoot(node: {isMirror?: boolean; hasMirrors?: boolean}): boolean
{
	return node.isMirror === true || node.hasMirrors === true;
}

/** Upstream gives only an original that has mirrors the `hasMirrors` project class. */
export function hasMirrorsClass(node: {isMirror?: boolean; hasMirrors?: boolean}): boolean
{
	return node.hasMirrors === true && node.isMirror !== true;
}

export interface ProjectClassState
{
	hasChildren: boolean;
	/** The row has children, hidden completed ones included; `open` follows this, `collapsed` needs visible ones. */
	hasAnyChildren?: boolean;
	/** The row's `.children` is playing the collapse slide-up: upstream shows neither `open` nor `collapsed` yet. */
	collapsingChildren?: boolean;
	expanded: boolean;
	completed: boolean;
	hasNote: boolean;
	noteFocused: boolean;
	isZoomRoot: boolean;
	/** A board column: upstream treats it as a main container, so it carries `selected` like a zoom root. */
	selectedColumn?: boolean;
	hasMirrors: boolean;
	highlighted: boolean;
	addedToSelection: boolean;
	layoutClasses?: readonly string[];
	/** The row's attachment is previewable (an image or video): upstream's `item--with-image`. */
	withImage?: boolean;
	/** Upstream's references root, the Backlinks section's row. */
	references?: boolean;
	/** The completed row is playing upstream's slideUp before it hides. */
	slidingUp?: boolean;
	/** The completed row was just revealed by showing completed and plays the slideDown. */
	slidingDown?: boolean;
	/** The row's `.children` is playing the expand slideDown. */
	animatingShowChildren?: boolean;
	/** Shift+Cmd+Up/Down just moved this row; upstream flashes it for 500ms. */
	moving?: boolean;
	/** A bullet drag's drop line sits inside this row, in its first child slot. */
	dragHoveredIn?: boolean;
	/** A bullet drag's drop line sits under this row. */
	dragHoveredAt?: boolean;
}

export interface NameClassState
{
	focused?: boolean;
	/** A trailing run of classes (a board column or card's), appended after the base ones. */
	tail?: string;
	/** Put `tail` before `empty` (a table cell's name lists `empty` last). */
	tailBeforeEmpty?: boolean;
	isZoomRoot?: boolean;
	isMainRoot?: boolean;
	empty?: boolean;
	/** Something renders before the name, like a backlink's source crumbs. */
	withEmbedder?: boolean;
}

// Mirrors upstream's `.project` class order; layout classes come last.
export function projectClassName(state: ProjectClassState): string
{
	const branch = state.hasChildren && !state.isZoomRoot && state.collapsingChildren !== true;
	const open =
		(state.hasChildren || state.hasAnyChildren === true) &&
		!state.isZoomRoot &&
		state.collapsingChildren !== true &&
		state.expanded;
	return [
		"font-custom project",
		state.references && "references",
		state.hasMirrors && "hasMirrors",
		!state.hasChildren && "task",
		state.completed && "done",
		(state.hasNote || state.noteFocused) && "noted",
		open && "open",
		open && state.animatingShowChildren && "animatingShowChildren",
		branch && !state.expanded && "collapsed",
		state.isZoomRoot && "selected root",
		state.selectedColumn && "selected",
		state.highlighted && "highlighted",
		state.addedToSelection && "addedToSelection",
		state.moving && "moving",
		state.dragHoveredIn && "drag-hovered-in",
		state.dragHoveredAt && "drag-hovered-at",
		...(state.layoutClasses ?? []),
		state.withImage && "item--with-image",
		state.slidingUp && "completing-slide-up",
		state.slidingDown && "completed-slide-down",
	]
		.filter(Boolean)
		.join(" ");
}

// Mirrors upstream's `.name` class order.
export function nameClassName(state: NameClassState): string
{
	return [
		"name",
		state.withEmbedder && "name--with-embedder",
		state.focused && "name--focused",
		state.isZoomRoot && "name--main",
		state.isMainRoot && "name--root",
		state.tailBeforeEmpty && state.tail,
		state.empty && "empty",
		!state.tailBeforeEmpty && state.tail,
	]
		.filter(Boolean)
		.join(" ");
}
