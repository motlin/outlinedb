/**
 * Expansion state, synced with workflowy.com through the internal API in a mirror (503 without one). A standalone
 * context reads and writes the same expansion store directly: each PATCH applies at once, with no push and no debounce.
 *
 * `expansion.get` is a change feed over our own expansion store (seeded by whole-tree imports, updated by every local
 * change; nothing re-reads workflowy.com): `{version?}` -> `{version, expandedIds}`, where `version` is the keys'
 * content version and `expandedIds` is null when it equals the caller's `version` and the whole expanded set otherwise. `expansion.patch` with `{changes: {[nodeId]: boolean}}` ->
 * null (204). PATCHes are debounced like upstream: one push 500ms after the last PATCH, the latest value per id
 * winning. A failed push is retried on a backoff with its changes merged under newer PATCHes. The debounce state
 * lives per server context, i.e. per Durable Object or Node host.
 */

import
{
	applyLocalExpansionDelta,
	expansionVersion,
	readExpansion,
	resolveExpandedIds,
	runUnitOfWork,
} from "@outlinedb/shared/cache";
import type {WorkflowyInternalAdapter} from "@outlinedb/shared/internal";
import {upstreamExpansionKey} from "@outlinedb/shared/workflowy";
import {z} from "zod";
import type {ServerContext} from "../context.js";
import {accountStateUnavailable} from "../account-state.js";
import {defineOp, ok} from "./define.js";
import {ExpansionChangesResponseSchema, NoContentSchema} from "./schemas.js";

const FLUSH_DELAY_MS = 500;

/** Waits before each retry of a failed push; once exhausted the changes are dropped with a log. */
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];

const ExpansionPatchSchema = z.object(
	{
		changes: z.record(z.string(), z.boolean()),
	},
);

const LeftBarPatchSchema = z.object(
	{
		changes: z.record(z.string().regex(/^leftbar__(home|starred)__/u), z.boolean()),
	},
);

interface ExpansionState
{
	pending: Record<string, boolean>;
	timer: ReturnType<typeof setTimeout> | undefined;
	failures: number;
	pendingRaw: Record<string, boolean>;
	rawTimer: ReturnType<typeof setTimeout> | undefined;
}

const states = new WeakMap<ServerContext, ExpansionState>();

function stateOf(ctx: ServerContext): ExpansionState
{
	let state = states.get(ctx);
	if (state === undefined)
	{
		state =
		{
			pending: {},
			timer: undefined,
			failures: 0,
			pendingRaw: {},
			rawTimer: undefined,
		};
		states.set(ctx, state);
	}
	return state;
}

function flush(ctx: ServerContext, state: ExpansionState, adapter: WorkflowyInternalAdapter)
{
	const changes = state.pending;
	state.pending = {};
	adapter.setExpanded(changes).then(
		() =>
		{
			state.failures = 0;
			ctx.expansionWritten?.();
			return;
		},
		(error: unknown) =>
		{
			state.pending =
			{
				...changes,
				...state.pending,
			};
			const delay = RETRY_DELAYS_MS[state.failures];
			state.failures += 1;
			if (delay === undefined)
			{
				console.error("Failed to push expansion changes; giving up", error);
				state.failures = 0;
				state.pending = {};
				return;
			}
			console.error(`Failed to push expansion changes; retrying in ${delay}ms`, error);
			clearTimeout(state.timer);
			state.timer = setTimeout(() =>
			{
				flush(ctx, state, adapter);
			}, delay);
		},
	);
}

/** A standalone context's stored keys; an unseeded store reads as nothing expanded. */
function localKeys(ctx: ServerContext): Set<string>
{
	return readExpansion(ctx.db) ?? new Set();
}

/** Apply a delta keyed by upstream keys to a standalone context's store, then announce the new version. */
function applyLocally(ctx: ServerContext, delta: Record<string, boolean>): void
{
	runUnitOfWork(ctx.db, (unitOfWork) =>
	{
		applyLocalExpansionDelta(unitOfWork, delta);
	});
	ctx.expansionWritten?.();
}

export const expansionGet = defineOp(
	{
		input: z.object(
			{
				version: z
					.string()
					.regex(/^[0-9a-f]{16}$/u)
					.optional(),
			},
		),
		output: ExpansionChangesResponseSchema,
		run(ctx, {version})
		{
			if (ctx.mode === "standalone")
			{
				const keys = localKeys(ctx);
				const current = expansionVersion(keys);
				return ok(
					{
						version: current,
						expandedIds: version === current ? null : resolveExpandedIds(ctx.db, keys),
					},
				);
			}
			const adapter = ctx.internalAdapter?.();
			if (!adapter)
			{
				return accountStateUnavailable();
			}
			const {version: current, expandedIds} = adapter.getExpansionChanges(version);
			return ok(
				{
					version: current,
					expandedIds,
				},
			);
		},
	},
);

export const expansionPatch = defineOp(
	{
		input: ExpansionPatchSchema,
		output: NoContentSchema,
		run(ctx, {changes})
		{
			if (ctx.mode === "standalone")
			{
				applyLocally(
					ctx,
					Object.fromEntries(
						Object.entries(changes).map(([id, expanded]) => [upstreamExpansionKey(id), expanded]),
					),
				);
				return ok(null);
			}
			const adapter = ctx.internalAdapter?.();
			if (!adapter)
			{
				return accountStateUnavailable();
			}
			const state = stateOf(ctx);
			state.pending =
			{
				...state.pending,
				...changes,
			};
			clearTimeout(state.timer);
			state.timer = setTimeout(() =>
			{
				flush(ctx, state, adapter);
			}, FLUSH_DELAY_MS);
			return ok(null);
		},
	},
);

export const expansionLeftBarGet = defineOp(
	{
		input: z.object({}),
		output: z.strictObject(
			{
				keys: z.array(z.string()),
			},
		),
		run(ctx)
		{
			if (ctx.mode === "standalone")
			{
				return ok(
					{
						keys: [...localKeys(ctx)].filter((key) => key.startsWith("leftbar__")).toSorted(),
					},
				);
			}
			const adapter = ctx.internalAdapter?.();
			if (!adapter)
			{
				return accountStateUnavailable();
			}
			return ok(
				{
					keys: adapter.getLeftBarExpansionKeys(),
				},
			);
		},
	},
);

export const expansionLeftBarPatch = defineOp(
	{
		input: LeftBarPatchSchema,
		output: NoContentSchema,
		run(ctx, {changes})
		{
			if (ctx.mode === "standalone")
			{
				applyLocally(ctx, changes);
				return ok(null);
			}
			const adapter = ctx.internalAdapter?.();
			if (!adapter)
			{
				return accountStateUnavailable();
			}
			const state = stateOf(ctx);
			state.pendingRaw =
			{
				...state.pendingRaw,
				...changes,
			};
			clearTimeout(state.rawTimer);
			state.rawTimer = setTimeout(() =>
			{
				const raw = state.pendingRaw;
				state.pendingRaw = {};
				adapter.setRawExpansionKeys(raw).then(
					() =>
					{
						ctx.expansionWritten?.();
						return;
					},
					(error: unknown) =>
					{
						console.error("Failed to push left-bar expansion changes", error);
					},
				);
			}, FLUSH_DELAY_MS);
			return ok(null);
		},
	},
);
