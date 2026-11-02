import {AccountNotProvisionedError, LocalAccount} from "@outlinedb/shared/cache";
import type {WorkflowyInternalAdapter} from "@outlinedb/shared/internal";
import type {ServerContext} from "./context.js";
import {INTERNAL_API_NOT_CONFIGURED} from "./internal-api-error.js";
import {fail} from "./ops/define.js";
import type {Json, OpResult} from "./ops/define.js";

/** Account-global state (root metadata, settings): the local tables, or a mirror's internal adapter. */
export type AccountState = LocalAccount | WorkflowyInternalAdapter;

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
 * Where account-global state lives, by the context's mode: a standalone context's local temporal tables (no push),
 * or a mirror's internal adapter (push, then store). Undefined for a mirror without the internal API, which must
 * answer 503 rather than write locally and diverge from workflowy.com.
 */
function accountState(ctx: ServerContext): AccountState | undefined
{
	return ctx.mode === "standalone" ? new LocalAccount(ctx.db) : ctx.internalAdapter?.();
}

/**
 * Runs `body` with the context's account state, answering 503 when there is none: a mirror without the internal API,
 * or a standalone store with no provisioned account row.
 */
export async function withAccountState<T extends Json>(
	ctx: ServerContext,
	body: (state: AccountState) => Promise<OpResult<T>>,
): Promise<OpResult<T>>
{
	const state = accountState(ctx);
	if (state === undefined)
	{
		return accountStateUnavailable();
	}
	try
	{
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
