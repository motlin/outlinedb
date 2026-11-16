import {and, eq, gt, inArray, ne, or} from "drizzle-orm";
import type {InternalTreeItem} from "../api/workflowy-internal-client.js";
import {nodeContent, nodeMetadata} from "../db/schema.js";
import type {NodeContentType, NodeMetadataType} from "../db/schema.js";
import type {AppDatabase} from "../db/types.js";
import {FAR_FUTURE_DATE, formatTemporalTimestamp} from "../temporal/index.js";
import {WorkflowyNodeSchema} from "../types/index.js";
import type {WorkflowyNode} from "../types/index.js";
import {uuidToShortId} from "../workflowy/index.js";
import {contentMatches, metadataComparisonStats, metadataMatches, normalizeLayoutMode} from "./cache-temporal.js";
import {applyNodeRowsBatch, applyRows} from "./importer.js";
import type {NormalizedRowsByTable} from "./importer.js";
import {collectItemRelationships, emptyItemRelationships, mergeItemRelationships} from "./item-relationships.js";
import type {ItemRelationships} from "./item-relationships.js";
import {runBulkUnitOfWork} from "./bulk-import.js";
import {endNodeComposites, endOrphanedParts, runUnitOfWork} from "./node-composite.js";
import {endStrandedBacklinkItems} from "./stranded-relationships.js";
import type {UnitOfWork} from "./node-composite.js";
import type {NormalizedNodeContentRow, NormalizedNodeMetadataRow} from "./normalized-rows.js";
import {compareBinary, DEFAULT_ORDER_KEY, orderKeysFor} from "./order-key.js";
import {pendingAspects} from "./outbox.js";
import type {OutboxAspect} from "./outbox.js";
import {startUnitOfWork} from "./system-time.js";
import type {UnitOfWorkStart} from "./system-time.js";

/** Bound-parameter chunk for `id IN (...)` lookups; Durable Object SQLite caps a statement at 100. */
const LOOKUP_CHUNK_SIZE = 90;

/** The logging the import needs; the host decides where it goes. */
export interface ImportLogger
{
	debug(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

export interface ImportApiResult
{
	totalNodes: number;
	nodesAdded: number;
	nodesUpdated: number;
	nodesUnchanged: number;
	nodesDeleted: number;
	nodesPhasedOut: number;
	contentUpdated: number;
	metadataUpdated: number;
	priorityUpdated: number;
	importTimestamp: Date;
}

export interface ImportFromApiOptions
{
	logger?: ImportLogger;
	timestamp?: Date;
	/**
	 * When the export was requested. The snapshot cannot speak for a row the cache
	 * wrote or closed after this instant, so such nodes are neither overwritten,
	 * re-added nor ended. Without it the snapshot is applied verbatim.
	 */
	snapshotTakenAt?: Date;
	/**
	 * A full `/get_tree_data/` read. The public API carries no mirrors or
	 * references roots; when given, those merge from its item
	 * metadata in the same unit of work. Without it their rows are left untouched.
	 */
	treeItems?: InternalTreeItem[];
}

interface ProcessedNode
{
	id: string;
	shortId: string;
	name: string | null;
	note: string | null;
	parentId: string | null;
	priority: number;
	createdAt: number | null;
	modifiedAt: number | null;
	completedAt: number | null;
	layoutMode: string | null;
}

interface PlacedSibling
{
	id: string;
	priority: number;
	orderKey: string;
}

/** Progress of one batched import. Opaque to callers; pass it between the three calls. */
export interface ApiImportState
{
	readonly database: AppDatabase;
	readonly logger: ImportLogger | undefined;
	readonly importTimestamp: Date;
	/** The import's system time and start; the transaction timeout counts from it. */
	readonly start: UnitOfWorkStart;
	/** {@link ImportFromApiOptions.snapshotTakenAt} as a system timestamp; undefined applies the snapshot verbatim. */
	readonly snapshotAt: number | undefined;
	readonly seenIds: Set<string>;
	/** Ids of nodes that failed validation: kept as they are, never ended as deleted. */
	readonly invalidIds: Set<string>;
	/** Per parent, the siblings earlier batches placed, with their upstream priority and final order key. */
	readonly placed: Map<string | null, PlacedSibling[]>;
	totalNodes: number;
	nodesAdded: number;
	nodesUpdated: number;
	nodesUnchanged: number;
	contentUpdated: number;
	metadataUpdated: number;
	validationErrors: number;
	startTime: number;
	relationshipNodeIds?: Set<string>;
}

function timestampToDate(timestamp: number | null | undefined): Date | null
{
	return timestamp === null || timestamp === undefined ? null : new Date(timestamp * 1000);
}

function nonEmpty(value: string | null | undefined): string | undefined
{
	return value === "" || value === null ? undefined : value;
}

function processNodes(state: ApiImportState, apiNodes: WorkflowyNode[]): ProcessedNode[]
{
	const processed: ProcessedNode[] = [];
	for (const node of apiNodes)
	{
		const parsed = WorkflowyNodeSchema.safeParse(node);
		if (!parsed.success)
		{
			state.validationErrors++;
			state.logger?.error(
				`Validation error for node ${node.id}: ${parsed.error.message}\nNode JSON: ${JSON.stringify(node, null, 2)}`,
			);
			if (typeof node.id === "string")
			{
				state.invalidIds.add(node.id);
			}
			continue;
		}
		const validated = parsed.data;
		processed.push(
			{
				id: validated.id,
				shortId: uuidToShortId(validated.id),
				name: validated.name,
				note: nonEmpty(validated.note) ?? null,
				parentId: validated.parent_id ?? null,
				priority: validated.priority,
				createdAt: validated.createdAt,
				modifiedAt: validated.modifiedAt ?? null,
				completedAt: validated.completedAt ?? null,
				layoutMode: normalizeLayoutMode(validated.data?.layoutMode),
			},
		);
	}
	return processed;
}

/**
 * Start a batched import. The system time is fixed here so every batch lands at
 * the same instant, and the transaction timeout counts from here: every batch
 * and the finish must commit within it.
 */
export function beginApiImport(
	database: AppDatabase,
	options:
	{
		logger?: ImportLogger;
		timestamp?: Date;
		snapshotTakenAt?: Date;
	} = {},
): ApiImportState
{
	const start = startUnitOfWork(options.timestamp);
	const startTime = start.startedAt;
	options.logger?.debug("[IMPORT-API] Starting import");
	metadataComparisonStats.reset();
	return {
		database,
		logger: options.logger,
		importTimestamp: options.timestamp ?? new Date(start.startedAt),
		start,
		snapshotAt:
			options.snapshotTakenAt === undefined ? undefined : formatTemporalTimestamp(options.snapshotTakenAt),
		seenIds: new Set(),
		invalidIds: new Set(),
		placed: new Map(),
		totalNodes: 0,
		nodesAdded: 0,
		nodesUpdated: 0,
		nodesUnchanged: 0,
		contentUpdated: 0,
		metadataUpdated: 0,
		validationErrors: 0,
		startTime,
	};
}

/**
 * Give each incoming node its order key. Per parent, the incoming siblings in upstream order (priority, then id) map
 * onto keys: a sibling already under that parent keeps its key while the order around it holds, and a new, moved or
 * reordered one gets a key between its neighbours. The siblings an earlier batch of this import placed keep the keys
 * they got, so a parent whose children span batches still ends up in upstream order.
 */
function assignOrderKeys(
	state: ApiImportState,
	nodes: ProcessedNode[],
	existingContent: Map<string, NodeContentType>,
	existingMetadata: Map<string, NodeMetadataType>,
): Map<string, string>
{
	const incomingByParent = new Map<string | null, ProcessedNode[]>();
	for (const node of nodes)
	{
		const siblings = incomingByParent.get(node.parentId) ?? [];
		siblings.push(node);
		incomingByParent.set(node.parentId, siblings);
	}
	const result = new Map<string, string>();
	for (const [parentId, incoming] of incomingByParent)
	{
		const placed = state.placed.get(parentId) ?? [];
		const sequence = [
			...placed.map((sibling) => (
			{
				...sibling,
				pinned: true,
			})),
			...incoming.map((node) => (
			{
				id: node.id,
				priority: node.priority,
				orderKey:
					existingContent.get(node.id)?.parentId === parentId
						? existingMetadata.get(node.id)?.orderKey
						: undefined,
				pinned: false,
			})),
		].toSorted((a, b) => a.priority - b.priority || compareBinary(a.id, b.id));
		const changed = orderKeysFor(sequence);
		for (const sibling of sequence)
		{
			if (sibling.pinned)
			{
				continue;
			}
			const orderKey = changed.get(sibling.id) ?? sibling.orderKey ?? DEFAULT_ORDER_KEY;
			result.set(sibling.id, orderKey);
			placed.push(
				{
					id: sibling.id,
					priority: sibling.priority,
					orderKey,
				},
			);
		}
		state.placed.set(parentId, placed);
	}
	return result;
}

/**
 * The ids among `ids` the cache wrote or closed after the snapshot was taken:
 * a live content or metadata version opened after it, or a content version
 * closed after it.
 */
function writtenAfterSnapshot(tx: UnitOfWork["tx"], ids: string[], snapshotAt: number): Set<string>
{
	const written = new Set<string>();
	for (let start = 0; start < ids.length; start += LOOKUP_CHUNK_SIZE)
	{
		const chunk = ids.slice(start, start + LOOKUP_CHUNK_SIZE);
		for (const row of tx
			.select(
				{
					id: nodeContent.id,
				},
			)
			.from(nodeContent)
			.where(
				and(
					inArray(nodeContent.id, chunk),
					or(
						and(eq(nodeContent.systemTo, FAR_FUTURE_DATE), gt(nodeContent.systemFrom, snapshotAt)),
						and(ne(nodeContent.systemTo, FAR_FUTURE_DATE), gt(nodeContent.systemTo, snapshotAt)),
					),
				),
			)
			.all())
		{
			written.add(row.id);
		}
		for (const row of tx
			.select(
				{
					id: nodeMetadata.nodeId,
				},
			)
			.from(nodeMetadata)
			.where(
				and(
					inArray(nodeMetadata.nodeId, chunk),
					eq(nodeMetadata.systemTo, FAR_FUTURE_DATE),
					gt(nodeMetadata.systemFrom, snapshotAt),
				),
			)
			.all())
		{
			written.add(row.id);
		}
	}
	return written;
}

/**
 * Keep the local value of every field whose outbox aspect is pending, in place on `nodes`, taking upstream's for the
 * rest. Returns the local order key of each node whose placement is pending: it keeps its parent and key, and takes no
 * part in mapping upstream's sibling order.
 */
function keepPendingFields(
	nodes: ProcessedNode[],
	pending: ReadonlyMap<string, ReadonlySet<OutboxAspect>>,
	existingContent: ReadonlyMap<string, NodeContentType>,
	existingMetadata: ReadonlyMap<string, NodeMetadataType>,
): Map<string, string | null>
{
	const pendingPlacement = new Map<string, string | null>();
	for (const node of nodes)
	{
		const aspects = pending.get(node.id);
		const content = existingContent.get(node.id);
		const metadata = existingMetadata.get(node.id);
		if (aspects === undefined || content === undefined || metadata === undefined)
		{
			continue;
		}
		if (aspects.has("name"))
		{
			node.name = content.name;
		}
		if (aspects.has("note"))
		{
			node.note = content.note;
		}
		if (aspects.has("completion"))
		{
			node.completedAt = metadata.completedAt === null ? null : Math.floor(metadata.completedAt.getTime() / 1000);
		}
		if (aspects.has("metadata"))
		{
			node.layoutMode = metadata.layoutMode;
		}
		if (aspects.has("placement"))
		{
			node.parentId = content.parentId;
			pendingPlacement.set(node.id, metadata.orderKey);
		}
	}
	return pendingPlacement;
}

function applyBatchIn(unitOfWork: UnitOfWork, state: ApiImportState, apiNodes: WorkflowyNode[]): void
{
	const {tx} = unitOfWork;
	let nodes = processNodes(state, apiNodes);
	if (state.snapshotAt !== undefined)
	{
		// The cache's later write wins: the node is left as it is and counts as seen.
		const later = writtenAfterSnapshot(
			tx,
			nodes.map((node) => node.id),
			state.snapshotAt,
		);
		for (const id of later)
		{
			state.seenIds.add(id);
		}
		state.totalNodes += later.size;
		state.nodesUnchanged += later.size;
		nodes = nodes.filter((node) => !later.has(node.id));
	}
	// A node with a pending create or delete is wholly ahead of workflowy.com: left as it is and counted as seen.
	const pending = pendingAspects(
		tx,
		nodes.map((node) => node.id),
	);
	const localWins = (id: string): boolean =>
	{
		const aspects = pending.get(id);
		return aspects !== undefined && (aspects.has("create") || aspects.has("delete"));
	};
	for (const node of nodes)
	{
		if (localWins(node.id))
		{
			state.seenIds.add(node.id);
			state.totalNodes++;
			state.nodesUnchanged++;
		}
	}
	nodes = nodes.filter((node) => !localWins(node.id));
	const ids = nodes.map((node) => node.id);

	// Classify against only this batch's current rows.
	const existingContent = new Map<string, NodeContentType>();
	const existingMetadata = new Map<string, NodeMetadataType>();
	for (let start = 0; start < ids.length; start += LOOKUP_CHUNK_SIZE)
	{
		const chunk = ids.slice(start, start + LOOKUP_CHUNK_SIZE);
		for (const row of tx
			.select()
			.from(nodeContent)
			.where(and(eq(nodeContent.systemTo, FAR_FUTURE_DATE), inArray(nodeContent.id, chunk)))
			.all())
		{
			existingContent.set(row.id, row);
		}
		for (const row of tx
			.select()
			.from(nodeMetadata)
			.where(and(eq(nodeMetadata.systemTo, FAR_FUTURE_DATE), inArray(nodeMetadata.nodeId, chunk)))
			.all())
		{
			existingMetadata.set(row.nodeId, row);
		}
	}
	const pendingPlacement = keepPendingFields(nodes, pending, existingContent, existingMetadata);
	const orderKeys: Map<string, string | null> = assignOrderKeys(
		state,
		nodes.filter((node) => !pendingPlacement.has(node.id)),
		existingContent,
		existingMetadata,
	);
	for (const [id, orderKey] of pendingPlacement)
	{
		orderKeys.set(id, orderKey);
	}
	for (const node of nodes)
	{
		const content = existingContent.get(node.id);
		const metadata = existingMetadata.get(node.id);
		const contentChanged = content && !contentMatches(content, node);
		const metadataChanged =
			metadata &&
			!metadataMatches(
				metadata,
				{
					...node,
					orderKey: orderKeys.get(node.id) ?? null,
				},
			);
		if (!content)
		{
			state.nodesAdded++;
		}
		else if (contentChanged || metadataChanged)
		{
			state.nodesUpdated++;
			if (contentChanged)
			{
				state.contentUpdated++;
			}
			if (metadataChanged)
			{
				state.metadataUpdated++;
			}
		}
		else
		{
			state.nodesUnchanged++;
		}
		state.seenIds.add(node.id);
	}
	state.totalNodes += nodes.length;

	const contentRows: NormalizedNodeContentRow[] = nodes.map((node) => (
	{
		id: node.id,
		name: node.name,
		note: node.note,
		parentId: node.parentId,
	}));
	const metadataRows: NormalizedNodeMetadataRow[] = nodes.map((node) => (
	{
		nodeId: node.id,
		shortId: node.shortId,
		orderKey: orderKeys.get(node.id) ?? null,
		createdAt: timestampToDate(node.createdAt),
		modifiedAt: timestampToDate(node.modifiedAt),
		completedAt: timestampToDate(node.completedAt),
		layoutMode: node.layoutMode,
	}));
	applyNodeRowsBatch(
		unitOfWork,
		{
			nodeContent: contentRows,
			nodeMetadata: metadataRows,
		},
	);
}

/**
 * Merge one batch of API nodes. Looks up existing rows by `id IN (...)` for
 * this batch only; nothing absent from the batch is touched.
 */
export function applyApiBatch(state: ApiImportState, apiNodes: WorkflowyNode[]): void
{
	runUnitOfWork(
		state.database,
		(unitOfWork) =>
		{
			applyBatchIn(unitOfWork, state, apiNodes);
		},
		state.start,
	);
}

function finishIn(unitOfWork: UnitOfWork, state: ApiImportState, treeItems?: InternalTreeItem[]): ImportApiResult
{
	const {tx} = unitOfWork;
	let unseen: string[] = [];
	for (const row of tx
		.select(
			{
				id: nodeContent.id,
			},
		)
		.from(nodeContent)
		.where(eq(nodeContent.systemTo, FAR_FUTURE_DATE))
		.all())
	{
		if (!state.seenIds.has(row.id) && !state.invalidIds.has(row.id))
		{
			unseen.push(row.id);
		}
	}
	if (state.snapshotAt !== undefined)
	{
		// A node the cache wrote after the snapshot is absent from it, not deleted.
		const later = writtenAfterSnapshot(tx, unseen, state.snapshotAt);
		unseen = unseen.filter((id) => !later.has(id));
	}
	// A node with any pending outbox row is ahead of the export: not there yet, or still under its old parent.
	const pending = pendingAspects(tx, unseen);
	unseen = unseen.filter((id) => !pending.has(id));
	endNodeComposites(unitOfWork, unseen);

	if (treeItems !== undefined)
	{
		const relationships: ItemRelationships = emptyItemRelationships();
		for (const item of treeItems)
		{
			collectItemRelationships(relationships, item.id, item.metadata);
		}
		const rowsByTable: NormalizedRowsByTable =
		{
			referencesRoots: relationships.referencesRoots.filter((row) => state.seenIds.has(row.nodeId)),
			aiMetadata: relationships.aiMetadata.filter((row) => state.seenIds.has(row.nodeId)),
		};
		applyRows(unitOfWork, rowsByTable, undefined);
		mergeItemRelationships(unitOfWork, relationships, state.seenIds);
	}
	endOrphanedParts(unitOfWork);
	if (treeItems !== undefined)
	{
		// Only the tree data carries backlinks, so only then can an item be judged stranded.
		endStrandedBacklinkItems(unitOfWork);
	}

	state.logger?.debug(`[IMPORT-API] Finished in ${Date.now() - state.startTime}ms`);
	return {
		totalNodes: state.totalNodes,
		nodesAdded: state.nodesAdded,
		nodesUpdated: state.nodesUpdated,
		nodesUnchanged: state.nodesUnchanged,
		nodesDeleted: unseen.length,
		nodesPhasedOut: unseen.length,
		contentUpdated: state.contentUpdated,
		metadataUpdated: state.metadataUpdated,
		priorityUpdated: 0,
		importTimestamp: state.importTimestamp,
	};
}

/**
 * Finish a batched import: end every node no batch mentioned (with its whole
 * composite), then merge the tree-derived relationships when given.
 */
export function finishApiImport(state: ApiImportState, treeItems?: InternalTreeItem[]): ImportApiResult
{
	if (state.validationErrors > 0)
	{
		state.logger?.warn(`Encountered ${state.validationErrors} validation errors during import`);
	}
	return runUnitOfWork(state.database, (unitOfWork) => finishIn(unitOfWork, state, treeItems), state.start);
}

/**
 * Import nodes from the Workflowy API export endpoint as one bulk unit of work:
 * atomic, under one system time (see {@link runBulkUnitOfWork}).
 *
 * The input is a flat list whose nodes already carry `parent_id`. The merge
 * runs through the same batch path as {@link applyApiBatch}, with a single batch.
 */
export function importFromApi(
	database: AppDatabase,
	apiNodes: WorkflowyNode[],
	options: ImportFromApiOptions = {},
): ImportApiResult
{
	let validationErrors = 0;
	const result = runBulkUnitOfWork(
		database,
		(unitOfWork, at) =>
		{
			const state = beginApiImport(
				database,
				{
					...options,
					timestamp: at,
				},
			);
			applyBatchIn(unitOfWork, state, apiNodes);
			const finished = finishIn(unitOfWork, state, options.treeItems);
			validationErrors = state.validationErrors;
			return finished;
		},
		options.timestamp,
	);
	metadataComparisonStats.log();
	if (validationErrors > 0)
	{
		options.logger?.warn(`Encountered ${validationErrors} validation errors during import`);
	}
	return result;
}
