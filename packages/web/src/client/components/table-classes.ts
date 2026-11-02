/** Upstream's table class strings, copied from the live DOM (`table-layout-upstream-dom.html`). */

/** Appended to the zoomed table's root `.project` (`...selected root tableItem`), as the board's suffix is. */
export const TABLE_ROOT_ZOOMED_SUFFIX = " flex flex-col h-full ";

/** The zoomed table title's extra class (`ui.item.name.classes.table_root`). */
export const TABLE_TITLE_CLASS = "overflow-hidden";

const SCROLLER_COMMON = "[--item-selection-x-offset:0] [--item-selection-border-radius:0] inline-block !w-auto";

/** The horizontal scroller around a table's `.children` and add-row button. */
export function tableScrollerClass(zoomed: boolean): string
{
	return zoomed
		? `vertical-scrollable-container mt-m flex-1 min-h-0 ${SCROLLER_COMMON} relative box-border overflow-x-auto `
		: `vertical-scrollable-container ${SCROLLER_COMMON} max-h-[300px] relative box-border overflow-x-auto `;
}

export const TABLE_CHILDREN_CLASS = "children table w-max [--name-left-overhang:0] pr-[42px]";

export const TABLE_ROW_CLASS = "table-row project";

const CELL_BASE =
	"table-cell relative tableCell group/cell box-border relative z-0 !m-0 p-xs pl-m mobile:!py-m mobile:!ml-0 border-b border-primary border-solid [&_.addSiblingButton]:hidden [&_.contentEditablePlaceholder]:!leading-[var(--font-default-line-height)] [&>.notes]:!ml-0 [&>.notes]:!pl-0 border-l border-r border-solid border-primary bg-primary [--wf-content-padding-top:0]";

/** The classes a cell adds to its `.project` after `task` or `collapsed`. */
export function tableCellClass(options: {header: boolean; nested: boolean; bg?: string | undefined}): string
{
	return [
		CELL_BASE,
		options.header ? "bg-secondary border-t border-solid border-primary" : "",
		options.nested ? "border-l-[length:var(--wf-border-width-l)] border-l-primary" : "",
		options.bg === undefined ? "" : `bg-[var(--wf-background-${options.bg})]`,
	]
		.filter((part) => part !== "")
		.join(" ");
}

const CELL_NAME = "!ml-0 !pl-0 [&>.content]:!pr-0 [&>.content]:!pt-0 [&_button]:hidden";

/** A cell's name classes after `name`; the header row is bold. */
export function tableCellNameClass(header: boolean): string
{
	return header ? `${CELL_NAME} font-bold` : CELL_NAME;
}

export const TABLE_CELL_BULLET_CLASS =
	"group/bullet absolute left-auto right-[26px] ml-ml z-1 transition-opacity duration-200 !opacity-0 group-hover/cell:!opacity-100";

export const TABLE_CELL_EXPAND_CLASS = "hover:text-icon-secondary hidden";

export const TABLE_ROW_MENU_SLOT_CLASS =
	"absolute right-full top-0 h-full z-1 flex items-center justify-end mr-xs w-[28px]";

export const TABLE_ROW_MENU_CLASS = "flex z-1 gap-xs p-xs text-secondary";

export const TABLE_ROW_BUTTON_CLASS =
	"flex items-center text-s justify-center w-[20px] h-[20px] cursor-pointer hover:bg-tertiary rounded-s";

export const TABLE_ROW_GRIP_CLASS =
	"flex items-center justify-center w-[20px] h-[20px] text-s hover:bg-tertiary rounded-s cursor-pointer";

export const ADD_COLUMN_CELL_CLASS =
	"absolute table-cell align-middle px-s cursor-pointer text-secondary hover:text-primary";

export const ADD_ROW_CLASS =
	"my-s ml-ml flex items-center justify-center w-[20px] h-[20px] rounded-circle border-round text-[0.9em] text-secondary cursor-pointer hover:bg-tertiary";

export const TABLE_RESIZE_HANDLE_CLASS =
	"resizeTarget absolute top-0 bottom-0 right-0 w-[4px] cursor-ew-resize z-1 -right-xs";
