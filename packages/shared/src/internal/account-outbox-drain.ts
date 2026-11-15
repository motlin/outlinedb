/**
 * The mirror-mode account outbox drain: read the pending account rows and bring workflowy.com up to the current local
 * value of each key. Root metadata paths go out as one edit of the root project, patched against a fresh bootstrap's
 * root metadata; legacy saved views as one `saved_views_json_delta`; settings as one `change_settings` POST each; and
 * expansion keys as one `project_expansions_delta`. A row closes once its request succeeded (the root edit once the
 * server run echoes it), unless its local value changed meanwhile, which leaves it pending for the next drain.
 *
 * Failures are never retried here (Craig approved re-delivery only on the next drain trigger, 2026-11-15): a failed
 * request records `last_error` on the rows it carried, leaves them pending, and stops the pass.
 */

import
{
	canonicalValue,
	closeAccountOutboxRows,
	failAccountOutboxRows,
	metadataAt,
	readPendingAccountOutbox,
	rootMetadataPath,
} from "../cache/account-outbox.js";
import type {AccountOutboxEntry, PendingAccountOutboxRow} from "../cache/account-outbox.js";
import {AccountNotProvisionedError, readAccountSnapshot} from "../cache/account-store.js";
import type {AccountSnapshot} from "../cache/account-store.js";
import {readExpansion} from "../cache/expansion-store.js";
import {runUnitOfWork} from "../cache/node-composite.js";
import type {TemporalTransaction} from "../cache/temporal-merge.js";
import {ExpansionNotSeeded, OutboxNotAcknowledged} from "./errors.js";
import {buildMetadataChanges} from "./metadata-patch.js";
import {editOp, ROOT_PROJECT_ID} from "./ops.js";
import {echoedCount} from "./outbox-drain.js";
import type {OutboxDrainResult, OutboxPusher} from "./outbox-drain.js";
import {hasSavedView, savedViewsDelta} from "./saved-views.js";

type Metadata = Record<string, unknown>;

/** Where an account drain sends; the internal adapter in production, a fake in tests. */
export interface AccountOutboxPusher extends OutboxPusher
{
	/** workflowy.com's current root metadata: the base the root edit's patches are built against. */
	rootMetadata(): Promise<Metadata>;
	/** POST one `change_settings` form field. */
	changeSetting(name: string, value: string): Promise<void>;
	/** Push one `project_expansions_delta`. */
	pushExpansions(delta: Record<string, boolean>): Promise<void>;
}

/** A row's current local value, as compared before and after its request. */
function localValue(
	tx: TemporalTransaction,
	{subject, key}: AccountOutboxEntry,
	snapshot: AccountSnapshot | undefined,
): string
{
	switch (subject)
	{
		case "root_metadata":
		{
			return canonicalValue(metadataAt(snapshot?.rootMetadata, rootMetadataPath(key)));
		}
		case "setting":
		{
			return canonicalValue(snapshot?.settings[key]);
		}
		case "saved_view":
		{
			const json = snapshot?.settings.saved_views_json;
			return String(hasSavedView(typeof json === "string" ? json : undefined, key));
		}
		case "expansion":
		{
			return String(readExpansion(tx)?.has(key) ?? false);
		}
		default:
		{
			throw new TypeError(`unknown account outbox subject: ${String(subject)}`);
		}
	}
}

function errorMessage(error: unknown): string
{
	return error instanceof Error ? error.message : String(error);
}

/** One request's rows and each one's value as sent. */
interface Step
{
	rows: PendingAccountOutboxRow[];
	sent: Map<PendingAccountOutboxRow, string>;
}

/** Close the step's rows whose local value is still the one sent; the count closed. */
function closeDelivered(database: TemporalTransaction, step: Step): number
{
	return runUnitOfWork(database, (unitOfWork) =>
	{
		const snapshot = readAccountSnapshot(unitOfWork.tx);
		const delivered = step.rows.filter((row) => step.sent.get(row) === localValue(unitOfWork.tx, row, snapshot));
		closeAccountOutboxRows(unitOfWork, delivered);
		return delivered.length;
	});
}

/** Run one request; on failure record its error on the step's rows and rethrow. */
async function send(database: TemporalTransaction, step: Step, request: () => Promise<void>): Promise<void>
{
	try
	{
		await request();
	}
	catch (error)
	{
		runUnitOfWork(database, (unitOfWork) =>
		{
			failAccountOutboxRows(unitOfWork, step.rows, errorMessage(error));
		});
		throw error;
	}
}

/**
 * One drain pass over every pending account outbox row, in this order: root metadata, saved views, settings,
 * expansion. The first failed request stops the pass and throws.
 */
export async function drainAccountOutbox(
	database: TemporalTransaction,
	pusher: AccountOutboxPusher,
	options:
	{
		now?: () => number;
	} = {},
): Promise<OutboxDrainResult>
{
	const now = options.now ?? Date.now;
	const pending = readPendingAccountOutbox(database);
	const result: OutboxDrainResult =
	{
		ops: 0,
		closed: 0,
	};
	if (pending.length === 0)
	{
		return result;
	}
	const snapshot = readAccountSnapshot(database);
	const stepOf = (subject: PendingAccountOutboxRow["subject"]): Step =>
	{
		const rows = pending.filter((row) => row.subject === subject);
		return {
			rows,
			sent: new Map(rows.map((row) => [row, localValue(database, row, snapshot)])),
		};
	};

	const root = stepOf("root_metadata");
	if (root.rows.length > 0)
	{
		if (snapshot === undefined)
		{
			throw new AccountNotProvisionedError();
		}
		const changes = root.rows
			.map(({key}) => rootMetadataPath(key))
			.toSorted((x, y) => x.length - y.length)
			.map((path) => (
			{
				path,
				value: metadataAt(snapshot.rootMetadata, path),
			}));
		await send(database, root, async () =>
		{
			const {patches, inverse} = buildMetadataChanges(await pusher.rootMetadata(), changes);
			if (patches.length === 0)
			{
				return;
			}
			result.ops += 1;
			const {dateJoinedSec} = await pusher.session();
			const op = editOp(
				{
					id: ROOT_PROJECT_ID,
					metadataPatches: patches,
					metadataInversePatches: inverse,
					now: now(),
					dateJoinedSec,
				},
			);
			let unacknowledged: OutboxNotAcknowledged | undefined;
			await pusher.push([op], (_unitOfWork, pushed) =>
			{
				const echoed = echoedCount([op], pushed.serverRun);
				if (echoed !== 1)
				{
					unacknowledged = new OutboxNotAcknowledged(1, echoed);
				}
			});
			if (unacknowledged !== undefined)
			{
				throw unacknowledged;
			}
		});
		result.closed += closeDelivered(database, root);
	}

	const savedViews = stepOf("saved_view");
	if (savedViews.rows.length > 0)
	{
		const json = snapshot?.settings.saved_views_json;
		const delta = savedViewsDelta(
			typeof json === "string" ? json : undefined,
			savedViews.rows.map(({key}) => key),
		);
		await send(database, savedViews, async () => pusher.changeSetting("saved_views_json_delta", delta));
		result.ops += 1;
		result.closed += closeDelivered(database, savedViews);
	}

	for (const row of stepOf("setting").rows)
	{
		const value = snapshot?.settings[row.key];
		const step: Step =
		{
			rows: [row],
			sent: new Map([[row, canonicalValue(value)]]),
		};
		if (typeof value === "string" || typeof value === "boolean")
		{
			// Flags go over the wire as "yes"/"no".
			const wire = typeof value === "boolean" ? (value ? "yes" : "no") : value;
			// oxlint-disable-next-line no-await-in-loop -- one POST per setting, stopping at the first failure
			await send(database, step, async () => pusher.changeSetting(row.key, wire));
			result.ops += 1;
		}
		result.closed += closeDelivered(database, step);
	}

	const expansion = stepOf("expansion");
	if (expansion.rows.length > 0)
	{
		const keys = readExpansion(database);
		await send(database, expansion, async () =>
		{
			if (keys === undefined)
			{
				throw new ExpansionNotSeeded();
			}
			await pusher.pushExpansions(Object.fromEntries(expansion.rows.map(({key}) => [key, keys.has(key)])));
		});
		result.ops += 1;
		result.closed += closeDelivered(database, expansion);
	}
	return result;
}
