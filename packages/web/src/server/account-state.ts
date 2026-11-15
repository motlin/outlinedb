import {AccountNotProvisionedError, AccountOutboxRecorder, LocalAccount} from "@outlinedb/shared/cache";
import type {AccountOutboxEntry, UnitOfWork} from "@outlinedb/shared/cache";
import type {ServerContext} from "./context.js";
import {INTERNAL_API_NOT_CONFIGURED} from "./internal-api-error.js";
import {fail} from "./ops/define.js";
import type {Json, OpResult} from "./ops/define.js";

/** Account-global state (root metadata, settings) in the local account tables, in both modes. */
export type AccountState = LocalAccount;

/** The 503 a mirror without the internal API, or an unprovisioned standalone store, answers for account state. */
export function accountStateUnavailable(): OpResult<never>
{
	return fail(
		503,
		{
			error: INTERNAL_API_NOT_CONFIGURED,
		},
	);
}

/**
 * Records a mirror-mode account write's outbox rows in its unit of work, then announces them. Units of work run
 * synchronously, so the microtask runs after the commit.
 */
class AnnouncingAccountOutboxRecorder extends AccountOutboxRecorder
{
	constructor(private readonly written: (() => void) | undefined)
	{
		super();
	}

	override record(unitOfWork: UnitOfWork, entries: readonly AccountOutboxEntry[]): void
	{
		super.record(unitOfWork, entries);
		const {written} = this;
		if (entries.length > 0 && written !== undefined)
		{
			queueMicrotask(written);
		}
	}
}

/** A mirror's account outbox recorder: it records each unit of work's rows, then starts the host's drain. */
export function mirrorAccountOutbox(ctx: ServerContext): AccountOutboxRecorder
{
	return new AnnouncingAccountOutboxRecorder(ctx.outboxWritten);
}

/**
 * Where account-global state lives: the local temporal tables in both modes. A mirror loads them through its internal
 * adapter first (a bootstrap when missing, a background refresh when stale), and its writes record account outbox
 * rows that a drain delivers to workflowy.com. Undefined for a mirror without the internal API, which must answer 503
 * rather than write locally what could never be delivered.
 */
async function accountState(ctx: ServerContext): Promise<AccountState | undefined>
{
	if (ctx.mode === "standalone")
	{
		return new LocalAccount(ctx.db);
	}
	const adapter = ctx.internalAdapter?.();
	if (adapter === undefined)
	{
		return undefined;
	}
	await adapter.loadAccountState();
	return new LocalAccount(
		ctx.db,
		{
			outbox: mirrorAccountOutbox(ctx),
		},
	);
}

/**
 * Runs `body` with the context's account state, answering 503 when there is none: a mirror without the internal API,
 * or a store with no account row.
 */
export async function withAccountState<T extends Json>(
	ctx: ServerContext,
	body: (state: AccountState) => Promise<OpResult<T>>,
): Promise<OpResult<T>>
{
	try
	{
		const state = await accountState(ctx);
		if (state === undefined)
		{
			return accountStateUnavailable();
		}
		return await body(state);
	}
	catch (error)
	{
		if (error instanceof AccountNotProvisionedError)
		{
			return accountStateUnavailable();
		}
		throw error;
	}
}
