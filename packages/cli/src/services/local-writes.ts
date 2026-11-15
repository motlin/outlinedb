import type {Command} from "@oclif/core";
import {findInbox, LocalTreeWriter, OutboxRecorder, outboxStatus, planSubtreeDelete} from "@outlinedb/shared/cache";
import type {DeletePlan, OutboxStatus, WorkflowyWriteThroughClient} from "@outlinedb/shared/cache";
import type {WorkflowyInternalAdapter} from "@outlinedb/shared/internal";
import {LocalCalendar} from "@outlinedb/shared/local-calendar";
import {internalAdapter} from "@outlinedb/shared/node";
import {isSystemTarget} from "@outlinedb/shared/types";
import type {createDatabase} from "../db/index.js";
import type {CacheService} from "./cache.js";

type Database = ReturnType<typeof createDatabase>;

const INTERNAL_AUTH_REQUIRED =
	"Writing needs the internal API to deliver the write to workflowy.com: set WORKFLOWY_USERNAME and WORKFLOWY_PASSWORD (e.g. from .envrc), or run 'internal login'.";

/**
 * A CLI write in mirror mode: the local writer records outbox rows in each unit of work, and the internal adapter
 * delivers them to workflowy.com when the command drains.
 */
export interface LocalWrites
{
	database: Database;
	local: LocalTreeWriter;
	adapter: WorkflowyInternalAdapter;
}

/**
 * The local writer and the drain's adapter, from the internal session credentials the Node host reads. Throws without
 * them, before anything is written: local-only nodes would never reach workflowy.com.
 */
export function openLocalWrites(database: Database, writeThrough: WorkflowyWriteThroughClient): LocalWrites
{
	const adapter = internalAdapter(database, writeThrough);
	if (adapter === undefined)
	{
		throw new Error(INTERNAL_AUTH_REQUIRED);
	}
	return {
		database,
		local: new LocalTreeWriter(
			database,
			{
				outbox: new OutboxRecorder(),
			},
		),
		adapter,
	};
}

/**
 * The 📆 Calendar writer of `writes`: day nodes and layouts go into the local tables with outbox rows, while the
 * account state they read (entropy key, root metadata) comes from the adapter. A missing calendar root is an error,
 * never a second root.
 */
export function localCalendar(writes: LocalWrites): LocalCalendar
{
	return new LocalCalendar(
		writes.database,
		{
			outbox: new OutboxRecorder(),
			account: writes.adapter,
			createRoot: false,
		},
	);
}

/**
 * Drain passes until nothing is pending. Each pass carries the oldest pending rows, so a pass that leaves the pending
 * count where it was stops the loop rather than sending the same rows again. A failed pass throws, its rows pending.
 */
async function drainPending({database, adapter}: LocalWrites): Promise<OutboxStatus>
{
	let status = outboxStatus(database);
	while (status.pending > 0)
	{
		// oxlint-disable-next-line no-await-in-loop -- each pass reads the rows the previous one left
		await adapter.drainOutbox();
		const after = outboxStatus(database);
		if (after.pending >= status.pending)
		{
			return after;
		}
		status = after;
	}
	return status;
}

/**
 * Deliver the pending outbox: one drain. A failed drain keeps the local writes and their pending rows, prints how many
 * are pending and why, and exits non-zero.
 */
export async function drainAfterWrite(command: Command, writes: LocalWrites): Promise<void>
{
	let failure: string;
	try
	{
		const {pending} = await drainPending(writes);
		if (pending === 0)
		{
			return;
		}
		failure = "a drain pass delivered none of the pending rows";
	}
	catch (error)
	{
		failure = error instanceof Error ? error.message : String(error);
	}
	const {pending} = outboxStatus(writes.database);
	command.error(
		`Saved locally, but delivering it to workflowy.com failed: ${failure}\n` +
			`${pending} outbox row${pending === 1 ? "" : "s"} pending; they go out on the next write or with 'outbox drain'.`,
		{
			exit: 1,
		},
	);
}

/** A resolved parent as a local node id: a system target (`inbox`) becomes the node it names. */
export function localParent(database: Database, parentId: string | null): string | null
{
	if (parentId === null || !isSystemTarget(parentId))
	{
		return parentId;
	}
	const inbox = findInbox(database);
	if (inbox === undefined)
	{
		throw new Error(`No ${parentId} node in the cache; run cache import-api first`);
	}
	return inbox.id;
}

/**
 * How deleting `id` removes it, planned from the cache: a mirror goes alone, and an original whose mirror lives on
 * outside the deleted part takes that mirror's slot.
 */
export async function localDeletePlan(cache: CacheService, id: string): Promise<DeletePlan>
{
	if (cache.getMirrorOriginal(id) !== null)
	{
		return {
			mirrorIds: [id],
			promotions: [],
			nodeId: null,
		};
	}
	return planSubtreeDelete(cache, id, async (parentId) =>
		Promise.resolve(cache.getChildren(parentId).map((child) => child.id)),
	);
}

/**
 * The node at a comma-separated path, creating each missing segment (a missing first one at Home) at the bottom of its
 * parent, like `mkdir -p`.
 */
export function resolveOrCreateLocalPath(path: string, cache: CacheService, local: LocalTreeWriter): string
{
	let current: string | null = null;
	for (const part of path.split(",").map((segment) => segment.trim()))
	{
		current =
			cache.getChildByName(current, part)?.id ??
			local.createAt(
				{
					parentId: current,
					name: part,
				},
			).id;
	}
	if (current === null)
	{
		throw new Error(`Failed to resolve or create path: ${path}`);
	}
	return current;
}
