import {LocalAccount} from "@outlinedb/shared/cache";
import type {WorkflowyInternalAdapter} from "@outlinedb/shared/internal";
import type {ServerContext} from "./context.js";

/** The account-global reads and writes (root metadata, settings) that stars, tags and preferences use. */
export type AccountState = Pick<
	WorkflowyInternalAdapter,
	"getAccount" | "getRootMeta" | "getSetting" | "setRootMeta" | "setRootMetaValues" | "setSavedViews" | "setSetting"
>;

/**
 * The internal adapter that pushes account state to workflowy.com: a mirror's, when it has the internal API. Undefined
 * in a standalone context or a mirror without the internal API, which keep that state in the local tables only.
 */
export function pushingAdapter(ctx: ServerContext): WorkflowyInternalAdapter | undefined {
	return ctx.mode === "standalone" ? undefined : ctx.internalAdapter?.();
}

/**
 * Where this context keeps account-global state: the internal adapter (push, then store) when there is one to push
 * through, else the local temporal tables (no push), as feature toggles do.
 */
export function accountState(ctx: ServerContext): AccountState {
	return pushingAdapter(ctx) ?? new LocalAccount(ctx.db);
}
