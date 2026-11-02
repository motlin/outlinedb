/** Upstream's board class strings, copied from the live DOM (`board-layout-2026-10-23-live.txt`), trailing spaces included. */

/** Appended to the zoomed board's root `.project` (`...selected root board`). */
export const BOARD_ROOT_ZOOMED_SUFFIX = " flex flex-col h-full ";

const CHILDREN_BASE =
	"children relative   [.addedToSelection_&]:border-l-transparent [.item--zooming-in-progress_&]:border-l-transparent flex overflow-x-auto box-border !border-l-0";

/** The horizontal flex scroller of a board's columns. */
export function boardChildrenClass(zoomed: boolean, ready: boolean): string
{
	const tail = zoomed ? "mt-m flex-1 min-h-0 [&.children]:ml-0 [&.children]:!pl-0" : "max-h-[60vh] [&.children]:ml-0";
	return `${CHILDREN_BASE} ${ready ? "" : "opacity-0 "}${tail}`;
}

const COLUMN_BORDERS_ZOOMED = "border-r border-solid border-r-secondary";
const COLUMN_BORDERS_INLINE =
	"border-r border-solid border-r-secondary border-l border-solid border-l-secondary -mr-px";

/** The `.project` classes a column adds after `selected`, from `group/column` on. */
export function boardColumnClass(zoomed: boolean): string
{
	return [
		"boardColumn",
		"group/column !ml-0 pt-0 pl-[var(--board-unread-pl)] mobile:!py-0",
		zoomed ? "first:pl-3xl" : "",
		"relative flex flex-col w-[320px] grow-0 shrink-0 overflow-x-hidden bg-primary",
		zoomed ? COLUMN_BORDERS_ZOOMED : COLUMN_BORDERS_INLINE,
		"[scrollbar-width:thin] [&_.name]:[word-break:break-word] [&_.notes]:[word-break:break-word] [&.highlighted>.name]:bg-transparent [&.moving>.name]:bg-transparent [&>.notes]:!pl-0 [&>.notes]:!ml-2xl [&>.notes]:!mr-2xl [&>.notes]:!mb-m [&>.notes]:!mt-s [&>.notes]:!pt-0 ",
	]
		.filter((part) => part !== "")
		.join(" ");
}

const CARD_BOX = "!ml-m !mr-2xl mb-ml p-s mobile:!py-m mobile:!ml-2xl desktop:!py-xs";

/** The `.project` classes a card adds (upstream repeats the box run twice). */
export const BOARD_CARD_CLASS = `boardCard group/card [--wf-content-padding-top:0] relative z-0 ${CARD_BOX} ${CARD_BOX} bg-[color-mix(in_srgb,_var(--wf-background-secondary)_50%,_var(--wf-background-primary)_80%)] rounded [&.divider]:!border-transparent [&.divider]:!bg-transparent [&_.addSiblingButton]:hidden [&>.notes]:!ml-0 [&>.notes]:!pl-m `;

/** A column title's classes after `name name--main`. */
export function boardColumnNameClass(zoomed: boolean): string
{
	const size = zoomed ? "--font-selected-name-font-size" : "--font-default-font-size";
	return `group/name mt-2 !mb-0 !ml-0 mr-8 !pl-8 pr-0 bg-inherit !text-[length:var(${size})] [&>.content]:!flex [&>.content]:!flex-1 [&>.content]:!pr-[28px] [&:hover>.bullet]:!opacity-100`;
}

export const BOARD_CARD_NAME_CLASS = "!-ml-[40px] !pl-[48px] [&>.content]:!pr-xl [&>.content]:!pt-0 [&>.prefix]:!pt-0";

export const BOARD_COLUMN_BULLET_CLASS =
	"group/bullet absolute !left-auto right-0 mr-[6px] z-1 transition-opacity duration-200 !opacity-0 group-hover/column:!opacity-100";

export const BOARD_CARD_BULLET_CLASS =
	"group/bullet absolute z-1 top-0 !left-auto -right-[1px] ml-ml h-[var(--line-height)] !pt-0 flex items-center transition-opacity duration-200 !opacity-0 group-hover/card:!opacity-100 hover:bg-inherit";

export const BOARD_COLUMN_EXPAND_CLASS =
	"hover:text-icon-secondary !transition-opacity !duration-200 !opacity-0 !left-[10px] group-hover/column:!opacity-100";

export const BOARD_CARD_EXPAND_CLASS =
	"hover:text-icon-secondary [.task_&]:hidden transition-opacity duration-200 !left-m !pt-0 opacity-0 group-hover/card:opacity-100";

/** A column's vertical card scroller. */
export const BOARD_COLUMN_CHILDREN_CLASS =
	"children relative ml-[10px] pl-[25px] border-l-[length:var(--wf-border-width-s)] border-solid border-l-secondary [.addedToSelection_&]:border-l-transparent [.item--zooming-in-progress_&]:border-l-transparent vertical-scrollable-container pl-0 !ml-0 [&.children]:border-l-0 overflow-y-scroll overflow-x-hidden pt-m ";

/** The rows nested inside a card. */
export const BOARD_CARD_CHILDREN_CLASS =
	"children relative ml-[10px] pl-[25px] border-l-[length:var(--wf-border-width-s)] border-solid border-l-secondary [.addedToSelection_&]:border-l-transparent [.item--zooming-in-progress_&]:border-l-transparent !border-l-0 !pl-[11px]";

export const ADD_CARD_TILE_CLASS =
	"self-stretch text-[0.9em] text-tertiary my-m ml-m mobile:ml-2xl !mr-2xl px-ml py-m mobile:py-l rounded cursor-pointer hover:bg-secondary";

export const EXPAND_COLUMN_LINK_CLASS =
	"self-start flex flex-row gap-m text-[0.9em] text-tertiary cursor-pointer hover:text-secondary ml-xl";

export const ADD_COLUMN_TILE_CLASS =
	"self-start flex items-center justify-center text-icon bg-quaternary cursor-pointer hover:bg-quaternary";

export const RESIZE_HANDLE_CLASS =
	"resizeTarget absolute top-0 bottom-0 right-0 w-[4px] cursor-ew-resize z-1 -right-xs";
