import {z} from "zod";
import {readEnabledFeatures} from "@workflowy/shared/cache";
import {INTERNAL_API_NOT_CONFIGURED} from "../internal-api-error.js";
import {defineOp, fail, ok, toJson} from "./define.js";

const CODENAME = /^[a-z0-9_-]+$/u;
const EnabledSchema = z.record(z.string(), z.literal(true));
const VisibleFeatureSchema = z.strictObject({
	codename: z.string(),
	name: z.string(),
	label: z.string().nullable(),
	description: z.string().nullable(),
});
/** The visible feature list and enabled dict; `available` is false without the internal API. */
export const FeaturesResponseSchema = z.strictObject({
	visible: z.array(VisibleFeatureSchema),
	enabled: EnabledSchema,
	available: z.boolean(),
});
/** The enabled dict after a toggle. */
export const FeatureSetResponseSchema = z.strictObject({enabled: EnabledSchema});

/** The server's visible feature list and enabled dict; without the internal API, the stored `enabled_features` with `available: false`. */
export const featuresGet = defineOp({
	input: z.object({}),
	output: FeaturesResponseSchema,
	async run(ctx) {
		const adapter = ctx.internalAdapter?.();
		if (adapter) {
			return ok(
				toJson({
					visible: await adapter.visibleFeatures(),
					enabled: await adapter.enabledFeatures(),
					available: true,
				}),
			);
		}
		const enabled = Object.fromEntries(
			Object.entries(readEnabledFeatures(ctx.db)).flatMap(([codename, on]) =>
				on ? [[codename, true as const]] : [],
			),
		);
		return ok({visible: [], enabled, available: false});
	},
});

/** Turns a feature on or off; a write needs the account, so no adapter means 503. */
export const featuresSet = defineOp({
	input: z.object({codename: z.string().regex(CODENAME), on: z.boolean()}).strict(),
	output: FeatureSetResponseSchema,
	async run(ctx, {codename, on}) {
		const adapter = ctx.internalAdapter?.();
		if (!adapter) {
			return fail(503, {error: INTERNAL_API_NOT_CONFIGURED});
		}
		return ok({enabled: await adapter.setFeature(codename, on)});
	},
});
