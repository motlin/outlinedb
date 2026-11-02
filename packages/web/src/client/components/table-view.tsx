// Mutual recursion between OutlineRow and the table renderer is intentional: a cell is an outline row.
import {useContext, useRef, useState} from "react";
import type {MouseEvent as ReactMouseEvent} from "react";
import {useShallow} from "zustand/react/shallow";
import type {NodeResponse} from "../../node-types.js";
import {addColumn, addRow} from "../table-actions.js";
import {TABLE_COLUMN, clampWidth, tableColumnWidth} from "../table.js";
import {copyNodesAt, useChildren, useUpdateNode} from "../hooks/use-nodes.js";
import {useTableDeps} from "../hooks/use-table-actions.js";
import {MirrorInstanceContext} from "../mirror-instance-context.js";
import {rendersInstanceRow} from "../render-window.js";
import {useOutlineStore} from "../stores/outline.js";
import {useQueryClient} from "@tanstack/react-query";
import {useZoomedFullBleed} from "./board-view.js";
import {InComplexLayoutContext} from "./complex-layout-context.js";
import {FaIcon} from "./fa-icons.js";
import {OutlineRow} from "./outline-node.js";
import
{
	ADD_COLUMN_CELL_CLASS,
	ADD_ROW_CLASS,
	TABLE_CHILDREN_CLASS,
	TABLE_RESIZE_HANDLE_CLASS,
	TABLE_ROW_BUTTON_CLASS,
	TABLE_ROW_CLASS,
	TABLE_ROW_GRIP_CLASS,
	TABLE_ROW_MENU_CLASS,
	TABLE_ROW_MENU_SLOT_CLASS,
	tableScrollerClass,
} from "./table-classes.js";

/** What a cell's outline row needs to know about its place in the table. */
export interface TableCellInfo
{
	header: boolean;
	/** The first cell of a body row holds the row-menu slot. */
	firstBody: boolean;
	rowIndex: number;
	/** The header cell's column width; body cells take theirs from the column. */
	width?: number;
	/** The row's grip selected it: every cell of the row carries `addedToSelection`. */
	rowSelected: boolean;
	onToggleRow: () => void;
	tableId: string;
}

/** The header "+": appends a column to every row and puts the caret in the new header cell. */
function AddColumnCell({tableId}: {tableId: string})
{
	const deps = useTableDeps();
	return (
		// oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- a mouse shortcut; keyboard users add a column with the Duplicate column command
		<div
			className={ADD_COLUMN_CELL_CLASS}
			onClick={() =>
			{
				void addColumn(deps, tableId);
			}}
		>
			<FaIcon icon="fal:plus" className="m-m" />
		</div>
	);
}

/** The add-row button under the table. */
function AddRowButton({tableId}: {tableId: string})
{
	const deps = useTableDeps();
	return (
		// oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- a mouse shortcut; keyboard users add a row with Enter in a cell
		<div
			className={ADD_ROW_CLASS}
			onClick={() =>
			{
				void addRow(deps, tableId);
			}}
		>
			<FaIcon icon="fal:plus" />
		</div>
	);
}

/** Upstream's header-cell resize handle: drag the right edge; the width saves as `table.sizes[<header cell id>]`. */
export function TableColumnResizeHandle({tableId, cellId}: {tableId: string; cellId: string})
{
	const {mutate: update} = useUpdateNode();
	const handleMouseDown = (event: ReactMouseEvent<HTMLDivElement>) =>
	{
		const cell = event.currentTarget.parentElement;
		if (cell === null)
		{
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		const startX = event.clientX;
		const initial = cell.getBoundingClientRect().width;
		const widthAt = (clientX: number) => clampWidth(initial + clientX - startX, TABLE_COLUMN.minWidth);
		const move = (moveEvent: MouseEvent) =>
		{
			cell.style.width = `${widthAt(moveEvent.clientX)}px`;
		};
		const up = (upEvent: MouseEvent) =>
		{
			document.removeEventListener("mousemove", move);
			document.removeEventListener("mouseup", up);
			const width = widthAt(upEvent.clientX);
			cell.style.width = `${width}px`;
			update(
				{
					nodeId: tableId,
					tableSet: [
						{
							path: ["table", "sizes", cellId],
							value: width,
						},
					],
				},
			);
		};
		document.addEventListener("mousemove", move);
		document.addEventListener("mouseup", up);
	};
	return (
		// oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- a pointer-only drag handle, as upstream's
		<div className={TABLE_RESIZE_HANDLE_CLASS} onMouseDown={handleMouseDown} />
	);
}

function stopEvent(event: ReactMouseEvent): void
{
	event.stopPropagation();
}

/** The row-menu slot in a body row's first cell: a grip on hover, plus copy and trash once the row is selected. */
export function TableRowMenuSlot({
	tableId,
	rowId,
	rowIndex,
	selected,
	onToggle,
}: {
	tableId: string;
	rowId: string;
	rowIndex: number;
	selected: boolean;
	onToggle: () => void;
})
{
	const [hovered, setHovered] = useState(false);
	const press = useRef<
	{
		x: number;
		y: number;
	} | null>(null);
	const queryClient = useQueryClient();
	const deps = useTableDeps();
	return (
		// oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- a pointer-only affordance, as upstream's
		<div
			className={TABLE_ROW_MENU_SLOT_CLASS}
			onMouseMove={() =>
			{
				setHovered(true);
			}}
			onMouseLeave={() =>
			{
				setHovered(false);
			}}
		>
			{hovered || selected ? (
				<div className={TABLE_ROW_MENU_CLASS}>
					{selected ? (
						<>
							{/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- pointer-only row buttons */}
							<div
								className={TABLE_ROW_BUTTON_CLASS}
								onMouseDown={stopEvent}
								onClick={() =>
								{
									void copyNodesAt(queryClient, "duplicate", [rowId], tableId, rowIndex + 1);
								}}
							>
								<FaIcon icon="fal:copy" />
							</div>
							{/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- pointer-only row buttons */}
							<div
								className={TABLE_ROW_BUTTON_CLASS}
								onMouseDown={stopEvent}
								onClick={() =>
								{
									deps.remove(rowId);
								}}
							>
								<FaIcon icon="fal:trash-can" />
							</div>
						</>
					) : null}
					{/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- pointer-only grip */}
					<div
						className={`${TABLE_ROW_GRIP_CLASS}${selected ? " cursor-grab" : ""}`}
						onMouseDown={(event) =>
						{
							event.stopPropagation();
							press.current =
							{
								x: event.clientX,
								y: event.clientY,
							};
						}}
						onMouseUp={(event) =>
						{
							const start = press.current;
							press.current = null;
							if (start !== null && Math.hypot(event.clientX - start.x, event.clientY - start.y) <= 3)
							{
								onToggle();
							}
						}}
					>
						<FaIcon icon="fal:grip-dots-vertical" />
					</div>
				</div>
			) : null}
		</div>
	);
}

function useRenderedChildren(parentId: string): NodeResponse[]
{
	const {data: nodes} = useChildren(parentId);
	const instance = useContext(MirrorInstanceContext);
	const {showCompleted, animatingCompletionIds} = useOutlineStore(
		useShallow((state) => (
		{
			showCompleted: state.showCompleted,
			animatingCompletionIds: state.animatingCompletionIds,
		})),
	);
	// Every row and cell of a table stays visible while a search is applied (`potentially_visible.table_cell_column`).
	return (nodes ?? []).filter((node) =>
		rendersInstanceRow(node, instance, showCompleted, animatingCompletionIds, null),
	);
}

function TableRow({
	table,
	row,
	rowIndex,
	depth,
}: {
	table: NodeResponse;
	row: NodeResponse;
	rowIndex: number;
	depth: number;
})
{
	const cells = useRenderedChildren(row.id);
	const [selected, setSelected] = useState(false);
	const header = rowIndex === 0;
	return (
		<div className={TABLE_ROW_CLASS} projectid={row.id}>
			{cells.map((cell, column) => (
				<OutlineRow
					key={cell.id}
					depth={depth + 2}
					node={cell}
					tableCell={
					{
						header,
						firstBody: !header && column === 0,
						rowIndex,
						...(header
							?
								{
									width: tableColumnWidth(table.table, cell.id),
								}
							: {}),
						rowSelected: selected,
						onToggleRow: () =>
						{
							setSelected((value) => !value);
						},
						tableId: table.id,
					}}
				/>
			))}
			{header ? <AddColumnCell tableId={table.id} /> : null}
		</div>
	);
}

/**
 * A table's rows as a CSS table inside a horizontal scroller, then the add-row button. Zoomed the strip is full
 * width; inline (an expanded table row) it is at most 300px tall. Rows are as stored: nothing pads a ragged row.
 */
export function TableChildren({table, zoomed, depth = 1}: {table: NodeResponse; zoomed: boolean; depth?: number})
{
	const rows = useRenderedChildren(table.id);
	const ref = useRef<HTMLDivElement>(null);
	useZoomedFullBleed(ref, zoomed && rows.length > 0);
	return (
		<InComplexLayoutContext.Provider value>
			<div
				ref={ref}
				className={tableScrollerClass(zoomed)}
				style={
					zoomed
						?
							{
								overflowAnchor: "none",
							}
						: undefined
				}
			>
				<div className={TABLE_CHILDREN_CLASS}>
					{rows.map((row, rowIndex) => (
						<TableRow key={row.id} depth={depth} row={row} rowIndex={rowIndex} table={table} />
					))}
				</div>
				<AddRowButton tableId={table.id} />
			</div>
		</InComplexLayoutContext.Provider>
	);
}
