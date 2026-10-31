import {fetchWorkflowyEpoch} from "@workflowy/shared/api";
import {backupImports, config, nodeContent, nodeMetadata} from "@workflowy/shared/db";
import type {NodeContentType, NodeMetadataType, AppDatabase} from "@workflowy/shared/db";
import {
	applyRows,
	collectItemRelationships,
	emptyItemRelationships,
	endOrphanedParts,
	mergeItemRelationships,
	startUnitOfWork,
	runUnitOfWork,
} from "@workflowy/shared/cache";
import type {
	TemporalTransaction,
	NormalizedAiMetadataRow,
	NormalizedCalendarLevelsRow,
	NormalizedCalendarMetadataRow,
	NormalizedChangesMetadataRow,
	NormalizedNodeContentRow,
	NormalizedNodeMetadataRow,
	NormalizedReferencesRootsRow,
	NormalizedS3FileRow,
} from "@workflowy/shared/cache";
import {BackupFileSchema, BackupNodeSchema} from "@workflowy/shared/schemas";
import type {BackupNode} from "@workflowy/shared/schemas";
import {FAR_FUTURE_DATE, formatTemporalTimestamp} from "@workflowy/shared/temporal";
import {backupToUnixTime, uuidToShortId} from "@workflowy/shared/workflowy";
import {eq, max} from "drizzle-orm";
import type {BetterSQLite3Database} from "drizzle-orm/better-sqlite3";
import {formatError, ZodError} from "zod";
import {readBackupFile} from "../utils/backup-archive.js";
import {parseStrictInteger} from "../utils/parse-strict-number.js";
import {contentMatches, metadataComparisonStats, metadataMatches, normalizeLayoutMode} from "./cache-temporal.js";
import {logger} from "./logger.js";
import {nonEmpty} from "../utils/non-empty.js";

// Config key for storing the user's Workflowy epoch
const WORKFLOWY_EPOCH_CONFIG_KEY = "workflowy_epoch";

// Backups write 0 for unknown image dimensions and timestamps.
function nonZeroOrNull(value: number | undefined): number | null {
	return value === undefined || value === 0 ? null : value;
}

function backupTimeOrNull(backupTime: number | undefined, workflowyEpoch: number): number | null {
	return backupTime === undefined || backupTime === 0 ? null : backupToUnixTime(backupTime, workflowyEpoch);
}

/**
 * Get the Workflowy epoch from environment variable or config table.
 * Throws if no epoch is configured and credentials are not available.
 *
 * Priority: WORKFLOWY_EPOCH env var > config table
 */
function getWorkflowyEpoch(tx: TemporalTransaction): number | null {
	// Check environment variable first
	const envEpoch = process.env.WORKFLOWY_EPOCH;
	const envParsed = envEpoch ? parseStrictInteger(envEpoch) : undefined;
	if (envParsed !== undefined) {
		return envParsed;
	}

	// Check config table
	try {
		const configRow = tx.select().from(config).where(eq(config.key, WORKFLOWY_EPOCH_CONFIG_KEY)).get();
		const parsed = configRow ? parseStrictInteger(configRow.value) : undefined;
		if (parsed !== undefined) {
			return parsed;
		}
	} catch {
		// Config table might not exist yet
	}

	return null;
}

/**
 * Store the Workflowy epoch in the config table.
 */
function setWorkflowyEpoch(tx: TemporalTransaction, epoch: number): void {
	const now = formatTemporalTimestamp(new Date());
	tx.insert(config)
		.values({
			key: WORKFLOWY_EPOCH_CONFIG_KEY,
			value: String(epoch),
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: config.key,
			set: {
				value: String(epoch),
				updatedAt: now,
			},
		})
		.run();
}

/**
 * Get or fetch the Workflowy epoch.
 * If not configured, attempts to fetch from Workflowy internal API using credentials.
 *
 * @param tx - Database transaction
 * @returns The epoch value
 * @throws Error if epoch is not configured and cannot be fetched
 */
async function getOrFetchWorkflowyEpoch(tx: TemporalTransaction): Promise<number> {
	// Check existing configuration first
	const existingEpoch = getWorkflowyEpoch(tx);
	if (existingEpoch !== null) {
		return existingEpoch;
	}

	// Try to fetch from Workflowy internal API
	const username = process.env.WORKFLOWY_USERNAME;
	const password = process.env.WORKFLOWY_PASSWORD;

	if (username && password) {
		logger.debug("Fetching Workflowy epoch from internal API...");
		const epoch = await fetchWorkflowyEpoch({username, password});
		setWorkflowyEpoch(tx, epoch);
		logger.debug(`Workflowy epoch fetched and stored: ${epoch}`);
		return epoch;
	}

	throw new Error(
		"Workflowy epoch not configured. Set WORKFLOWY_EPOCH env var, " +
			"or provide WORKFLOWY_USERNAME and WORKFLOWY_PASSWORD to fetch automatically.",
	);
}

/**
 * Convert a Unix timestamp (seconds) to a Date object.
 * Returns null if the input is null or undefined.
 */
function timestampToDate(timestamp: number | null | undefined): Date | null {
	return timestamp === null || timestamp === undefined ? null : new Date(timestamp * 1000);
}

interface KnownPriority {
	index: number;
	priority: number;
}

/**
 * Find the previous element with a non-null priority.
 */
function findPrevWithPriority(arr: (number | null)[], start: number): KnownPriority | null {
	for (let i = start - 1; i >= 0; i--) {
		const priority = arr[i];
		if (priority !== null && priority !== undefined) {
			return {index: i, priority};
		}
	}
	return null;
}

/**
 * Find the next element with a non-null priority.
 */
function findNextWithPriority(arr: (number | null)[], start: number): KnownPriority | null {
	for (let i = start + 1; i < arr.length; i++) {
		const priority = arr[i];
		if (priority !== null && priority !== undefined) {
			return {index: i, priority};
		}
	}
	return null;
}

/**
 * Calculate priorities for siblings, handling both new nodes and order changes.
 *
 * For NEW nodes (existingPriority is null): infer priority from neighbors.
 * For EXISTING nodes: check if ORDER changed. If order matches, keep existing priorities.
 * If order changed, recalculate using anchors (nodes whose relative position is stable).
 *
 * @param siblings - Array of {id, backupPosition, existingPriority} sorted by backupPosition
 * @returns Map of nodeId → priority (only for nodes that need updating)
 */
function calculatePriorities(
	siblings: {id: string; backupPosition: number; existingPriority: number | null}[],
): Map<string, number> {
	const result = new Map<string, number>();

	// Separate new nodes from existing nodes
	const existingNodes = siblings.flatMap((s) =>
		s.existingPriority === null ? [] : [{id: s.id, existingPriority: s.existingPriority}],
	);
	const newNodes = siblings.filter((s) => s.existingPriority === null);

	// If all nodes are new, assign priorities based on backup position
	if (existingNodes.length === 0) {
		for (const [i, sibling] of siblings.entries()) {
			result.set(sibling.id, i * 100);
		}
		return result;
	}

	// Check if order changed for existing nodes
	// Existing order: sort by priority, extract IDs
	const existingOrder = existingNodes.toSorted((a, b) => a.existingPriority - b.existingPriority).map((s) => s.id);
	// Backup order: already sorted by backupPosition, just extract IDs of existing nodes
	const backupOrderOfExisting = existingNodes.map((s) => s.id);

	const orderChanged = existingOrder.some((id, i) => id !== backupOrderOfExisting[i]);

	if (!orderChanged && newNodes.length === 0) {
		// Order unchanged, no new nodes - nothing to do
		return result;
	}

	// If order changed, anchor on the existing node furthest right in backup order
	// and space every sibling 100 apart from it.
	if (orderChanged) {
		const anchorIdx = siblings.findLastIndex((s) => s.existingPriority !== null);
		const anchorPriority = siblings[anchorIdx]?.existingPriority;

		if (anchorPriority !== null && anchorPriority !== undefined) {
			for (const [i, sibling] of siblings.entries()) {
				const priority = anchorPriority + (i - anchorIdx) * 100;
				if (sibling.existingPriority !== priority) {
					result.set(sibling.id, priority);
				}
			}
			return result;
		}
	}

	// Build working array of priorities (null means needs calculation)
	const priorities: (number | null)[] = siblings.map((s) => s.existingPriority);

	// Handle new nodes using middle-out algorithm (expand from known priorities)
	let changed = true;
	while (changed) {
		changed = false;
		for (const [i, sibling] of siblings.entries()) {
			if (priorities[i] !== null) {
				continue;
			}

			const prev = findPrevWithPriority(priorities, i);
			const next = findNextWithPriority(priorities, i);

			const adjacentToPrev = prev?.index === i - 1;
			const adjacentToNext = next?.index === i + 1;

			if (!adjacentToPrev && !adjacentToNext) {
				continue;
			}

			let newPriority: number;
			if (prev && next) {
				newPriority = Math.floor((prev.priority + next.priority) / 2);
			} else if (prev) {
				newPriority = prev.priority + 100;
			} else if (next) {
				newPriority = next.priority - 100;
			} else {
				continue;
			}

			priorities[i] = newPriority;
			result.set(sibling.id, newPriority);
			changed = true;
		}
	}

	return result;
}

/** Convert a cached timestamp column to Unix seconds, the unit backups use. */
function toUnixSeconds(value: Date | null): number | null {
	return value ? Math.floor(value.getTime() / 1000) : null;
}

/**
 * Stamp the import with a system time taken from the backup instead of the clock,
 * for replaying historical backups. See {@link resolveBackupSystemTime}.
 */
export interface BackupSystemTime {
	/** The date in the backup's filename. */
	backupDate: Date;
}

/** Hour (UTC) on the filename date used when a backup carries no timestamps. */
const BACKUP_FALLBACK_UTC_HOUR = 12;

/**
 * The system time for replaying a backup. A backup is a plain array of nodes
 * with no snapshot time of its own, so the best in-file evidence of when it was
 * taken is its high watermark: the newest createdAt/modifiedAt/completedAt.
 * The snapshot was taken at or after that instant. A backup with no timestamps
 * falls back to noon UTC on its filename date. Either way the stamp lands at
 * least 1 ms after the previous import's (`floor`), because a backup that only
 * deletes nodes keeps (or lowers) the watermark, and a unit must never close a
 * version stamped after itself.
 */
function resolveBackupSystemTime(incomingWatermarkMs: number | null, backupDate: Date, floor: string | null): Date {
	const fallback = Date.UTC(
		backupDate.getUTCFullYear(),
		backupDate.getUTCMonth(),
		backupDate.getUTCDate(),
		BACKUP_FALLBACK_UTC_HOUR,
	);
	const candidate = incomingWatermarkMs ?? fallback;
	const floorMs = floor === null ? null : Date.parse(`${floor.replace(" ", "T")}Z`);
	return new Date(floorMs === null || candidate > floorMs ? candidate : floorMs + 1);
}

/** The newest system_from among current backup_imports rows, or null when none. */
function latestBackupImportStamp(database: AppDatabase): string | null {
	const row = database
		.select({latest: max(backupImports.systemFrom)})
		.from(backupImports)
		.where(eq(backupImports.systemTo, FAR_FUTURE_DATE))
		.get();
	return row?.latest ?? null;
}

export interface ImportBackupResult {
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
	/** Nodes newer than the snapshot that were kept instead of being tombstoned. */
	nodesPreserved: number;
	skipped?: boolean;
	skipReason?: string;
	localWatermark?: string | null;
	incomingWatermark?: string | null;
}

/**
 * Import nodes from a Workflowy backup file.
 *
 * This follows an optimized compare-first pattern:
 * - Load: Load existing active rows into Maps for O(1) lookups
 * - Compare: Classify incoming data into groups:
 *   (a) Unchanged: existing rows that match incoming - DO NOTHING
 *   (b) Changed: existing rows with different values - phase out old, insert new
 *   (c) New only: incoming rows with no existing match - INSERT
 *   (d) Deleted: existing rows with no incoming match - phase out
 * - Execute: Only touch rows in groups b, c, d
 *
 * @param database Drizzle database instance
 * @param filePath Path to the backup JSON file
 * @param backupImportFilename Filename of the backup being imported
 * @param verbose Show detailed timing information
 * @param timestamp Override the import (system_from) timestamp, or derive it from the backup
 * @param force Bypass the stale-snapshot watermark guard
 */
export async function importBackup(
	database: AppDatabase,
	filePath: string,
	backupImportFilename: string,
	verbose = false,
	timestamp?: Date | BackupSystemTime,
	force = false,
): Promise<ImportBackupResult> {
	const startTime = Date.now();
	let lastTime = startTime;

	if (verbose) {
		logger.debug(`[IMPORT] Starting import with verbose=${verbose}`);
	}

	const logTiming = (phase: string) => {
		if (!verbose) {
			return;
		}
		const now = Date.now();
		const elapsed = now - lastTime;
		const total = now - startTime;
		logger.debug(`  [${phase}]: ${elapsed}ms (total: ${total}ms)`);
		lastTime = now;
	};

	const fileContent = readBackupFile(filePath);
	logTiming("Read file");

	const parsedJson: unknown = JSON.parse(fileContent);
	const rootNodes = BackupFileSchema.parse(parsedJson);
	logTiming(`Parse and validate JSON (${rootNodes.length} root nodes)`);

	const allNodes: {node: BackupNode; parentId: string | null; priority: number}[] = [];
	const collectNodes = (node: BackupNode, parentId: string | null, priority: number) => {
		allNodes.push({node, parentId, priority});
		if (node.ch && Array.isArray(node.ch)) {
			for (const [childIndex, child] of node.ch.entries()) {
				// Use raw index as backup position; actual priority is inferred later
				collectNodes(child, node.id, childIndex);
			}
		}
	};

	for (const [rootIndex, rootNode] of rootNodes.entries()) {
		// Use raw index as backup position; actual priority is inferred later
		collectNodes(rootNode, null, rootIndex);
	}
	logTiming(`Traverse tree (${allNodes.length} total nodes)`);

	// Get the Workflowy epoch (user-specific timestamp offset for backup files)
	// Priority: WORKFLOWY_EPOCH env var > config table > auto-fetch from internal API
	const workflowyEpoch = await getOrFetchWorkflowyEpoch(database);
	logTiming(`Using Workflowy epoch: ${workflowyEpoch}`);

	const nodesToProcess: {
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
	}[] = [];
	// Mirrors, backlinks, virtual roots and references roots, parsed by the shared item-metadata normalizer.
	const relationships = emptyItemRelationships();
	const aiMetadataRecords: {nodeId: string; inChat: number}[] = [];
	const s3FileRecords: {
		nodeId: string;
		fileName: string;
		fileType: string;
		objectFolder: string | null;
		isAnimatedGif: number | null;
		imageOriginalWidth: number | null;
		imageOriginalHeight: number | null;
		imageOriginalPixels: number | null;
		isDeleted: number | null;
	}[] = [];
	const changesMetadataRecords: {nodeId: string; ctBy: number}[] = [];
	const calendarMetadataRecords: {
		nodeId: string;
		root: number | null;
		level: string | null;
		value: string | null;
		dateId: number | null;
		timestamp: number | null;
		foundDates: number | null;
		dayPrefix: number | null;
	}[] = [];
	const calendarLevelsRecords: {
		nodeId: string;
		day: number | null;
		week: number | null;
		month: number | null;
		year: number | null;
	}[] = [];

	let validationErrors = 0;

	for (const {node, parentId, priority} of allNodes) {
		try {
			const validatedNode = BackupNodeSchema.parse(node);

			nodesToProcess.push({
				id: validatedNode.id,
				shortId: uuidToShortId(validatedNode.id),
				name: validatedNode.nm ?? "",
				note: nonEmpty(validatedNode.no) ?? null,
				parentId,
				priority,
				createdAt: backupTimeOrNull(validatedNode.ct, workflowyEpoch),
				modifiedAt: backupTimeOrNull(validatedNode.lm, workflowyEpoch),
				completedAt: backupTimeOrNull(validatedNode.cp, workflowyEpoch),
				layoutMode: normalizeLayoutMode(validatedNode.metadata.layoutMode),
			});

			collectItemRelationships(relationships, validatedNode.id, validatedNode.metadata);

			if (validatedNode.metadata.ai) {
				aiMetadataRecords.push({
					nodeId: validatedNode.id,
					inChat: validatedNode.metadata.ai.inChat ? 1 : 0,
				});
			}

			if (validatedNode.metadata.s3File) {
				s3FileRecords.push({
					nodeId: validatedNode.id,
					fileName: validatedNode.metadata.s3File.fileName,
					fileType: validatedNode.metadata.s3File.fileType,
					objectFolder: nonEmpty(validatedNode.metadata.s3File.objectFolder) ?? null,
					isAnimatedGif: validatedNode.metadata.s3File.isAnimatedGIF ? 1 : 0,
					imageOriginalWidth: nonZeroOrNull(validatedNode.metadata.s3File.imageOriginalWidth),
					imageOriginalHeight: nonZeroOrNull(validatedNode.metadata.s3File.imageOriginalHeight),
					imageOriginalPixels: nonZeroOrNull(validatedNode.metadata.s3File.imageOriginalPixels),
					isDeleted: validatedNode.metadata.s3File.isDeleted ? 1 : 0,
				});
			}

			if (validatedNode.metadata.changes?.ct) {
				changesMetadataRecords.push({
					nodeId: validatedNode.id,
					ctBy: validatedNode.metadata.changes.ct.by,
				});
			}

			if (validatedNode.metadata.calendar) {
				const cal = validatedNode.metadata.calendar;
				calendarMetadataRecords.push({
					nodeId: validatedNode.id,
					root: cal.root ? 1 : cal.root === false ? 0 : null,
					level: cal.level ?? null,
					value: cal.value ?? null,
					dateId: cal.dateId ?? null,
					timestamp: cal.timestamp ?? null,
					foundDates: cal.found_dates ? 1 : cal.found_dates === false ? 0 : null,
					dayPrefix: optionalBooleanToInt(cal.day_prefix),
				});
				if (cal.levels) {
					calendarLevelsRecords.push({
						nodeId: validatedNode.id,
						day: optionalBooleanToInt(cal.levels.day),
						week: optionalBooleanToInt(cal.levels.week),
						month: optionalBooleanToInt(cal.levels.month),
						year: optionalBooleanToInt(cal.levels.year),
					});
				}
			}
		} catch (error) {
			if (error instanceof ZodError) {
				validationErrors++;
				console.error(`Validation error for node ${node.id}:`);
				console.error(formatError(error));
				console.error("Node JSON:", JSON.stringify(node, null, 2));
			} else {
				throw error;
			}
		}
	}

	if (validationErrors > 0) {
		console.warn(`Encountered ${validationErrors} validation errors during import`);
	}

	logTiming(
		`Prepare data (${nodesToProcess.length} nodes, ${relationships.mirrors.length} mirrors, ${relationships.backlinks.length} backlinks)`,
	);

	// Guard against stale-snapshot data loss from the bulk-export endpoint.
	// The bulk-export API returns a snapshot taken at a point in time, and the
	// merge phase-out logic below tombstones anything absent from it — including
	// nodes written after the snapshot, which it cannot testify about. The
	// per-node REST API is always fresh and does not need this guard, so it lives
	// here in the bulk-export adapter only.
	//
	// Rather than refuse the whole import, protect only the nodes the snapshot
	// cannot speak for: those whose own createdAt/modifiedAt/completedAt is newer
	// than the snapshot's high watermark. Everything else merges normally, so an
	// older backup still contributes the fields only backups carry (attachments,
	// mirrors) without rolling back newer writes.
	//
	// Both watermarks are source content timestamps in Unix ms. Note that
	// node_content.systemFrom is a cache-write time, not a content time — using it
	// as the local watermark made every backup look stale forever, because
	// `cache import-api` stamps it with the wall clock on each daily run.
	let incomingMaxUnix = 0;
	for (const n of nodesToProcess) {
		if (n.createdAt !== null && n.createdAt > incomingMaxUnix) {
			incomingMaxUnix = n.createdAt;
		}
		if (n.modifiedAt !== null && n.modifiedAt > incomingMaxUnix) {
			incomingMaxUnix = n.modifiedAt;
		}
		if (n.completedAt !== null && n.completedAt > incomingMaxUnix) {
			incomingMaxUnix = n.completedAt;
		}
	}
	const incomingWatermarkMs = incomingMaxUnix === 0 ? null : incomingMaxUnix * 1000;
	const incomingWatermark: string | null =
		incomingWatermarkMs === null ? null : formatTemporalTimestamp(new Date(incomingWatermarkMs));

	// The protected id set is filled once existingMetadataMap is loaded, below.
	const protectedIds = new Set<string>();

	// Reset diagnostic counters before comparison phase
	metadataComparisonStats.reset();

	let nodesAdded = 0;
	let nodesUpdated = 0;
	let nodesUnchanged = 0;
	let nodesPhasedOut = 0;
	let nodesDeleted = 0;
	let contentUpdated = 0;
	let metadataUpdated = 0;
	let priorityUpdated = 0;

	// Load existing active rows for classification and priority calculation.
	// The actual phase-out/insert of the node-keyed tables is owned by the
	// shared importer's applyRows(); these reads only feed the stats and the
	// priority inference below.
	const existingContentMap = new Map<string, NodeContentType>();
	for (const content of database.select().from(nodeContent).where(eq(nodeContent.systemTo, FAR_FUTURE_DATE)).all()) {
		existingContentMap.set(content.id, content);
	}
	logTiming(`Loaded ${existingContentMap.size} existing content records into Map`);

	const existingMetadataMap = new Map<string, NodeMetadataType>();
	for (const metadata of database
		.select()
		.from(nodeMetadata)
		.where(eq(nodeMetadata.systemTo, FAR_FUTURE_DATE))
		.all()) {
		existingMetadataMap.set(metadata.nodeId, metadata);
	}
	logTiming(`Loaded ${existingMetadataMap.size} existing metadata records into Map`);

	// Newest content timestamp already in the cache, and the ids the incoming
	// snapshot predates. `force` waives the protection and imports the snapshot
	// verbatim, tombstoning anything it omits.
	let localMaxUnix = 0;
	for (const metadata of existingMetadataMap.values()) {
		for (const stamp of [metadata.createdAt, metadata.modifiedAt, metadata.completedAt]) {
			const unix = toUnixSeconds(stamp);
			if (unix !== null && unix > localMaxUnix) {
				localMaxUnix = unix;
			}
		}
	}
	const localWatermark: string | null =
		localMaxUnix === 0 ? null : formatTemporalTimestamp(new Date(localMaxUnix * 1000));

	if (!force && incomingMaxUnix > 0) {
		const backupNodeIds = new Set(nodesToProcess.map((n) => n.id));
		for (const [nodeId, metadata] of existingMetadataMap) {
			if (backupNodeIds.has(nodeId)) {
				continue;
			}
			const newest = Math.max(
				toUnixSeconds(metadata.createdAt) ?? 0,
				toUnixSeconds(metadata.modifiedAt) ?? 0,
				toUnixSeconds(metadata.completedAt) ?? 0,
			);
			if (newest > incomingMaxUnix) {
				protectedIds.add(nodeId);
			}
		}
	}
	logTiming(`Protected ${protectedIds.size} nodes newer than the snapshot`);

	// resolvedPriorities is populated by the classification block below and read
	// when building the node_metadata rows.
	const resolvedPriorities = new Map<string, number>();
	let orphanIds: string[] = [];

	{
		// Compute orphan IDs in memory (existing nodes not in backup)
		// This is fail-safe: empty orphan set = nothing closed
		// (vs the old approach where empty backup set = everything closed)
		const backupNodeIds = new Set(nodesToProcess.map((n) => n.id));
		orphanIds = [...existingContentMap.keys()].filter((id) => !backupNodeIds.has(id) && !protectedIds.has(id));

		// Sanity check: if backup has far fewer nodes than DB, something is wrong
		if (nodesToProcess.length < existingContentMap.size * 0.5 && existingContentMap.size > 1000) {
			throw new Error(
				`Backup has only ${nodesToProcess.length} nodes but DB has ${existingContentMap.size}. ` +
					`This looks like a corrupted or partial backup. Aborting to prevent data loss.`,
			);
		}
		logTiming(`Found ${orphanIds.length} orphaned nodes to close`);

		// Build set of incoming node IDs for deletion detection
		const incomingNodeIds = new Set<string>();
		for (const nodeData of nodesToProcess) {
			incomingNodeIds.add(nodeData.id);
		}

		// Build sibling map and infer priorities for new nodes
		// Group nodes by parent with their backup position (tree traversal order)
		const siblingsByParent = new Map<
			string | null,
			{
				id: string;
				backupPosition: number;
				existingPriority: number | null;
			}[]
		>();

		for (const nodeData of nodesToProcess) {
			const existing = existingMetadataMap.get(nodeData.id);
			const siblings = siblingsByParent.get(nodeData.parentId) ?? [];
			siblings.push({
				id: nodeData.id,
				backupPosition: nodeData.priority,
				existingPriority: existing?.priority ?? null,
			});
			siblingsByParent.set(nodeData.parentId, siblings);
		}

		// Sort and calculate priorities for each parent's children
		// Handles new nodes AND order changes for existing nodes
		const calculatedPriorities = new Map<string, number>();
		for (const siblings of siblingsByParent.values()) {
			siblings.sort((a, b) => a.backupPosition - b.backupPosition);
			const calculated = calculatePriorities(siblings);
			for (const [id, priority] of calculated) {
				calculatedPriorities.set(id, priority);
			}
		}
		logTiming(`Calculated priorities for ${calculatedPriorities.size} nodes`);

		// Classify nodes for node-level stats and resolve each node's final priority.
		// (a) Unchanged - no DB operations
		// (b) Changed - phase out old, insert new
		// (c) New - insert only
		// (d) Deleted - phase out only (handled by temporalMerge's absence detection)
		//
		// resolvedPriorities holds the priority each node should be stored with;
		// the metadata merge below reads it instead of nodeData.priority (which is
		// only the backup-tree position, not the inferred priority).
		for (const nodeData of nodesToProcess) {
			const existingContent = existingContentMap.get(nodeData.id);
			const existingMetadata = existingMetadataMap.get(nodeData.id);

			const isNew = !existingContent;
			let contentChanged = false;
			let metadataChanged = false;

			if (!existingContent) {
				contentChanged = true;
			} else if (!contentMatches(existingContent, nodeData)) {
				contentUpdated++;
				contentChanged = true;
			}

			// For new nodes: use calculated priority.
			// For existing nodes: check if order changed (priority recalculated) or other metadata changed.
			const newPriority = calculatedPriorities.get(nodeData.id);
			const priorityChanged =
				newPriority !== undefined && existingMetadata && newPriority !== existingMetadata.priority;

			if (existingMetadata) {
				resolvedPriorities.set(nodeData.id, newPriority ?? existingMetadata.priority ?? nodeData.priority);
				if (
					priorityChanged ||
					!metadataMatches(existingMetadata, {
						...nodeData,
						// For backup imports, compare against existing priority, not tree position
						// (priority is calculated separately, not derived from nodeData.priority).
						priority: existingMetadata.priority,
					})
				) {
					if (priorityChanged) {
						priorityUpdated++;
					} else {
						metadataUpdated++;
					}
					metadataChanged = true;
				}
			} else {
				resolvedPriorities.set(nodeData.id, newPriority ?? nodeData.priority);
				metadataChanged = true;
			}

			if (isNew) {
				nodesAdded++;
			} else if (contentChanged || metadataChanged) {
				nodesUpdated++;
			} else {
				nodesUnchanged++;
			}
		}

		// Deleted nodes: existing but not in incoming (counted for stats; the
		// temporal-merge engine phases them out via absence detection).
		for (const existingId of existingContentMap.keys()) {
			if (!incomingNodeIds.has(existingId)) {
				nodesPhasedOut++;
			}
		}

		logTiming(
			`Classified: ${nodesAdded} new, ${nodesUpdated} changed, ${nodesUnchanged} unchanged, ${nodesPhasedOut} deleted`,
		);

		// Log diagnostic stats to identify which metadata field is causing mismatches
		metadataComparisonStats.log();
	}

	// Normalize the bulk-export tree into the shared in-DB row shape, then hand
	// the node-keyed temporal tables to the shared importer. applyRows() owns the
	// temporal merge and FK-correct insertion order for these tables. The
	// composite-key tables (mirrors, backlinks, virtual_root_ids) are merged
	// separately below, in the same unit of work — they are not node-keyed and
	// applyRows() does not yet support their multi-column natural keys.
	const nodeContentRows: NormalizedNodeContentRow[] = nodesToProcess.map((node) => ({
		id: node.id,
		name: node.name,
		note: node.note,
		parentId: node.parentId,
	}));
	const nodeMetadataRows: NormalizedNodeMetadataRow[] = nodesToProcess.map((node) => ({
		nodeId: node.id,
		shortId: node.shortId,
		priority: resolvedPriorities.get(node.id) ?? node.priority,
		createdAt: timestampToDate(node.createdAt),
		modifiedAt: timestampToDate(node.modifiedAt),
		completedAt: timestampToDate(node.completedAt),
		layoutMode: node.layoutMode,
	}));
	const calendarMetadataRows: NormalizedCalendarMetadataRow[] = calendarMetadataRecords;
	const calendarLevelsRows: NormalizedCalendarLevelsRow[] = calendarLevelsRecords;
	const aiMetadataRows: NormalizedAiMetadataRow[] = aiMetadataRecords;
	const s3FileRows: NormalizedS3FileRow[] = s3FileRecords;
	const changesMetadataRows: NormalizedChangesMetadataRow[] = changesMetadataRecords;
	const referencesRootsRows: NormalizedReferencesRootsRow[] = relationships.referencesRoots;

	// The timeout counts from here, after the parse, so only the merge itself is timed.
	const stamp =
		timestamp === undefined || timestamp instanceof Date
			? timestamp
			: resolveBackupSystemTime(incomingWatermarkMs, timestamp.backupDate, latestBackupImportStamp(database));
	const unitStart = startUnitOfWork(stamp);
	const importTimestamp = stamp ?? new Date(unitStart.startedAt);
	// One unit of work: the node-keyed merge, the relationship merges and the
	// orphan sweep commit together at the import time, or not at all.
	runUnitOfWork(
		database,
		(unitOfWork) => {
			const merged = applyRows(
				unitOfWork,
				{
					nodeContent: nodeContentRows,
					nodeMetadata: nodeMetadataRows,
					calendarMetadata: calendarMetadataRows,
					calendarLevels: calendarLevelsRows,
					aiMetadata: aiMetadataRows,
					s3Files: s3FileRows,
					changesMetadata: changesMetadataRows,
					referencesRoots: referencesRootsRows,
				},
				protectedIds,
			);
			logTiming(
				`Merged node-keyed tables: ${merged.nodeContent?.inserted ?? 0} content, ` +
					`${merged.nodeMetadata?.inserted ?? 0} metadata`,
			);
			logTiming(`Content updates: ${contentUpdated}, Metadata updates: ${metadataUpdated}`);

			// Merge mirrors, backlinks and virtual root ids globally: a full backup is the
			// complete desired state. Mirror pairs need both nodes live in this import.
			const liveNodeIds = new Set([...nodesToProcess.map((n) => n.id), ...protectedIds]);
			const relationshipResult = mergeItemRelationships(unitOfWork, relationships, liveNodeIds);
			logTiming(
				`Processed relationships: mirrors +${relationshipResult.mirrors.inserted}/-${relationshipResult.mirrors.phasedOut}, ` +
					`backlinks +${relationshipResult.backlinks.inserted}/-${relationshipResult.backlinks.phasedOut}, ` +
					`virtual root ids +${relationshipResult.virtualRootIds.inserted}/-${relationshipResult.virtualRootIds.phasedOut}`,
			);

			// End every owned row whose node is no longer current: the nodes deleted in
			// Workflowy (absent from this backup) take their whole composite with them.
			// applyRows() already closed their node-keyed rows; this sweep covers the
			// rest (mirrors, backlinks, virtual root ids, embeddings, ...).
			endOrphanedParts(unitOfWork);
			nodesDeleted = orphanIds.length;

			logTiming(`Closed ${nodesDeleted} orphaned nodes (deleted from Workflowy)`);
		},
		unitStart,
	);

	logTiming("Transaction complete");

	return {
		totalNodes: nodesToProcess.length,
		nodesAdded,
		nodesUpdated,
		nodesUnchanged,
		nodesDeleted,
		nodesPhasedOut,
		contentUpdated,
		metadataUpdated,
		priorityUpdated,
		importTimestamp,
		nodesPreserved: protectedIds.size,
		skipped: false,
		localWatermark,
		incomingWatermark,
	};
}

// Record lookups on the backup schema type as `boolean`, but absent keys must stay null.
function optionalBooleanToInt(value: boolean | undefined): 0 | 1 | null {
	if (value === undefined) {
		return null;
	}
	return value ? 1 : 0;
}
