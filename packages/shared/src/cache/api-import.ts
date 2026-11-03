import {and, eq, inArray, isNull} from "drizzle-orm";
import type {InternalTreeItem} from "../api/workflowy-internal-client.js";
import {nodeContent, nodeMetadata} from "../db/schema.js";
import type {NodeContentType, NodeMetadataType} from "../db/schema.js";
import type {AppDatabase} from "../db/types.js";
import {FAR_FUTURE_DATE} from "../temporal/index.js";
import {WorkflowyNodeSchema} from "../types/index.js";
import type {WorkflowyNode} from "../types/index.js";
import {uuidToShortId} from "../workflowy/index.js";
import {contentMatches, metadataComparisonStats, metadataMatches, normalizeLayoutMode} from "./cache-temporal.js";
import {applyNodeRowsBatch, applyRows} from "./importer.js";
import type {NormalizedRowsByTable} from "./importer.js";
import {collectItemRelationships, emptyItemRelationships, mergeItemRelationships} from "./item-relationships.js";
import type {ItemRelationships} from "./item-relationships.js";
import {endNodeComposites, endOrphanedParts, runUnitOfWork} from "./node-composite.js";
import {endStrandedBacklinkItems} from "./stranded-relationships.js";
import type {UnitOfWork} from "./node-composite.js";
import type {NormalizedNodeContentRow, NormalizedNodeMetadataRow} from "./normalized-rows.js";
import {startUnitOfWork} from "./system-time.js";
import type {UnitOfWorkStart} from "./system-time.js";

/** Bound-parameter chunk for `id IN (...)` lookups; Durable Object SQLite caps a statement at 100. */
const LOOKUP_CHUNK_SIZE = 90;

/** The logging the import needs; the host decides where it goes. */
export interface ImportLogger {
	debug(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

export interface ImportApiResult {
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

export interface ImportFromApiOptions {
	logger?: ImportLogger;
	timestamp?: Date;
	/**
	 * A full `/get_tree_data/` read. The public API carries no mirrors or
	 * references roots; when given, those merge from its item
	 * metadata in the same unit of work. Without it their rows are left untouched.
	 */
	treeItems?: InternalTreeItem[];
}

interface ProcessedNode {
	id: string;
	shortId: string;
	name: string;
	note: string | null;
	parentId: string | null;
	priority: number;
	createdAt: number | null;
	modifiedAt: number | null;
	completedAt: number | null;
	layoutMode: string | null;
}

/** Progress of one batched import. Opaque to callers; pass it between the three calls. */
export interface ApiImportState {
	readonly database: AppDatabase;
	readonly logger: ImportLogger | undefined;
	readonly importTimestamp: Date;
	/** The import's system time and start; the transaction timeout counts from it. */
	readonly start: UnitOfWorkStart;
	readonly seenIds: Set<string>;
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

function timestampToDate(timestamp: number | null | undefined): Date | null {
	return timestamp === null || timestamp === undefined ? null : new Date(timestamp * 1000);
}

function nonEmpty(value: string | null | undefined): string | undefined {
	return value === "" || value === null ? undefined : value;
}

function processNodes(state: ApiImportState, apiNodes: WorkflowyNode[]): ProcessedNode[] {
	const processed: ProcessedNode[] = [];
	for (const node of apiNodes) {
		const parsed = WorkflowyNodeSchema.safeParse(node);
		if (!parsed.success) {
			state.validationErrors++;
			state.logger?.error(
				`Validation error for node ${node.id}: ${parsed.error.message}\nNode JSON: ${JSON.stringify(node, null, 2)}`,
			);
			continue;
		}
		const validated = parsed.data;
		processed.push({
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
		});
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
	options: {logger?: ImportLogger; timestamp?: Date} = {},
): ApiImportState {
	const start = startUnitOfWork(options.timestamp);
	const startTime = start.startedAt;
	options.logger?.debug("[IMPORT-API] Starting import");
	metadataComparisonStats.reset();
	return {
		database,
		logger: options.logger,
		importTimestamp: options.timestamp ?? new Date(start.startedAt),
		start,
		seenIds: new Set(),
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

/** The ids ordered by priority, ties by id, as one comparable string. */
function siblingOrder(items: {id: string; priority: number}[]): string {
	return items
		.toSorted((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
		.map((item) => item.id)
		.join("\n");
}

/**
 * Keep each parent's stored sibling numbers when the incoming ones only renumber
 * the same order.
 *
 * REST numbers siblings 0,1,2 while backup imports space them 100 apart, so
 * importing one over the other would open a node_metadata version per sibling
 * with no change to the order. When a batch carries every current child of a
 * parent, all of them already known, and their order by priority is unchanged,
 * the stored priorities replace the incoming ones. A new, removed or reordered
 * sibling takes the incoming numbers as before.
 */
function keepEquivalentPriorities(
	tx: UnitOfWork["tx"],
	nodes: ProcessedNode[],
	existingMetadata: Map<string, NodeMetadataType>,
): void {
	const incomingByParent = new Map<string | null, ProcessedNode[]>();
	for (const node of nodes) {
		const siblings = incomingByParent.get(node.parentId) ?? [];
		siblings.push(node);
		incomingByParent.set(node.parentId, siblings);
	}

	const currentChildren = new Map<string | null, Set<string>>();
	const addChildren = (rows: {id: string; parentId: string | null}[]) => {
		for (const row of rows) {
			const children = currentChildren.get(row.parentId) ?? new Set<string>();
			children.add(row.id);
			currentChildren.set(row.parentId, children);
		}
	};
	const parentIds = [...incomingByParent.keys()].filter((parentId) => parentId !== null);
	for (let start = 0; start < parentIds.length; start += LOOKUP_CHUNK_SIZE) {
		addChildren(
			tx
				.select({id: nodeContent.id, parentId: nodeContent.parentId})
				.from(nodeContent)
				.where(
					and(
						eq(nodeContent.systemTo, FAR_FUTURE_DATE),
						inArray(nodeContent.parentId, parentIds.slice(start, start + LOOKUP_CHUNK_SIZE)),
					),
				)
				.all(),
		);
	}
	if (incomingByParent.has(null)) {
		addChildren(
			tx
				.select({id: nodeContent.id, parentId: nodeContent.parentId})
				.from(nodeContent)
				.where(and(eq(nodeContent.systemTo, FAR_FUTURE_DATE), isNull(nodeContent.parentId)))
				.all(),
		);
	}

	for (const [parentId, siblings] of incomingByParent) {
		const current = currentChildren.get(parentId) ?? new Set<string>();
		if (siblings.length !== current.size || siblings.some((node) => !current.has(node.id))) {
			continue;
		}
		const stored = siblings.map((node) => ({id: node.id, priority: existingMetadata.get(node.id)?.priority}));
		const known = stored.flatMap((item) =>
			item.priority === null || item.priority === undefined ? [] : [{...item, priority: item.priority}],
		);
		if (
			known.length !== siblings.length ||
			siblingOrder(known) !== siblingOrder(siblings.map((node) => ({id: node.id, priority: node.priority})))
		) {
			continue;
		}
		for (const item of known) {
			const node = siblings.find((sibling) => sibling.id === item.id);
			if (node) {
				node.priority = item.priority;
			}
		}
	}
}

function applyBatchIn(unitOfWork: UnitOfWork, state: ApiImportState, apiNodes: WorkflowyNode[]): void {
	const nodes = processNodes(state, apiNodes);
	const {tx} = unitOfWork;
	const ids = nodes.map((node) => node.id);

	// Classify against only this batch's current rows.
	const existingContent = new Map<string, NodeContentType>();
	const existingMetadata = new Map<string, NodeMetadataType>();
	for (let start = 0; start < ids.length; start += LOOKUP_CHUNK_SIZE) {
		const chunk = ids.slice(start, start + LOOKUP_CHUNK_SIZE);
		for (const row of tx
			.select()
			.from(nodeContent)
			.where(and(eq(nodeContent.systemTo, FAR_FUTURE_DATE), inArray(nodeContent.id, chunk)))
			.all()) {
			existingContent.set(row.id, row);
		}
		for (const row of tx
			.select()
			.from(nodeMetadata)
			.where(and(eq(nodeMetadata.systemTo, FAR_FUTURE_DATE), inArray(nodeMetadata.nodeId, chunk)))
			.all()) {
			existingMetadata.set(row.nodeId, row);
		}
	}
	keepEquivalentPriorities(tx, nodes, existingMetadata);
	for (const node of nodes) {
		const content = existingContent.get(node.id);
		const metadata = existingMetadata.get(node.id);
		const contentChanged = content && !contentMatches(content, node);
		const metadataChanged = metadata && !metadataMatches(metadata, node);
		if (!content) {
			state.nodesAdded++;
		} else if (contentChanged || metadataChanged) {
			state.nodesUpdated++;
			if (contentChanged) {
				state.contentUpdated++;
			}
			if (metadataChanged) {
				state.metadataUpdated++;
			}
		} else {
			state.nodesUnchanged++;
		}
		state.seenIds.add(node.id);
	}
	state.totalNodes += nodes.length;

	const contentRows: NormalizedNodeContentRow[] = nodes.map((node) => ({
		id: node.id,
		name: node.name,
		note: node.note,
		parentId: node.parentId,
	}));
	const metadataRows: NormalizedNodeMetadataRow[] = nodes.map((node) => ({
		nodeId: node.id,
		shortId: node.shortId,
		priority: node.priority,
		createdAt: timestampToDate(node.createdAt),
		modifiedAt: timestampToDate(node.modifiedAt),
		completedAt: timestampToDate(node.completedAt),
		layoutMode: node.layoutMode,
	}));
	applyNodeRowsBatch(unitOfWork, {nodeContent: contentRows, nodeMetadata: metadataRows});
}

/**
 * Merge one batch of API nodes. Looks up existing rows by `id IN (...)` for
 * this batch only; nothing absent from the batch is touched.
 */
export function applyApiBatch(state: ApiImportState, apiNodes: WorkflowyNode[]): void {
	runUnitOfWork(
		state.database,
		(unitOfWork) => {
			applyBatchIn(unitOfWork, state, apiNodes);
		},
		state.start,
	);
}

function finishIn(unitOfWork: UnitOfWork, state: ApiImportState, treeItems?: InternalTreeItem[]): ImportApiResult {
	const {tx} = unitOfWork;
	const unseen: string[] = [];
	for (const row of tx
		.select({id: nodeContent.id})
		.from(nodeContent)
		.where(eq(nodeContent.systemTo, FAR_FUTURE_DATE))
		.all()) {
		if (!state.seenIds.has(row.id)) {
			unseen.push(row.id);
		}
	}
	endNodeComposites(unitOfWork, unseen);

	if (treeItems !== undefined) {
		const relationships: ItemRelationships = emptyItemRelationships();
		for (const item of treeItems) {
			collectItemRelationships(relationships, item.id, item.metadata);
		}
		const rowsByTable: NormalizedRowsByTable = {
			referencesRoots: relationships.referencesRoots.filter((row) => state.seenIds.has(row.nodeId)),
		};
		applyRows(unitOfWork, rowsByTable, undefined);
		mergeItemRelationships(unitOfWork, relationships, state.seenIds);
	}
	endOrphanedParts(unitOfWork);
	if (treeItems !== undefined) {
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
export function finishApiImport(state: ApiImportState, treeItems?: InternalTreeItem[]): ImportApiResult {
	if (state.validationErrors > 0) {
		state.logger?.warn(`Encountered ${state.validationErrors} validation errors during import`);
	}
	return runUnitOfWork(state.database, (unitOfWork) => finishIn(unitOfWork, state, treeItems), state.start);
}

/**
 * Import nodes from the Workflowy API export endpoint in one unit of work.
 *
 * The input is a flat list whose nodes already carry `parent_id`. The merge
 * runs through the same batch path as {@link applyApiBatch}, with a single batch.
 */
export function importFromApi(
	database: AppDatabase,
	apiNodes: WorkflowyNode[],
	options: ImportFromApiOptions = {},
): ImportApiResult {
	const state = beginApiImport(database, options);
	const result = runUnitOfWork(
		database,
		(unitOfWork) => {
			applyBatchIn(unitOfWork, state, apiNodes);
			return finishIn(unitOfWork, state, options.treeItems);
		},
		state.start,
	);
	metadataComparisonStats.log();
	if (state.validationErrors > 0) {
		state.logger?.warn(`Encountered ${state.validationErrors} validation errors during import`);
	}
	return result;
}
