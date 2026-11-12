import {eq} from "drizzle-orm";
import type {SQL} from "drizzle-orm";
import type {AnySQLiteColumn} from "drizzle-orm/sqlite-core";
import {FAR_FUTURE_DATE} from "../temporal/constants.js";

/**
 * Drizzle predicate selecting the current (open) temporal version of a row:
 * `systemTo = FAR_FUTURE_DATE`. Centralizes the "current version" filter that
 * would otherwise be open-coded at every temporal query.
 */
export function currentVersion(table: {systemTo: AnySQLiteColumn}): SQL
{
	return eq(table.systemTo, FAR_FUTURE_DATE);
}

/**
 * Convert systemFrom ISO8601 string to Date.
 * systemFrom is stored as 'YYYY-MM-DD HH:MM:SS' (UTC).
 */
export function systemFromToDate(systemFrom: string): Date
{
	return new Date(`${systemFrom.replace(" ", "T")}Z`);
}

/**
 * Normalize layoutMode values for consistent storage and comparison.
 * 'bullets' is the default, stored as null to save space.
 */
export function normalizeLayoutMode(layoutMode: string | null | undefined): string | null
{
	if (layoutMode === "bullets")
	{
		return null;
	}
	return layoutMode ?? null;
}

/**
 * Check if content fields match (affects embeddings).
 * Used to determine if a new node_content temporal version is needed.
 */
export function contentMatches(
	existing:
	{
		name: string | null;
		note: string | null;
		parentId: string | null;
	},
	newData:
	{
		name: string | null;
		note: string | null;
		parentId: string | null;
	},
): boolean
{
	return existing.name === newData.name && existing.note === newData.note && existing.parentId === newData.parentId;
}

/**
 * Convert a Date to a Unix timestamp (seconds since epoch).
 */
function dateToTimestamp(date: Date | null): number | null
{
	return date ? Math.floor(date.getTime() / 1000) : null;
}

// Diagnostic counters for debugging metadata comparison mismatches
export const metadataComparisonStats =
{
	createdAtMismatch: 0,
	completedAtMismatch: 0,
	layoutModeMismatch: 0,
	priorityMismatch: 0,
	total: 0,
	diffCounts: new Map<number, number>(), // Track frequency of each diff value
	reset()
	{
		this.createdAtMismatch = 0;
		this.completedAtMismatch = 0;
		this.layoutModeMismatch = 0;
		this.priorityMismatch = 0;
		this.total = 0;
		this.diffCounts = new Map();
	},
	log()
	{
		if (this.total > 0)
		{
			console.log(
				`[metadataMatches] Mismatches: ` +
					`createdAt=${this.createdAtMismatch}, ` +
					`completedAt=${this.completedAtMismatch}, ` +
					`layoutMode=${this.layoutModeMismatch}, ` +
					`priority=${this.priorityMismatch} ` +
					`(total comparisons: ${this.total})`,
			);
			if (this.diffCounts.size > 0)
			{
				console.log(`[createdAt diff distribution]:`);
				const sortedDiffs = [...this.diffCounts.entries()].toSorted((a, b) => b[1] - a[1]);
				for (const [diff, count] of sortedDiffs.slice(0, 10))
				{
					console.log(`  diff=${diff}: ${count} occurrences`);
				}
			}
		}
	},
};

/**
 * Compare timestamps with 1-second tolerance.
 *
 * Workflowy backup and API data have an inherent off-by-one inconsistency affecting
 * ~25% of nodes randomly. This appears to be caused by floating-point rounding at
 * second boundaries when nodes were created. Since there's no pattern to predict
 * which nodes are affected, we tolerate ±1 second differences.
 */
function timestampsMatch(a: number | null, b: number | null): boolean
{
	if (a === null && b === null)
	{
		return true;
	}
	if (a === null || b === null)
	{
		return false;
	}
	return Math.abs(a - b) <= 1;
}

/** The timestamp fields of a node_metadata row, as Drizzle reads and writes them. */
interface MetadataTimestamps
{
	createdAt?: Date | null;
	modifiedAt?: Date | null;
	completedAt?: Date | null;
}

/** The existing value when the incoming one is within the one-second skew of it, else the incoming value. */
function keepWithinSkew(existing: Date | null | undefined, incoming: Date | null | undefined): Date | null | undefined
{
	if (existing === null || existing === undefined || incoming === null || incoming === undefined)
	{
		return incoming;
	}
	return timestampsMatch(dateToTimestamp(existing), dateToTimestamp(incoming)) ? existing : incoming;
}

/**
 * Carry the existing createdAt / modifiedAt / completedAt into a new node_metadata
 * version wherever the incoming value is within one second of it.
 *
 * REST (nodes-export) rounds Workflowy's fractional times up and the internal API
 * and backup round them down, so the sources disagree by one second on about a
 * quarter of timestamps. {@link metadataMatches} already ignores that skew when
 * deciding whether to open a version; this keeps a version opened for a real change
 * (priority, completion, layout) from also rewriting the timestamps to the other
 * source's rounding, so history never records a one-second edit that never happened.
 */
export function keepSkewedTimestamps<T extends MetadataTimestamps>(existing: MetadataTimestamps, incoming: T): T
{
	return {
		...incoming,
		createdAt: keepWithinSkew(existing.createdAt, incoming.createdAt),
		modifiedAt: keepWithinSkew(existing.modifiedAt, incoming.modifiedAt),
		completedAt: keepWithinSkew(existing.completedAt, incoming.completedAt),
	};
}

/**
 * Check if metadata fields match (does NOT affect embeddings).
 * Used to determine if a new node_metadata temporal version is needed.
 * Excludes modifiedAt from comparison — it changes frequently for container nodes
 * when any descendant changes, creating temporal versions with no semantic value.
 * Uses ±1 second tolerance for timestamp comparisons due to Workflowy rounding.
 * Handles Date objects from Drizzle by converting them to timestamps for comparison.
 */
export function metadataMatches(
	existing:
	{
		priority: number | null;
		createdAt: Date | null;
		modifiedAt: Date | null;
		completedAt: Date | null;
		layoutMode: string | null;
	},
	newData:
	{
		priority: number | null;
		createdAt: number | null;
		modifiedAt: number | null;
		completedAt: number | null;
		layoutMode: string | null;
	},
): boolean
{
	const existingCreatedAt = dateToTimestamp(existing.createdAt);
	const existingCompletedAt = dateToTimestamp(existing.completedAt);

	const createdAtMatch = timestampsMatch(existingCreatedAt, newData.createdAt);
	const completedAtMatch = timestampsMatch(existingCompletedAt, newData.completedAt);
	const layoutModeMatch = existing.layoutMode === newData.layoutMode;
	const priorityMatch = existing.priority === newData.priority;

	metadataComparisonStats.total++;
	if (!createdAtMatch)
	{
		metadataComparisonStats.createdAtMismatch++;
		if (existingCreatedAt !== null && newData.createdAt !== null)
		{
			const diff = newData.createdAt - existingCreatedAt;
			const count = metadataComparisonStats.diffCounts.get(diff) ?? 0;
			metadataComparisonStats.diffCounts.set(diff, count + 1);
		}
	}
	if (!completedAtMatch)
	{
		metadataComparisonStats.completedAtMismatch++;
	}
	if (!layoutModeMatch)
	{
		metadataComparisonStats.layoutModeMismatch++;
	}
	if (!priorityMatch)
	{
		metadataComparisonStats.priorityMismatch++;
	}

	return createdAtMatch && completedAtMatch && layoutModeMatch && priorityMatch;
}
