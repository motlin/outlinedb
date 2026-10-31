/**
 * Upstream item metadata the public API does not return, from each
 * `/get_tree_data/` item's `metadata`, stored in typed temporal node tables:
 *   - `calendar` in `calendar_metadata` and, for its `levels`, `calendar_levels`
 *     (the same rows a backup import writes, through the same normalizer).
 *   - `layoutMode` in `node_metadata.layout_mode`, the default `"bullets"` as NULL.
 *   - `numbered_start`, `restorableUniqueNode`, `table.headers`/`.skipHeaders`/`.bg`
 *     and `priority.defaultToBottom` in `node_display_metadata`.
 *   - `table.sizes` in `node_table_cell_sizes`.
 * {@link readInternalMetadata} rebuilds the upstream-shaped object from those
 * rows, so metadata patches can be built against it.
 */

import {and, eq, inArray} from "drizzle-orm";
import type {SQLiteColumn, SQLiteTable} from "drizzle-orm/sqlite-core";
import {z} from "zod";
import type {TreeSnapshot} from "../api/workflowy-internal-client.js";
import {
	calendarLevels,
	calendarMetadata,
	nodeContent,
	nodeDisplayMetadata,
	nodeMetadata,
	nodeTableCellSizes,
} from "../db/schema.js";
import type {NewNodeDisplayMetadata, NewNodeTableCellSize} from "../db/schema.js";
import {FAR_FUTURE_DATE} from "../temporal/index.js";
import {normalizeLayoutMode} from "./cache-temporal.js";
import {replaceExpansion} from "./expansion-store.js";
import {runUnitOfWork} from "./node-composite.js";
import type {UnitOfWork} from "./node-composite.js";
import type {NormalizedCalendarLevelsRow, NormalizedCalendarMetadataRow} from "./normalized-rows.js";
import {closeCurrentVersions, joinKey, temporalMerge} from "./temporal-merge.js";
import type {TemporalTransaction} from "./temporal-merge.js";
import {replaceTreeTxId} from "./tree-transaction.js";

/** An item's kept metadata in upstream's shape, as {@link keptInternalMetadata} returns it. */
export type InternalMetadata = Record<string, unknown>;

/** One `node_display_metadata` row without its temporal envelope. */
type DisplayRow = Omit<NewNodeDisplayMetadata, "systemFrom" | "systemTo">;
/** One `node_table_cell_sizes` row without its temporal envelope. */
type CellSizeRow = Omit<NewNodeTableCellSize, "systemFrom" | "systemTo">;

/** Durable Object SQLite caps a statement at 100 bound parameters. */
const ID_CHUNK = 90;

/** Top-level item metadata keys the app reads; `mirror` stays with the mirror import. */
const KEPT_METADATA_KEYS = ["numbered_start", "calendar", "layoutMode", "table", "restorableUniqueNode"] as const;

/**
 * The subset of an item's internal metadata the cache keeps:
 * `numbered_start`, `calendar`, `restorableUniqueNode`, `layoutMode`, `table` and `priority.defaultToBottom`.
 * Undefined when none of them is present.
 */
export function keptInternalMetadata(metadata: InternalMetadata | undefined): InternalMetadata | undefined {
	if (metadata === undefined) {
		return undefined;
	}
	const kept: InternalMetadata = {};
	for (const key of KEPT_METADATA_KEYS) {
		if (Object.hasOwn(metadata, key)) {
			kept[key] = metadata[key];
		}
	}
	const {priority} = metadata;
	if (typeof priority === "object" && priority !== null && Object.hasOwn(priority, "defaultToBottom")) {
		const defaultToBottom: unknown = Reflect.get(priority, "defaultToBottom");
		kept.priority = {defaultToBottom};
	}
	return Object.keys(kept).length === 0 ? undefined : kept;
}

/** Upstream's `metadata.calendar`, as both a backup and `/get_tree_data/` carry it. */
export interface UpstreamCalendar {
	root?: boolean | undefined;
	level?: string | undefined;
	levels?: Partial<Record<string, boolean>> | undefined;
	value?: string | undefined;
	dateId?: number | undefined;
	timestamp?: number | undefined;
	found_dates?: boolean | undefined;
	day_prefix?: boolean | undefined;
}

/** `schema`'s value, or undefined when the field is absent or malformed, so one bad field drops only itself. */
function lenient<T>(schema: z.ZodType<T>) {
	return z
		.unknown()
		.transform((value): T | undefined => {
			const parsed = schema.safeParse(value);
			return parsed.success ? parsed.data : undefined;
		})
		.optional();
}

const optionalBoolean = lenient(z.boolean());
const UpstreamCalendarSchema = z
	.object({
		root: optionalBoolean,
		level: lenient(z.string()),
		levels: lenient(z.record(z.string(), z.boolean())),
		value: lenient(z.union([z.string(), z.number().transform(String)])),
		dateId: lenient(z.number().int()),
		timestamp: lenient(z.number()),
		found_dates: optionalBoolean,
		day_prefix: optionalBoolean,
	})
	.loose();

const TableSchema = z
	.object({
		headers: optionalBoolean,
		skipHeaders: optionalBoolean,
		bg: lenient(z.string()),
		sizes: lenient(z.record(z.string(), z.unknown())),
	})
	.loose();

function booleanToInt(value: boolean | undefined): 0 | 1 | null {
	return value === undefined ? null : value ? 1 : 0;
}

function intToBoolean(value: number | null): boolean | undefined {
	return value === null ? undefined : value === 1;
}

/** The `calendar_metadata` row, and the `calendar_levels` row when it has `levels`, of one node's calendar. */
export function calendarRows(
	nodeId: string,
	calendar: UpstreamCalendar,
): {calendarMetadata: NormalizedCalendarMetadataRow; calendarLevels?: NormalizedCalendarLevelsRow} {
	const {levels} = calendar;
	return {
		calendarMetadata: {
			nodeId,
			root: booleanToInt(calendar.root),
			level: calendar.level ?? null,
			value: calendar.value ?? null,
			dateId: calendar.dateId ?? null,
			timestamp: calendar.timestamp ?? null,
			foundDates: booleanToInt(calendar.found_dates),
			dayPrefix: booleanToInt(calendar.day_prefix),
		},
		...(levels === undefined
			? {}
			: {
					calendarLevels: {
						nodeId,
						day: booleanToInt(levels.day),
						week: booleanToInt(levels.week),
						month: booleanToInt(levels.month),
						year: booleanToInt(levels.year),
					},
				}),
	};
}

/** The typed rows of one node's kept metadata. */
interface TypedRows {
	layoutMode: string | null;
	calendarMetadata?: NormalizedCalendarMetadataRow;
	calendarLevels?: NormalizedCalendarLevelsRow;
	display?: DisplayRow;
	cellSizes: CellSizeRow[];
}

function typedRows(nodeId: string, metadata: InternalMetadata | undefined): TypedRows {
	const kept = keptInternalMetadata(metadata) ?? {};
	const rows: TypedRows = {
		layoutMode: normalizeLayoutMode(typeof kept.layoutMode === "string" ? kept.layoutMode : null),
		cellSizes: [],
	};
	const calendar = UpstreamCalendarSchema.safeParse(kept.calendar);
	if (calendar.success) {
		Object.assign(rows, calendarRows(nodeId, calendar.data));
	}
	const table = TableSchema.safeParse(kept.table);
	const priority = z.object({defaultToBottom: optionalBoolean}).safeParse(kept.priority);
	const display: DisplayRow = {
		nodeId,
		numberedStart:
			typeof kept.numbered_start === "number" && Number.isInteger(kept.numbered_start)
				? kept.numbered_start
				: null,
		restorableUniqueNode:
			typeof kept.restorableUniqueNode === "boolean" ? booleanToInt(kept.restorableUniqueNode) : null,
		tableHeaders: table.success ? booleanToInt(table.data.headers) : null,
		tableSkipHeaders: table.success ? booleanToInt(table.data.skipHeaders) : null,
		tableBg: table.success ? (table.data.bg ?? null) : null,
		priorityDefaultToBottom: priority.success ? booleanToInt(priority.data.defaultToBottom) : null,
	};
	if (Object.entries(display).some(([key, value]) => key !== "nodeId" && value !== null)) {
		rows.display = display;
	}
	if (table.success) {
		for (const [cellId, size] of Object.entries(table.data.sizes ?? {})) {
			if (typeof size === "number") {
				rows.cellSizes.push({nodeId, cellId, size});
			}
		}
	}
	return rows;
}

function chunks<T>(items: readonly T[]): T[][] {
	const result: T[][] = [];
	for (let start = 0; start < items.length; start += ID_CHUNK) {
		result.push(items.slice(start, start + ID_CHUNK));
	}
	return result;
}

/** The live rows of `table`, all of them or only those owned by `ownerIds`. */
function liveRows<TTable extends SQLiteTable>(
	tx: TemporalTransaction,
	table: TTable,
	ownerColumn: SQLiteColumn,
	systemToColumn: SQLiteColumn,
	ownerIds: readonly string[] | undefined,
): TTable["$inferSelect"][] {
	if (ownerIds === undefined) {
		return tx.select().from(table).where(eq(systemToColumn, FAR_FUTURE_DATE)).all();
	}
	return chunks(ownerIds).flatMap((chunk) =>
		tx
			.select()
			.from(table)
			.where(and(eq(systemToColumn, FAR_FUTURE_DATE), inArray(ownerColumn, chunk)))
			.all(),
	);
}

/** True when every one of `fields` is equal on both rows, a missing field counting as null. */
function sameFields(fields: readonly string[]) {
	return (current: object, incoming: object): boolean =>
		fields.every((field) => (Reflect.get(current, field) ?? null) === (Reflect.get(incoming, field) ?? null));
}

/** Merge `incoming` into a node-owned temporal table, phasing out the live rows of the scope it does not carry. */
function mergeOwned(
	{tx, systemTime}: UnitOfWork,
	options: {
		table: SQLiteTable;
		owner: SQLiteColumn;
		systemTo: SQLiteColumn;
		keyColumns: SQLiteColumn[];
		key: (row: object) => string;
		fields: readonly string[];
	},
	incoming: object[],
	ownerIds: readonly string[] | undefined,
): void {
	temporalMerge(
		tx,
		{
			table: options.table,
			keyColumns: options.keyColumns,
			incomingKey: options.key,
			currentKey: options.key,
			contentMatches: sameFields(options.fields),
			buildInsertRow: (row: object) => ({...row}),
		},
		incoming,
		liveRows(tx, options.table, options.owner, options.systemTo, ownerIds),
		systemTime,
	);
}

const nodeKey = (row: object): string => String(Reflect.get(row, "nodeId"));

/** Re-version the live `node_metadata` rows whose `layout_mode` differs from `layoutModes`; nodes without a row are skipped. */
function mergeLayoutModes(
	{tx, systemTime}: UnitOfWork,
	layoutModes: ReadonlyMap<string, string | null>,
	ownerIds: readonly string[] | undefined,
): void {
	const changed = liveRows(tx, nodeMetadata, nodeMetadata.nodeId, nodeMetadata.systemTo, ownerIds).filter(
		// A legacy "bullets" row already means the default, so it is no change.
		(row) => layoutModes.has(row.nodeId) && layoutModes.get(row.nodeId) !== normalizeLayoutMode(row.layoutMode),
	);
	for (const chunk of chunks(changed)) {
		closeCurrentVersions(
			tx,
			nodeMetadata,
			systemTime,
			inArray(
				nodeMetadata.nodeId,
				chunk.map((row) => row.nodeId),
			),
		);
	}
	const rowsPerStatement = 9;
	for (let start = 0; start < changed.length; start += rowsPerStatement) {
		tx.insert(nodeMetadata)
			.values(
				changed.slice(start, start + rowsPerStatement).map((row) => ({
					...row,
					layoutMode: layoutModes.get(row.nodeId) ?? null,
					systemFrom: systemTime,
					systemTo: FAR_FUTURE_DATE,
				})),
			)
			.run();
	}
}

/**
 * Write the kept metadata of each node in `metadataById` (undefined: none) to
 * the typed tables in the caller's unit of work, phasing out what a node no
 * longer has. With `wholeTree`, the live rows of every other node are phased
 * out too (a whole-tree import); otherwise other nodes are untouched.
 */
export function writeInternalMetadata(
	unitOfWork: UnitOfWork,
	metadataById: ReadonlyMap<string, InternalMetadata | undefined>,
	{wholeTree = false}: {wholeTree?: boolean} = {},
): void {
	const ids = [...metadataById.keys()];
	const scope = wholeTree ? undefined : ids;
	const calendarRowsOut: NormalizedCalendarMetadataRow[] = [];
	const levelsRowsOut: NormalizedCalendarLevelsRow[] = [];
	const displayRowsOut: DisplayRow[] = [];
	const cellSizeRowsOut: CellSizeRow[] = [];
	const layoutModes = new Map<string, string | null>();
	for (const [id, metadata] of metadataById) {
		const rows = typedRows(id, metadata);
		layoutModes.set(id, rows.layoutMode);
		if (rows.calendarMetadata !== undefined) {
			calendarRowsOut.push(rows.calendarMetadata);
		}
		if (rows.calendarLevels !== undefined) {
			levelsRowsOut.push(rows.calendarLevels);
		}
		if (rows.display !== undefined) {
			displayRowsOut.push(rows.display);
		}
		cellSizeRowsOut.push(...rows.cellSizes);
	}
	mergeOwned(
		unitOfWork,
		{
			table: calendarMetadata,
			owner: calendarMetadata.nodeId,
			systemTo: calendarMetadata.systemTo,
			keyColumns: [calendarMetadata.nodeId],
			key: nodeKey,
			fields: ["root", "level", "value", "dateId", "timestamp", "foundDates", "dayPrefix"],
		},
		calendarRowsOut,
		scope,
	);
	mergeOwned(
		unitOfWork,
		{
			table: calendarLevels,
			owner: calendarLevels.nodeId,
			systemTo: calendarLevels.systemTo,
			keyColumns: [calendarLevels.nodeId],
			key: nodeKey,
			fields: ["day", "week", "month", "year"],
		},
		levelsRowsOut,
		scope,
	);
	mergeOwned(
		unitOfWork,
		{
			table: nodeDisplayMetadata,
			owner: nodeDisplayMetadata.nodeId,
			systemTo: nodeDisplayMetadata.systemTo,
			keyColumns: [nodeDisplayMetadata.nodeId],
			key: nodeKey,
			fields: [
				"numberedStart",
				"restorableUniqueNode",
				"tableHeaders",
				"tableSkipHeaders",
				"tableBg",
				"priorityDefaultToBottom",
			],
		},
		displayRowsOut,
		scope,
	);
	mergeOwned(
		unitOfWork,
		{
			table: nodeTableCellSizes,
			owner: nodeTableCellSizes.nodeId,
			systemTo: nodeTableCellSizes.systemTo,
			keyColumns: [nodeTableCellSizes.nodeId, nodeTableCellSizes.cellId],
			key: (row) => joinKey(nodeKey(row), String(Reflect.get(row, "cellId"))),
			fields: ["size"],
		},
		cellSizeRowsOut,
		scope,
	);
	mergeLayoutModes(unitOfWork, layoutModes, wholeTree ? undefined : ids);
}

/** {@link writeInternalMetadata} for some nodes, in a unit of work of its own. */
export function storeInternalMetadata(
	database: TemporalTransaction,
	metadataById: ReadonlyMap<string, InternalMetadata | undefined>,
): void {
	if (metadataById.size > 0) {
		runUnitOfWork(database, (unitOfWork) => {
			writeInternalMetadata(unitOfWork, metadataById);
		});
	}
}

function calendarOf(row: typeof calendarMetadata.$inferSelect, levels: typeof calendarLevels.$inferSelect | undefined) {
	const calendar: InternalMetadata = {};
	const set = (key: string, value: unknown) => {
		if (value !== null && value !== undefined) {
			calendar[key] = value;
		}
	};
	set("root", intToBoolean(row.root));
	set("level", row.level);
	set("value", row.value);
	set("dateId", row.dateId);
	set("timestamp", row.timestamp);
	set("found_dates", intToBoolean(row.foundDates));
	set("day_prefix", intToBoolean(row.dayPrefix));
	if (levels !== undefined) {
		const flags: Record<string, boolean> = {};
		for (const level of ["day", "week", "month", "year"] as const) {
			const flag = intToBoolean(levels[level]);
			if (flag !== undefined) {
				flags[level] = flag;
			}
		}
		calendar.levels = flags;
	}
	return calendar;
}

/**
 * Each of `ids`' stored kept metadata in upstream's shape (`layoutMode`,
 * `numbered_start`, `calendar`, `table`, `restorableUniqueNode`,
 * `priority.defaultToBottom`); ids with none are absent.
 */
export function readInternalMetadata(
	database: TemporalTransaction,
	ids: readonly string[],
): Map<string, InternalMetadata> {
	const result = new Map<string, InternalMetadata>();
	const entry = (id: string): InternalMetadata => {
		let metadata = result.get(id);
		if (metadata === undefined) {
			metadata = {};
			result.set(id, metadata);
		}
		return metadata;
	};
	const unique = [...new Set(ids)];
	const layoutRows = liveRows(database, nodeMetadata, nodeMetadata.nodeId, nodeMetadata.systemTo, unique);
	const calendarRowsIn = liveRows(
		database,
		calendarMetadata,
		calendarMetadata.nodeId,
		calendarMetadata.systemTo,
		unique,
	);
	const levelRows = new Map(
		liveRows(database, calendarLevels, calendarLevels.nodeId, calendarLevels.systemTo, unique).map((row) => [
			row.nodeId,
			row,
		]),
	);
	const displayRows = liveRows(
		database,
		nodeDisplayMetadata,
		nodeDisplayMetadata.nodeId,
		nodeDisplayMetadata.systemTo,
		unique,
	);
	const sizeRows = liveRows(
		database,
		nodeTableCellSizes,
		nodeTableCellSizes.nodeId,
		nodeTableCellSizes.systemTo,
		unique,
	);
	for (const row of layoutRows) {
		const layoutMode = normalizeLayoutMode(row.layoutMode);
		if (layoutMode !== null) {
			entry(row.nodeId).layoutMode = layoutMode;
		}
	}
	for (const row of calendarRowsIn) {
		entry(row.nodeId).calendar = calendarOf(row, levelRows.get(row.nodeId));
	}
	for (const [nodeId, levels] of levelRows) {
		const metadata = entry(nodeId);
		metadata.calendar ??= calendarOf(
			{
				nodeId,
				root: null,
				level: null,
				value: null,
				dateId: null,
				timestamp: null,
				foundDates: null,
				dayPrefix: null,
				systemFrom: "",
				systemTo: "",
			},
			levels,
		);
	}
	const tables = new Map<string, InternalMetadata>();
	const table = (id: string): InternalMetadata => {
		let value = tables.get(id);
		if (value === undefined) {
			value = {};
			tables.set(id, value);
			entry(id).table = value;
		}
		return value;
	};
	for (const row of displayRows) {
		const metadata = entry(row.nodeId);
		if (row.numberedStart !== null) {
			metadata.numbered_start = row.numberedStart;
		}
		if (row.restorableUniqueNode !== null) {
			metadata.restorableUniqueNode = row.restorableUniqueNode === 1;
		}
		if (row.priorityDefaultToBottom !== null) {
			metadata.priority = {defaultToBottom: row.priorityDefaultToBottom === 1};
		}
		if (row.tableHeaders !== null) {
			table(row.nodeId).headers = row.tableHeaders === 1;
		}
		if (row.tableSkipHeaders !== null) {
			table(row.nodeId).skipHeaders = row.tableSkipHeaders === 1;
		}
		if (row.tableBg !== null) {
			table(row.nodeId).bg = row.tableBg;
		}
	}
	const sizesByNode = new Map<string, Record<string, number>>();
	for (const row of sizeRows) {
		let sizes = sizesByNode.get(row.nodeId);
		if (sizes === undefined) {
			sizes = {};
			sizesByNode.set(row.nodeId, sizes);
			table(row.nodeId).sizes = sizes;
		}
		sizes[row.cellId] = row.size;
	}
	return result;
}

/** One node's stored kept metadata in upstream's shape, `{}` when it has none. */
export function readNodeInternalMetadata(database: TemporalTransaction, id: string): InternalMetadata {
	return readInternalMetadata(database, [id]).get(id) ?? {};
}

export interface ImportInternalMetadataResult {
	/** Cached nodes whose kept metadata was written. */
	written: number;
	/** Items with kept metadata whose node is absent from the cache. */
	skipped: number;
}

/**
 * Store a whole-tree snapshot's kept item metadata in the typed tables, and
 * its transaction id and expanded keys, in one unit of work. Only nodes
 * currently in `node_content` are written; any other node's calendar and
 * display rows are phased out, and `node_content` is not touched. Call it
 * after the snapshot's edge rows are merged: the stored id says the cache is
 * current to that transaction.
 */
export function importInternalMetadata(
	database: TemporalTransaction,
	{items, txId, expandedKeys}: TreeSnapshot,
	fetchedAt: number,
): ImportInternalMetadataResult {
	const result: ImportInternalMetadataResult = {written: 0, skipped: 0};
	runUnitOfWork(database, (unitOfWork) => {
		const {tx} = unitOfWork;
		replaceTreeTxId(unitOfWork, txId);
		replaceExpansion(unitOfWork, expandedKeys, fetchedAt);
		const cached = new Set(
			tx
				.select({id: nodeContent.id})
				.from(nodeContent)
				.where(eq(nodeContent.systemTo, FAR_FUTURE_DATE))
				.all()
				.map((row) => row.id),
		);
		const metadataById = new Map<string, InternalMetadata | undefined>();
		for (const item of items) {
			const kept = keptInternalMetadata(item.metadata);
			if (!cached.has(item.id)) {
				if (kept !== undefined) {
					result.skipped++;
				}
				continue;
			}
			metadataById.set(item.id, kept);
			if (kept !== undefined) {
				result.written++;
			}
		}
		writeInternalMetadata(unitOfWork, metadataById, {wholeTree: true});
	});
	return result;
}
