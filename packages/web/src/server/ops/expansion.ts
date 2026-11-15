/**
 * Expansion state, kept in our own expansion store in both modes (503 for a mirror without the internal API). A
 * standalone context applies each PATCH to the store directly; a mirror also records each changed key in the account
 * outbox in the same unit of work, and a drain delivers them to workflowy.com as one `project_expansions_delta`.
 *
 * `expansion.get` is a change feed over our own expansion store (seeded by whole-tree imports, updated by every local
 * change; nothing re-reads workflowy.com): `{version?}` -> `{version, expandedIds}`, where `version` is the keys'
 * content version and `expandedIds` is null when it equals the caller's `version` and the whole expanded set otherwise. `expansion.patch` with `{changes: {[nodeId]: boolean}}` ->
 * null (204).
 */

import
{
	applyExpansionDelta,
	applyLocalExpansionDelta,
	expansionVersion,
	readExpansion,
	resolveExpandedIds,
	runUnitOfWork,
} from "@outlinedb/shared/cache";
import {ExpansionNotSeeded} from "@outlinedb/shared/internal";
import {upstreamExpansionKey} from "@outlinedb/shared/workflowy";
import {z} from "zod";
import type {ServerContext} from "../context.js";
import {accountStateUnavailable, mirrorAccountOutbox} from "../account-state.js";
import {defineOp, ok} from "./define.js";
import {ExpansionChangesResponseSchema, NoContentSchema} from "./schemas.js";

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

/**
 * Apply a delta keyed by upstream keys to a mirror's expansion store and record its keys in the account outbox, in one
 * unit of work, then announce the new version. An unseeded store fails loudly: a partial set would read as the whole
 * account's.
 */
export function applyMirrorExpansion(ctx: ServerContext, delta: Record<string, boolean>): void
{
	const outbox = mirrorAccountOutbox(ctx);
	runUnitOfWork(ctx.db, (unitOfWork) =>
	{
		if (applyExpansionDelta(unitOfWork, delta) === undefined)
		{
			throw new ExpansionNotSeeded();
		}
		outbox.record(
			unitOfWork,
			Object.keys(delta).map((key) => (
			{
				subject: "expansion",
				key,
			})),
		);
	});
	ctx.expansionWritten?.();
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
			const delta = Object.fromEntries(
				Object.entries(changes).map(([id, expanded]) => [upstreamExpansionKey(id), expanded]),
			);
			if (ctx.mode === "standalone")
			{
				applyLocally(ctx, delta);
				return ok(null);
			}
			if (!ctx.internalAdapter?.())
			{
				return accountStateUnavailable();
			}
			applyMirrorExpansion(ctx, delta);
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
			if (!ctx.internalAdapter?.())
			{
				return accountStateUnavailable();
			}
			applyMirrorExpansion(ctx, changes);
			return ok(null);
		},
	},
);
