import {z} from "zod";
import {pushingAdapter} from "../account-state.js";
import {INTERNAL_API_NOT_CONFIGURED} from "../internal-api-error.js";
import {defineOp, fail, ok} from "./define.js";

/**
 * The signed-in account: in a mirror the Workflowy account, whose `email` is `WORKFLOWY_USERNAME` ("" when unset); in
 * a context without the internal API the provisioned profile, whose `userId` is the sign-in user id.
 */
export const AccountResponseSchema = z.strictObject({
	userId: z.union([z.number(), z.string()]),
	joinedAt: z.string(),
	fullName: z.string().nullable(),
	email: z.string(),
});

export const accountGet = defineOp({
	input: z.object({}),
	output: AccountResponseSchema,
	async run(ctx) {
		const adapter = pushingAdapter(ctx);
		if (adapter) {
			const {userId, joinedAt, fullName} = await adapter.getAccount();
			return ok({userId, joinedAt: joinedAt.toISOString(), fullName, email: ctx.config.accountEmail});
		}
		const identity = ctx.identity?.();
		return identity
			? ok({userId: identity.userId, joinedAt: identity.joinedAt, fullName: null, email: identity.email})
			: fail(503, {error: INTERNAL_API_NOT_CONFIGURED});
	},
});
