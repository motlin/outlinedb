import {z} from "zod";
import {readEnabledFeatures, writeEnabledFeatures} from "@outlinedb/shared/cache";
import type {TemporalTransaction} from "@outlinedb/shared/cache";
import {DEFAULT_FEATURES, VISIBLE_FEATURES} from "../../feature-catalog.js";
import {accountStateUnavailable} from "../account-state.js";
import {defineOp, ok, toJson} from "./define.js";

const CODENAME = /^[a-z0-9_-]+$/u;
const EnabledSchema = z.record(z.string(), z.literal(true));
const VisibleFeatureSchema = z.strictObject(
	{
		codename: z.string(),
		name: z.string(),
		label: z.string().nullable(),
		description: z.string().nullable(),
	},
);
/** The visible feature list and enabled dict; `available` is false without the internal API. */
export const FeaturesResponseSchema = z.strictObject(
	{
		visible: z.array(VisibleFeatureSchema),
		enabled: EnabledSchema,
		available: z.boolean(),
	},
);
/** The enabled dict after a toggle. */
export const FeatureSetResponseSchema = z.strictObject(
	{
		enabled: EnabledSchema,
	},
);

/** The stored flags (codename -> on), or the defaults when the account has never stored any (fresh or standalone database). */
function localFeatures(db: TemporalTransaction): Record<string, boolean>
{
	const stored = readEnabledFeatures(db);
	return Object.keys(stored).length > 0
		? stored
		:
			{
				...DEFAULT_FEATURES,
			};
}

function enabledOnly(features: Readonly<Record<string, boolean>>): Record<string, true>
{
	return Object.fromEntries(
		Object.entries(features).flatMap(([codename, on]) => (on ? [[codename, true as const]] : [])),
	);
}

/**
 * The server's visible feature list and enabled dict. Without the internal API: the catalog's visible rows and the
 * stored `enabled_features` (the defaults when nothing is stored), with `available: false`.
 */
export const featuresGet = defineOp(
	{
		input: z.object({}),
		output: FeaturesResponseSchema,
		async run(ctx)
		{
			const adapter = ctx.internalAdapter?.();
			if (adapter)
			{
				return ok(
					toJson(
						{
							visible: await adapter.visibleFeatures(),
							enabled: await adapter.enabledFeatures(),
							available: true,
						},
					),
				);
			}
			return ok(
				toJson(
					{
						visible: VISIBLE_FEATURES,
						enabled: enabledOnly(localFeatures(ctx.db)),
						available: false,
					},
				),
			);
		},
	},
);

/**
 * Turns a feature on or off: through the account in a mirror (503 without the internal API, so it never diverges from
 * workflowy.com), or in the local `enabled_features` in a standalone context.
 */
export const featuresSet = defineOp(
	{
		input: z
			.object(
				{
					codename: z.string().regex(CODENAME),
					on: z.boolean(),
				},
			)
			.strict(),
		output: FeatureSetResponseSchema,
		async run(ctx, {codename, on})
		{
			if (ctx.mode !== "standalone")
			{
				const adapter = ctx.internalAdapter?.();
				return adapter
					? ok(
							{
								enabled: await adapter.setFeature(codename, on),
							},
						)
					: accountStateUnavailable();
			}
			const next =
			{
				...localFeatures(ctx.db),
				[codename]: on,
			};
			writeEnabledFeatures(ctx.db, next);
			return ok(
				{
					enabled: enabledOnly(next),
				},
			);
		},
	},
);
