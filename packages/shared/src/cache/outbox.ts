import {and} from "drizzle-orm";
import {outbox} from "../db/schema.js";
import {FAR_FUTURE_DATE} from "../temporal/constants.js";
import {currentVersion} from "./cache-temporal.js";
import {inIds} from "./in-ids.js";
import type {UnitOfWork} from "./node-composite.js";
import type {TemporalTransaction} from "./temporal-merge.js";

/** The parts of a node a mirror-mode write can leave ahead of workflowy.com. */
export const OUTBOX_ASPECTS = [
	"create",
	"name",
	"note",
	"placement",
	"completion",
	"metadata",
	"mirror",
	"delete",
] as const;

export type OutboxAspect = (typeof OUTBOX_ASPECTS)[number];

/** Durable Object SQLite caps a statement at 100 bound parameters; an outbox row binds 6. */
const ROWS_PER_INSERT = 15;

export interface OutboxEntry
{
	nodeId: string;
	aspect: OutboxAspect;
}

/**
 * Records which aspects of which nodes a unit of work left ahead of workflowy.com, as current `outbox` rows in that
 * same unit of work. An aspect that already has a current row keeps it, so a burst of edits coalesces into one row
 * whose `enqueued_at` is the first pending write. `entries` must not repeat a node and aspect.
 */
export class OutboxRecorder
{
	record({tx, systemTime}: UnitOfWork, entries: readonly OutboxEntry[]): void
	{
		if (entries.length === 0)
		{
			return;
		}
		const current = pendingAspects(tx, [...new Set(entries.map(({nodeId}) => nodeId))]);
		const rows = entries
			.filter(({nodeId, aspect}) => current.get(nodeId)?.has(aspect) !== true)
			.map(({nodeId, aspect}) => (
			{
				nodeId,
				aspect,
				enqueuedAt: systemTime,
				lastError: null,
				systemFrom: systemTime,
				systemTo: FAR_FUTURE_DATE,
			}));
		for (let start = 0; start < rows.length; start += ROWS_PER_INSERT)
		{
			tx.insert(outbox)
				.values(rows.slice(start, start + ROWS_PER_INSERT))
				.run();
		}
	}
}

/** The pending (current) outbox aspects of each of `nodeIds` that has any, in one set-based read. */
export function pendingAspects(tx: TemporalTransaction, nodeIds: readonly string[]): Map<string, Set<OutboxAspect>>
{
	const pending = new Map<string, Set<OutboxAspect>>();
	if (nodeIds.length === 0)
	{
		return pending;
	}
	const rows = tx
		.select(
			{
				nodeId: outbox.nodeId,
				aspect: outbox.aspect,
			},
		)
		.from(outbox)
		.where(and(inIds(outbox.nodeId, nodeIds), currentVersion(outbox)))
		.all();
	for (const {nodeId, aspect} of rows)
	{
		let aspects = pending.get(nodeId);
		if (aspects === undefined)
		{
			aspects = new Set();
			pending.set(nodeId, aspects);
		}
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the recorder writes only OutboxAspect values
		aspects.add(aspect as OutboxAspect);
	}
	return pending;
}
