import {WorkflowyInternalClient} from "@outlinedb/shared/api";
import {readInternalAuth} from "@outlinedb/shared/node";
import {backupImports, nodeContent, nodeMetadata} from "@outlinedb/shared/db";
import type {NodeContentType, NodeMetadataType, AppDatabase} from "@outlinedb/shared/db";
import
{
	applyRows,
	calendarRows,
	collectItemRelationships,
	emptyItemRelationships,
	endNodeComposites,
	endOrphanedParts,
	endStrandedBacklinkItems,
	mergeItemRelationships,
	orderKeysFor,
	readWorkflowyEpoch,
	runBulkUnitOfWork,
	runUnitOfWork,
	s3FileRow,
	seedAccount,
} from "@outlinedb/shared/cache";
import type
{
	ItemRelationships,
	TemporalTransaction,
	NormalizedAiMetadataRow,
	NormalizedCalendarLevelsRow,
	NormalizedCalendarMetadataRow,
	NormalizedChangesMetadataRow,
	NormalizedNodeContentRow,
	NormalizedNodeMetadataRow,
	NormalizedReferencesRootsRow,
	NormalizedS3FileRow,
} from "@outlinedb/shared/cache";
import {BackupFileSchema} from "@outlinedb/shared/schemas";
import type {BackupNode} from "@outlinedb/shared/schemas";
import {FAR_FUTURE_DATE, formatTemporalTimestamp, parseTemporalTimestamp} from "@outlinedb/shared/temporal";
import {backupToUnixTime, uuidToShortId} from "@outlinedb/shared/workflowy";
import {and, eq, gt, max, ne} from "drizzle-orm";
import type {BetterSQLite3Database} from "drizzle-orm/better-sqlite3";
import {readBackupFile} from "../utils/backup-archive.js";
import {parseStrictInteger} from "../utils/parse-strict-number.js";
import {contentMatches, metadataComparisonStats, metadataMatches, normalizeLayoutMode} from "./cache-temporal.js";
import {logger} from "./logger.js";
import {nonEmpty} from "../utils/non-empty.js";

function backupTimeOrNull(backupTime: number | undefined, workflowyEpoch: number): number | null
{
	return backupTime === undefined || backupTime === 0 ? null : backupToUnixTime(backupTime, workflowyEpoch);
}

/**
 * The Workflowy epoch: the WORKFLOWY_EPOCH env var, else the live account row's join date.
 */
function getWorkflowyEpoch(tx: TemporalTransaction): number | undefined
{
	const envEpoch = process.env.WORKFLOWY_EPOCH;
	const envParsed = envEpoch ? parseStrictInteger(envEpoch) : undefined;
	return envParsed ?? readWorkflowyEpoch(tx);
}

/**
 * Get the Workflowy epoch, or, without one, fetch the account from the internal API and seed its row.
 *
 * @throws Error if no epoch is known and no session cookie is saved
 */
async function getOrFetchWorkflowyEpoch(tx: TemporalTransaction): Promise<number>
{
	const existingEpoch = getWorkflowyEpoch(tx);
	if (existingEpoch !== undefined)
	{
		return existingEpoch;
	}

	const auth = readInternalAuth();
	if (auth)
	{
		logger.debug("Fetching the Workflowy account (its join date is the epoch) from the internal API...");
		const session = await new WorkflowyInternalClient(auth).bootstrap();
		runUnitOfWork(tx, (unitOfWork) =>
		{
			seedAccount(
				unitOfWork,
				{
					userId: String(session.userId),
					dateJoinedSec: session.dateJoinedSec,
					...(session.fullName === undefined
						? {}
						:
							{
								fullName: session.fullName,
							}),
					...(session.entropyKey === undefined
						? {}
						:
							{
								entropyKey: session.entropyKey,
							}),
				},
			);
		});
		logger.debug(`Workflowy epoch fetched and stored on the account row: ${session.dateJoinedSec}`);
		return session.dateJoinedSec;
	}

	throw new Error(
		"Workflowy epoch not configured. Set WORKFLOWY_EPOCH env var, run cache:import-account, " +
			"or run './bin/run.js internal login' to fetch automatically.",
	);
}

/**
 * Convert a Unix timestamp (seconds) to a Date object.
 * Returns null if the input is null or undefined.
 */
function timestampToDate(timestamp: number | null | undefined): Date | null
{
	return timestamp === null || timestamp === undefined ? null : new Date(timestamp * 1000);
}

/** Convert a cached timestamp column to Unix seconds, the unit backups use. */
function toUnixSeconds(value: Date | null): number | null
{
	return value ? Math.floor(value.getTime() / 1000) : null;
}

/** A backup node's newest content timestamp in Unix seconds, or 0 when it has none. */
function newestUnix(node: {createdAt: number | null; modifiedAt: number | null; completedAt: number | null}): number
{
	return Math.max(node.createdAt ?? 0, node.modifiedAt ?? 0, node.completedAt ?? 0);
}

/** A cached node's newest content timestamp in Unix seconds, or 0 when it has none or is not cached. */
function newestCachedUnix(metadata: NodeMetadataType | undefined): number
{
	if (metadata === undefined)
	{
		return 0;
	}
	return Math.max(
		toUnixSeconds(metadata.createdAt) ?? 0,
		toUnixSeconds(metadata.modifiedAt) ?? 0,
		toUnixSeconds(metadata.completedAt) ?? 0,
	);
}

/**
 * Stamp the import with a system time taken from the backup instead of the clock,
 * for replaying historical backups. See {@link resolveBackupSystemTime}.
 */
export interface BackupSystemTime
{
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
function resolveBackupSystemTime(incomingWatermarkMs: number | null, backupDate: Date, floor: number | null): Date
{
	const fallback = Date.UTC(
		backupDate.getUTCFullYear(),
		backupDate.getUTCMonth(),
		backupDate.getUTCDate(),
		BACKUP_FALLBACK_UTC_HOUR,
	);
	const candidate = incomingWatermarkMs ?? fallback;
	const floorMs = floor === null ? null : parseTemporalTimestamp(floor).getTime();
	return new Date(floorMs === null || candidate > floorMs ? candidate : floorMs + 1);
}

/** The newest system_from among current backup_imports rows, or null when none. */
function latestBackupImportStamp(database: AppDatabase): number | null
{
	const row = database
		.select(
			{
				latest: max(backupImports.systemFrom),
			},
		)
		.from(backupImports)
		.where(eq(backupImports.systemTo, FAR_FUTURE_DATE))
		.get();
	return row?.latest ?? null;
}

/** Ids with a node_content version closed after `systemTime`. */
function closedSince(database: AppDatabase, systemTime: number): Set<string>
{
	const rows = database
		.selectDistinct(
			{
				id: nodeContent.id,
			},
		)
		.from(nodeContent)
		.where(and(gt(nodeContent.systemTo, systemTime), ne(nodeContent.systemTo, FAR_FUTURE_DATE)))
		.all();
	return new Set(rows.map((row) => row.id));
}

/**
 * The backup's backlink items with no live original: children of a references
 * root whose every mirror row names a node neither in the backup nor
 * protected. The final unit's endStrandedBacklinkItems() still ends any the
 * cache's own rows strand.
 */
function strandedBacklinkItems(
	nodes: readonly
	{
		id: string;
		parentId: string | null;
	}[],
	relationships: ItemRelationships,
	protectedIds: ReadonlySet<string>,
): Set<string>
{
	const liveIds = new Set([...nodes.map((node) => node.id), ...protectedIds]);
	const referencesRootIds = new Set(relationships.referencesRoots.map((row) => row.nodeId));
	const withLiveOriginal = new Set(
		relationships.mirrors.filter((row) => liveIds.has(row.originalId)).map((row) => row.mirrorId),
	);
	return new Set(
		nodes
			.filter(
				(node) =>
					node.parentId !== null && referencesRootIds.has(node.parentId) && !withLiveOriginal.has(node.id),
			)
			.map((node) => node.id),
	);
}

/** Remove, in place, the rows `keep` rejects. */
function retainWhere<T>(rows: T[], keep: (row: T) => boolean): void
{
	let kept = 0;
	for (const row of rows)
	{
		if (keep(row))
		{
			rows[kept++] = row;
		}
	}
	rows.length = kept;
}

export interface ImportBackupResult
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
	/** Nodes newer than the snapshot that were kept instead of being tombstoned or reverted. */
	nodesPreserved: number;
	/** Nodes in the snapshot that the cache deleted after it was taken, left deleted instead of re-added. */
	nodesKeptDeleted: number;
	skipped?: boolean;
	skipReason?: string;
	localWatermark?: number | null;
	incomingWatermark?: number | null;
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
): Promise<ImportBackupResult>
{
	const startTime = Date.now();
	let lastTime = startTime;

	if (verbose)
	{
		logger.debug(`[IMPORT] Starting import with verbose=${verbose}`);
	}

	const logTiming = (phase: string) =>
	{
		if (!verbose)
		{
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

	const allNodes:
	{
		node: BackupNode;
		parentId: string | null;
		position: number;
	}[] = [];
	const collectNodes = (node: BackupNode, parentId: string | null, position: number) =>
	{
		allNodes.push(
			{
				node,
				parentId,
				position,
			},
		);
		if (node.ch && Array.isArray(node.ch))
		{
			for (const [childIndex, child] of node.ch.entries())
			{
				// The index among its siblings; order keys are mapped from it later
				collectNodes(child, node.id, childIndex);
			}
		}
	};

	for (const [rootIndex, rootNode] of rootNodes.entries())
	{
		// The index among its siblings; order keys are mapped from it later
		collectNodes(rootNode, null, rootIndex);
	}
	logTiming(`Traverse tree (${allNodes.length} total nodes)`);

	// Get the Workflowy epoch (user-specific timestamp offset for backup files)
	// Priority: WORKFLOWY_EPOCH env var > account.date_joined_sec > auto-fetch from internal API
	const workflowyEpoch = await getOrFetchWorkflowyEpoch(database);
	logTiming(`Using Workflowy epoch: ${workflowyEpoch}`);

	const nodesToProcess:
	{
		id: string;
		shortId: string;
		name: string;
		note: string | null;
		parentId: string | null;
		position: number;
		createdAt: number | null;
		modifiedAt: number | null;
		completedAt: number | null;
		layoutMode: string | null;
	}[] = [];
	// Mirrors (backlink items included) and references roots, parsed by the shared item-metadata normalizer.
	const relationships = emptyItemRelationships();
	const s3FileRecords: NormalizedS3FileRow[] = [];
	const changesMetadataRecords:
	{
		nodeId: string;
		ctBy: number;
	}[] = [];
	const calendarMetadataRecords: NormalizedCalendarMetadataRow[] = [];
	const calendarLevelsRecords: NormalizedCalendarLevelsRow[] = [];

	// BackupFileSchema.parse above validated the whole tree: one invalid node aborts
	// the import, so no node is dropped here and then closed as deleted.
	for (const {node: validatedNode, parentId, position} of allNodes)
	{
		nodesToProcess.push(
			{
				id: validatedNode.id,
				shortId: uuidToShortId(validatedNode.id),
				name: validatedNode.nm ?? "",
				note: nonEmpty(validatedNode.no) ?? null,
				parentId,
				position,
				createdAt: backupTimeOrNull(validatedNode.ct, workflowyEpoch),
				modifiedAt: backupTimeOrNull(validatedNode.lm, workflowyEpoch),
				completedAt: backupTimeOrNull(validatedNode.cp, workflowyEpoch),
				layoutMode: normalizeLayoutMode(validatedNode.metadata.layoutMode),
			},
		);

		collectItemRelationships(relationships, validatedNode.id, validatedNode.metadata);

		if (validatedNode.metadata.s3File)
		{
			s3FileRecords.push(s3FileRow(validatedNode.id, validatedNode.metadata.s3File));
		}

		if (validatedNode.metadata.changes?.ct)
		{
			changesMetadataRecords.push(
				{
					nodeId: validatedNode.id,
					ctBy: validatedNode.metadata.changes.ct.by,
				},
			);
		}

		if (validatedNode.metadata.calendar)
		{
			const rows = calendarRows(validatedNode.id, validatedNode.metadata.calendar);
			calendarMetadataRecords.push(rows.calendarMetadata);
			if (rows.calendarLevels !== undefined)
			{
				calendarLevelsRecords.push(rows.calendarLevels);
			}
		}
	}

	logTiming(`Prepare data (${nodesToProcess.length} nodes, ${relationships.mirrors.length} mirrors)`);

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
	for (const n of nodesToProcess)
	{
		incomingMaxUnix = Math.max(incomingMaxUnix, newestUnix(n));
	}
	const incomingWatermarkMs = incomingMaxUnix === 0 ? null : incomingMaxUnix * 1000;
	const incomingWatermark: number | null =
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

	// Load existing active rows for classification and order-key mapping.
	// The actual phase-out/insert of the node-keyed tables is owned by the
	// shared importer's applyRows(); these reads only feed the stats and the
	// order-key mapping below.
	const existingContentMap = new Map<string, NodeContentType>();
	for (const content of database.select().from(nodeContent).where(eq(nodeContent.systemTo, FAR_FUTURE_DATE)).all())
	{
		existingContentMap.set(content.id, content);
	}
	logTiming(`Loaded ${existingContentMap.size} existing content records into Map`);

	const existingMetadataMap = new Map<string, NodeMetadataType>();
	for (const metadata of database
		.select()
		.from(nodeMetadata)
		.where(eq(nodeMetadata.systemTo, FAR_FUTURE_DATE))
		.all())
	{
		existingMetadataMap.set(metadata.nodeId, metadata);
	}
	logTiming(`Loaded ${existingMetadataMap.size} existing metadata records into Map`);

	// Newest content timestamp already in the cache, and the ids the incoming
	// snapshot predates. `force` waives the protection and imports the snapshot
	// verbatim, tombstoning anything it omits.
	let localMaxUnix = 0;
	for (const metadata of existingMetadataMap.values())
	{
		localMaxUnix = Math.max(localMaxUnix, newestCachedUnix(metadata));
	}
	const localWatermark: number | null =
		localMaxUnix === 0 ? null : formatTemporalTimestamp(new Date(localMaxUnix * 1000));

	if (!force && incomingMaxUnix > 0)
	{
		const backupNodeIds = new Set(nodesToProcess.map((n) => n.id));
		for (const [nodeId, metadata] of existingMetadataMap)
		{
			if (backupNodeIds.has(nodeId))
			{
				continue;
			}
			if (newestCachedUnix(metadata) > incomingMaxUnix)
			{
				protectedIds.add(nodeId);
			}
		}
	}
	logTiming(`Protected ${protectedIds.size} nodes newer than the snapshot`);

	// The other half of the stale-snapshot guard: a node the cache deleted after
	// the snapshot's watermark was still alive when the snapshot was taken, so
	// the snapshot cannot testify that it survives. Re-adding it would only make
	// the next `cache import-api` delete it again. A deletion stamped at or
	// before the watermark predates the snapshot, so a node the snapshot still
	// holds was restored and is re-added.
	const keptDeletedIds = new Set<string>();
	if (!force && incomingWatermark !== null)
	{
		const deletedAfterSnapshot = closedSince(database, incomingWatermark);
		for (const node of nodesToProcess)
		{
			if (deletedAfterSnapshot.has(node.id) && !existingContentMap.has(node.id))
			{
				keptDeletedIds.add(node.id);
			}
		}
	}
	const dropNodes = (ids: ReadonlySet<string>) =>
	{
		if (ids.size === 0)
		{
			return;
		}
		const isKept = (row: {nodeId: string}) => !ids.has(row.nodeId);
		retainWhere(nodesToProcess, (node) => !ids.has(node.id));
		retainWhere(relationships.aiMetadata, isKept);
		retainWhere(s3FileRecords, isKept);
		retainWhere(changesMetadataRecords, isKept);
		retainWhere(calendarMetadataRecords, isKept);
		retainWhere(calendarLevelsRecords, isKept);
		retainWhere(relationships.referencesRoots, isKept);
	};
	dropNodes(keptDeletedIds);
	logTiming(`Left ${keptDeletedIds.size} nodes the cache deleted after the snapshot deleted`);

	// The same guard for nodes the snapshot does hold. When the cache's content
	// is newer than the snapshot, a version the cache wrote after the snapshot's
	// watermark is newer than the snapshot's version of that node, unless the
	// node's own timestamps say the snapshot saw a later edit. A move leaves
	// those timestamps alone, so only the write time shows it.
	if (!force && incomingWatermark !== null && incomingMaxUnix < localMaxUnix)
	{
		const newerIds = new Set<string>();
		for (const node of nodesToProcess)
		{
			const content = existingContentMap.get(node.id);
			const metadata = existingMetadataMap.get(node.id);
			const writtenAfterSnapshot =
				(content !== undefined && content.systemFrom > incomingWatermark) ||
				(metadata !== undefined && metadata.systemFrom > incomingWatermark);
			if (writtenAfterSnapshot && newestUnix(node) <= newestCachedUnix(metadata))
			{
				newerIds.add(node.id);
				protectedIds.add(node.id);
			}
		}
		dropNodes(newerIds);
		logTiming(`Kept ${newerIds.size} nodes the cache wrote after the snapshot`);
	}

	// Upstream has no backlink item without its source. The node chunks commit
	// before the final unit can end one, so leave it out up front rather than
	// write a version that the final unit closes on every import.
	const strandedIds = strandedBacklinkItems(nodesToProcess, relationships, protectedIds);
	dropNodes(strandedIds);
	logTiming(`Left out ${strandedIds.size} backlink items whose source is absent`);

	// resolvedOrderKeys is populated by the classification block below and read
	// when building the node_metadata rows.
	const resolvedOrderKeys = new Map<string, string | null>();
	let orphanIds: string[] = [];

	{
		// Compute orphan IDs in memory (existing nodes not in backup)
		// This is fail-safe: empty orphan set = nothing closed
		// (vs the old approach where empty backup set = everything closed)
		const backupNodeIds = new Set(nodesToProcess.map((n) => n.id));
		orphanIds = [...existingContentMap.keys()].filter((id) => !backupNodeIds.has(id) && !protectedIds.has(id));

		// Sanity check: if backup has far fewer nodes than DB, something is wrong
		if (nodesToProcess.length < existingContentMap.size * 0.5 && existingContentMap.size > 1000)
		{
			throw new Error(
				`Backup has only ${nodesToProcess.length} nodes but DB has ${existingContentMap.size}. ` +
					`This looks like a corrupted or partial backup. Aborting to prevent data loss.`,
			);
		}
		logTiming(`Found ${orphanIds.length} orphaned nodes to close`);

		// Build set of incoming node IDs for deletion detection
		const incomingNodeIds = new Set<string>();
		for (const nodeData of nodesToProcess)
		{
			incomingNodeIds.add(nodeData.id);
		}

		// Map each parent's children, in backup order, onto order keys: a sibling already under that parent keeps its
		// key while the order around it holds, and a new, moved or reordered one gets a key between its neighbours.
		const siblingsByParent = new Map<string | null, typeof nodesToProcess>();
		for (const nodeData of nodesToProcess)
		{
			const siblings = siblingsByParent.get(nodeData.parentId) ?? [];
			siblings.push(nodeData);
			siblingsByParent.set(nodeData.parentId, siblings);
		}
		const changedOrderKeys = new Map<string, string>();
		for (const [parentId, siblings] of siblingsByParent)
		{
			const changed = orderKeysFor(
				siblings
					.toSorted((a, b) => a.position - b.position)
					.map((sibling) => (
					{
						id: sibling.id,
						orderKey:
							existingContentMap.get(sibling.id)?.parentId === parentId
								? existingMetadataMap.get(sibling.id)?.orderKey
								: undefined,
					})),
			);
			for (const [id, orderKey] of changed)
			{
				changedOrderKeys.set(id, orderKey);
			}
		}
		logTiming(`Mapped order keys for ${changedOrderKeys.size} nodes`);

		// Classify nodes for node-level stats and resolve each node's final order key.
		// (a) Unchanged - no DB operations
		// (b) Changed - phase out old, insert new
		// (c) New - insert only
		// (d) Deleted - phase out only (handled by temporalMerge's absence detection)
		for (const nodeData of nodesToProcess)
		{
			const existingContent = existingContentMap.get(nodeData.id);
			const existingMetadata = existingMetadataMap.get(nodeData.id);

			const isNew = !existingContent;
			let contentChanged = false;
			let metadataChanged = false;

			if (!existingContent)
			{
				contentChanged = true;
			}
			else if (!contentMatches(existingContent, nodeData))
			{
				contentUpdated++;
				contentChanged = true;
			}

			const newOrderKey = changedOrderKeys.get(nodeData.id);
			const orderKey = newOrderKey ?? existingMetadata?.orderKey ?? null;
			resolvedOrderKeys.set(nodeData.id, orderKey);
			if (existingMetadata)
			{
				const orderKeyChanged = newOrderKey !== undefined && newOrderKey !== existingMetadata.orderKey;
				if (
					orderKeyChanged ||
					!metadataMatches(
						existingMetadata,
						{
							...nodeData,
							orderKey: existingMetadata.orderKey,
						},
					)
				)
				{
					if (orderKeyChanged)
					{
						priorityUpdated++;
					}
					else
					{
						metadataUpdated++;
					}
					metadataChanged = true;
				}
			}
			else
			{
				metadataChanged = true;
			}

			if (isNew)
			{
				nodesAdded++;
			}
			else if (contentChanged || metadataChanged)
			{
				nodesUpdated++;
			}
			else
			{
				nodesUnchanged++;
			}
		}

		// Deleted nodes: existing but not in incoming (counted for stats; the
		// temporal-merge engine phases them out via absence detection).
		for (const existingId of existingContentMap.keys())
		{
			if (!incomingNodeIds.has(existingId))
			{
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
	// temporal merge and FK-correct insertion order for these tables; scoped to
	// the backup's ids, it leaves protected nodes alone.
	const nodeContentRows: NormalizedNodeContentRow[] = nodesToProcess.map((node) => (
	{
		id: node.id,
		name: node.name,
		note: node.note,
		parentId: node.parentId,
	}));
	const nodeMetadataRows: NormalizedNodeMetadataRow[] = nodesToProcess.map((node) => (
	{
		nodeId: node.id,
		shortId: node.shortId,
		orderKey: resolvedOrderKeys.get(node.id) ?? null,
		createdAt: timestampToDate(node.createdAt),
		modifiedAt: timestampToDate(node.modifiedAt),
		completedAt: timestampToDate(node.completedAt),
		layoutMode: node.layoutMode,
	}));
	// Each import is one bulk unit: atomic and under one system time, so a backup
	// never shows in history as several partial states. Its timeout counts from
	// the unit's lease, after the parse, so only the merge itself is timed.
	const stamp =
		timestamp === undefined || timestamp instanceof Date
			? timestamp
			: resolveBackupSystemTime(incomingWatermarkMs, timestamp.backupDate, latestBackupImportStamp(database));
	const importTimestamp = runBulkUnitOfWork(
		database,
		(unitOfWork, at) =>
		{
			const merged = applyRows(
				unitOfWork,
				{
					nodeContent: nodeContentRows,
					nodeMetadata: nodeMetadataRows,
					calendarMetadata: calendarMetadataRecords,
					calendarLevels: calendarLevelsRecords,
					aiMetadata: relationships.aiMetadata,
					s3Files: s3FileRecords,
					changesMetadata: changesMetadataRecords,
					referencesRoots: relationships.referencesRoots,
				},
				undefined,
				nodeContentRows.map((row) => row.id),
			);
			logTiming(
				`Merged node-keyed tables: ${merged.nodeContent?.inserted ?? 0} content, ${merged.nodeMetadata?.inserted ?? 0} metadata`,
			);
			logTiming(`Content updates: ${contentUpdated}, Metadata updates: ${metadataUpdated}`);

			// Nodes deleted in Workflowy (absent from this backup) take their whole composite with them.
			endNodeComposites(unitOfWork, orphanIds);
			nodesDeleted = orphanIds.length;
			logTiming(`Closed ${nodesDeleted} orphaned nodes (deleted from Workflowy)`);

			// Merge mirrors globally: a full backup is the
			// complete desired state. Mirror pairs need both nodes live in this import.
			const liveNodeIds = new Set([...nodesToProcess.map((n) => n.id), ...protectedIds]);
			const relationshipResult = mergeItemRelationships(unitOfWork, relationships, liveNodeIds);
			logTiming(
				`Processed relationships: mirrors +${relationshipResult.mirrors.inserted}/-${relationshipResult.mirrors.phasedOut}`,
			);

			// End every owned row whose node is no longer current (mirrors, embeddings, ...).
			endOrphanedParts(unitOfWork);
			// Upstream has no backlink item without its source; one in the backup is dropped.
			endStrandedBacklinkItems(unitOfWork);
			return at;
		},
		stamp,
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
		nodesKeptDeleted: keptDeletedIds.size,
		skipped: false,
		localWatermark,
		incomingWatermark,
	};
}
