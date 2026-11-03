/**
 * Shared import sink: the single seam where both import adapters terminate.
 *
 * The bulk-export adapter (`cache-import.ts`) and the per-node REST adapter
 * (`cache-import-api.ts`) each own their own JSON-shape normalization — tree
 * walks, legacy epoch math, field-name remapping, missing-field defaults. Their
 * job ends when they have produced `Normalized*Row[]` arrays per destination
 * table (see {@link ./normalized-rows.ts}).
 *
 * `applyRows` owns everything downstream of that: opening the transaction,
 * loading current rows, dispatching each table to {@link temporalMerge}, and
 * doing so in foreign-key-correct order. Neither adapter reimplements the
 * temporal merge-list pattern anymore.
 */

import {and, eq, inArray} from "drizzle-orm";
import type {BaseSQLiteDatabase, SQLiteColumn, SQLiteTable} from "drizzle-orm/sqlite-core";
import {
	aiMetadata,
	calendarLevels,
	calendarMetadata,
	changesMetadata,
	nodeContent,
	nodeMetadata,
	referencesRoots,
	s3Files,
} from "../db/schema.js";
import type {CalendarLevels, CalendarMetadata, S3File} from "../db/schema.js";
import {FAR_FUTURE_DATE} from "../temporal/index.js";
import {contentMatches, keepSkewedTimestamps, metadataMatches} from "./cache-temporal.js";
import type {
	NormalizedAiMetadataRow,
	NormalizedCalendarLevelsRow,
	NormalizedCalendarMetadataRow,
	NormalizedChangesMetadataRow,
	NormalizedNodeContentRow,
	NormalizedNodeMetadataRow,
	NormalizedReferencesRootsRow,
	NormalizedS3FileRow,
} from "./normalized-rows.js";
import type {UnitOfWork} from "./node-composite.js";
import {temporalMerge} from "./temporal-merge.js";
import type {TemporalMergeResult, TemporalTransaction} from "./temporal-merge.js";

/**
 * The desired current state of every node-keyed temporal table, as produced by
 * an import adapter. Every field is optional: an adapter only supplies the
 * tables it actually normalizes (the per-node REST adapter, for example,
 * carries no calendar data, so it omits those keys entirely).
 *
 * Omitting a key means "this adapter does not manage this table" — its rows are
 * left untouched. Supplying an empty array means "this adapter manages this
 * table and the desired state is empty" — all current rows are phased out.
 */
export interface NormalizedRowsByTable {
	nodeContent?: NormalizedNodeContentRow[];
	nodeMetadata?: NormalizedNodeMetadataRow[];
	calendarMetadata?: NormalizedCalendarMetadataRow[];
	calendarLevels?: NormalizedCalendarLevelsRow[];
	aiMetadata?: NormalizedAiMetadataRow[];
	s3Files?: NormalizedS3FileRow[];
	changesMetadata?: NormalizedChangesMetadataRow[];
	referencesRoots?: NormalizedReferencesRootsRow[];
}

/**
 * Per-table merge results, keyed by the same names as {@link NormalizedRowsByTable}.
 * A table absent from the input is absent here too.
 */
export interface ApplyRowsResult {
	nodeContent?: TemporalMergeResult;
	nodeMetadata?: TemporalMergeResult;
	calendarMetadata?: TemporalMergeResult;
	calendarLevels?: TemporalMergeResult;
	aiMetadata?: TemporalMergeResult;
	s3Files?: TemporalMergeResult;
	changesMetadata?: TemporalMergeResult;
	referencesRoots?: TemporalMergeResult;
}

function s3Matches(current: S3File, incoming: NormalizedS3FileRow): boolean {
	return (
		current.fileName === incoming.fileName &&
		current.fileType === incoming.fileType &&
		current.objectFolder === (incoming.objectFolder ?? null) &&
		current.isAnimatedGif === (incoming.isAnimatedGif ?? null) &&
		current.imageOriginalWidth === (incoming.imageOriginalWidth ?? null) &&
		current.imageOriginalHeight === (incoming.imageOriginalHeight ?? null) &&
		current.imageOriginalPixels === (incoming.imageOriginalPixels ?? null) &&
		current.isDeleted === (incoming.isDeleted ?? null)
	);
}

function calendarMetadataMatches(current: CalendarMetadata, incoming: NormalizedCalendarMetadataRow): boolean {
	return (
		current.root === (incoming.root ?? null) &&
		current.level === (incoming.level ?? null) &&
		current.value === (incoming.value ?? null) &&
		current.dateId === (incoming.dateId ?? null) &&
		current.timestamp === (incoming.timestamp ?? null) &&
		current.foundDates === (incoming.foundDates ?? null) &&
		current.dayPrefix === (incoming.dayPrefix ?? null)
	);
}

function calendarLevelsMatches(current: CalendarLevels, incoming: NormalizedCalendarLevelsRow): boolean {
	return (
		current.day === (incoming.day ?? null) &&
		current.week === (incoming.week ?? null) &&
		current.month === (incoming.month ?? null) &&
		current.year === (incoming.year ?? null)
	);
}

/** Bound-parameter chunk for `id IN (...)` lookups; Durable Object SQLite caps a statement at 100. */
const LOOKUP_CHUNK_SIZE = 90;

/**
 * Merge one node-keyed temporal table. Loads the table's current rows, runs the
 * temporal merge, and returns the result. The `nodeId` accessor and a
 * `contentMatches` predicate are the only per-table specifics.
 */
function mergeNodeKeyedTable<TIncoming, TTable extends SQLiteTable>(
	tx: TemporalTransaction,
	table: TTable,
	keyColumn: SQLiteColumn,
	systemToColumn: SQLiteColumn,
	incoming: TIncoming[],
	incomingKey: (row: TIncoming) => string,
	currentKey: (row: TTable["$inferSelect"]) => string,
	contentEquals: (current: TTable["$inferSelect"], incoming: TIncoming) => boolean,
	// oxlint-disable-next-line @typescript-eslint/no-explicit-any
	buildInsertRow: (incoming: TIncoming, current: TTable["$inferSelect"] | undefined) => Record<string, any>,
	importedAt: string,
	preserveKeys?: ReadonlySet<string>,
	onlyKeys?: readonly string[],
): TemporalMergeResult {
	let currentRows: TTable["$inferSelect"][] = [];
	if (onlyKeys === undefined) {
		// Assigned, not spread into push(): a full table has more rows than one call's argument list allows.
		currentRows = tx.select().from(table).where(eq(systemToColumn, FAR_FUTURE_DATE)).all();
	} else {
		for (let start = 0; start < onlyKeys.length; start += LOOKUP_CHUNK_SIZE) {
			currentRows.push(
				...tx
					.select()
					.from(table)
					.where(
						and(
							eq(systemToColumn, FAR_FUTURE_DATE),
							inArray(keyColumn, onlyKeys.slice(start, start + LOOKUP_CHUNK_SIZE)),
						),
					)
					.all(),
			);
		}
	}
	return temporalMerge(
		tx,
		{
			table,
			keyColumn,
			incomingKey,
			currentKey,
			contentMatches: contentEquals,
			buildInsertRow,
			preserveKeys,
		},
		incoming,
		currentRows,
		importedAt,
	);
}

/**
 * Apply normalized rows to the cache database.
 *
 * Runs in the caller's unit of work (its transaction, with its system time as
 * the import time), dispatching each supplied table to
 * {@link temporalMerge} in foreign-key-correct order: `node_content` and
 * `node_metadata` first (they describe the nodes themselves), then the
 * node-attribute tables that reference a node. Tables absent from `rowsByTable`
 * are skipped entirely — their current rows are left untouched.
 *
 * @param unitOfWork The caller's transaction and system time.
 * @param rowsByTable Desired current state per destination table.
 * @param preserveNodeIds Nodes that must stay open even when absent from
 *   `rowsByTable`, because the incoming data predates them.
 * @param onlyNodeIds Merge only these nodes' rows: look up and phase out
 *   nothing else, so one chunk of a larger import leaves every other node alone.
 */
export function applyRows(
	unitOfWork: UnitOfWork,
	rowsByTable: NormalizedRowsByTable,
	preserveNodeIds?: ReadonlySet<string>,
	onlyNodeIds?: readonly string[],
): ApplyRowsResult {
	const result: ApplyRowsResult = {};
	const {tx, systemTime: importedAt} = unitOfWork;

	// node_content / node_metadata describe the nodes themselves; merge first.
	if (rowsByTable.nodeContent !== undefined) {
		result.nodeContent = mergeNodeKeyedTable(
			tx,
			nodeContent,
			nodeContent.id,
			nodeContent.systemTo,
			rowsByTable.nodeContent,
			(row) => row.id,
			(row) => row.id,
			(current, incoming) =>
				contentMatches(current, {
					name: incoming.name ?? null,
					note: incoming.note ?? null,
					parentId: incoming.parentId ?? null,
				}),
			(row) => ({...row}),
			importedAt,
			preserveNodeIds,
			onlyNodeIds,
		);
	}

	if (rowsByTable.nodeMetadata !== undefined) {
		result.nodeMetadata = mergeNodeKeyedTable(
			tx,
			nodeMetadata,
			nodeMetadata.nodeId,
			nodeMetadata.systemTo,
			rowsByTable.nodeMetadata,
			(row) => row.nodeId,
			(row) => row.nodeId,
			(current, incoming) =>
				metadataMatches(current, {
					priority: incoming.priority ?? null,
					createdAt: toUnix(incoming.createdAt),
					modifiedAt: toUnix(incoming.modifiedAt),
					completedAt: toUnix(incoming.completedAt),
					layoutMode: incoming.layoutMode ?? null,
				}),
			(row, current) => (current ? keepSkewedTimestamps(current, row) : {...row}),
			importedAt,
			preserveNodeIds,
			onlyNodeIds,
		);
	}

	// Node-attribute tables reference a node; merge after the node rows.
	if (rowsByTable.calendarMetadata !== undefined) {
		result.calendarMetadata = mergeNodeKeyedTable(
			tx,
			calendarMetadata,
			calendarMetadata.nodeId,
			calendarMetadata.systemTo,
			rowsByTable.calendarMetadata,
			(row) => row.nodeId,
			(row) => row.nodeId,
			calendarMetadataMatches,
			(row) => ({...row}),
			importedAt,
			preserveNodeIds,
			onlyNodeIds,
		);
	}

	if (rowsByTable.calendarLevels !== undefined) {
		result.calendarLevels = mergeNodeKeyedTable(
			tx,
			calendarLevels,
			calendarLevels.nodeId,
			calendarLevels.systemTo,
			rowsByTable.calendarLevels,
			(row) => row.nodeId,
			(row) => row.nodeId,
			calendarLevelsMatches,
			(row) => ({...row}),
			importedAt,
			preserveNodeIds,
			onlyNodeIds,
		);
	}

	if (rowsByTable.aiMetadata !== undefined) {
		result.aiMetadata = mergeNodeKeyedTable(
			tx,
			aiMetadata,
			aiMetadata.nodeId,
			aiMetadata.systemTo,
			rowsByTable.aiMetadata,
			(row) => row.nodeId,
			(row) => row.nodeId,
			(current, incoming) => current.inChat === incoming.inChat,
			(row) => ({...row}),
			importedAt,
			preserveNodeIds,
			onlyNodeIds,
		);
	}

	if (rowsByTable.s3Files !== undefined) {
		result.s3Files = mergeNodeKeyedTable(
			tx,
			s3Files,
			s3Files.nodeId,
			s3Files.systemTo,
			rowsByTable.s3Files,
			(row) => row.nodeId,
			(row) => row.nodeId,
			s3Matches,
			(row) => ({...row}),
			importedAt,
			preserveNodeIds,
			onlyNodeIds,
		);
	}

	if (rowsByTable.changesMetadata !== undefined) {
		result.changesMetadata = mergeNodeKeyedTable(
			tx,
			changesMetadata,
			changesMetadata.nodeId,
			changesMetadata.systemTo,
			rowsByTable.changesMetadata,
			(row) => row.nodeId,
			(row) => row.nodeId,
			(current, incoming) => current.ctBy === incoming.ctBy,
			(row) => ({...row}),
			importedAt,
			preserveNodeIds,
			onlyNodeIds,
		);
	}

	if (rowsByTable.referencesRoots !== undefined) {
		result.referencesRoots = mergeNodeKeyedTable(
			tx,
			referencesRoots,
			referencesRoots.nodeId,
			referencesRoots.systemTo,
			rowsByTable.referencesRoots,
			(row) => row.nodeId,
			(row) => row.nodeId,
			() => true,
			(row) => ({...row}),
			importedAt,
			preserveNodeIds,
			onlyNodeIds,
		);
	}

	return result;
}

/**
 * Convert a `Date` (as carried on a normalized metadata row) to a Unix-seconds
 * timestamp for comparison against the API/backup integer timestamps that
 * {@link metadataMatches} expects.
 */
function toUnix(date: Date | null | undefined): number | null {
	return date ? Math.floor(date.getTime() / 1000) : null;
}

/**
 * Merge one batch of node rows without ending anything absent from it.
 *
 * Unlike {@link applyRows}, this looks up only the batch's own ids and never
 * phases out other nodes; the caller ends nodes unseen by every batch itself.
 */
export function applyNodeRowsBatch(
	unitOfWork: UnitOfWork,
	rows: {nodeContent: NormalizedNodeContentRow[]; nodeMetadata: NormalizedNodeMetadataRow[]},
): {nodeContent: TemporalMergeResult; nodeMetadata: TemporalMergeResult} {
	const {tx, systemTime: importedAt} = unitOfWork;
	const contentIds = rows.nodeContent.map((row) => row.id);
	const metadataIds = rows.nodeMetadata.map((row) => row.nodeId);
	const content = mergeNodeKeyedTable(
		tx,
		nodeContent,
		nodeContent.id,
		nodeContent.systemTo,
		rows.nodeContent,
		(row) => row.id,
		(row) => row.id,
		(current, incoming) =>
			contentMatches(current, {
				name: incoming.name ?? null,
				note: incoming.note ?? null,
				parentId: incoming.parentId ?? null,
			}),
		(row) => ({...row}),
		importedAt,
		undefined,
		contentIds,
	);
	const metadata = mergeNodeKeyedTable(
		tx,
		nodeMetadata,
		nodeMetadata.nodeId,
		nodeMetadata.systemTo,
		rows.nodeMetadata,
		(row) => row.nodeId,
		(row) => row.nodeId,
		(current, incoming) =>
			metadataMatches(current, {
				priority: incoming.priority ?? null,
				createdAt: toUnix(incoming.createdAt),
				modifiedAt: toUnix(incoming.modifiedAt),
				completedAt: toUnix(incoming.completedAt),
				layoutMode: incoming.layoutMode ?? null,
			}),
		(row, current) => (current ? keepSkewedTimestamps(current, row) : {...row}),
		importedAt,
		undefined,
		metadataIds,
	);
	return {nodeContent: content, nodeMetadata: metadata};
}
