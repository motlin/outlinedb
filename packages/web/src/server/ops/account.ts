import {z} from "zod";
import {AccountNotProvisionedError, LocalAccount} from "@outlinedb/shared/cache";
import {accountStateUnavailable} from "../account-state.js";
import {defineOp, ok} from "./define.js";

/**
 * The signed-in account: in a mirror the Workflowy account, whose `email` is `WORKFLOWY_USERNAME` ("" when unset); in
 * a standalone context the provisioned account row, whose `userId` is the sign-in user id.
 */
export const AccountResponseSchema = z.strictObject(
	{
		userId: z.string(),
		joinedAt: z.string(),
		fullName: z.string().nullable(),
		email: z.string(),
	},
);

export const accountGet = defineOp(
	{
		input: z.object({}),
		output: AccountResponseSchema,
		async run(ctx)
		{
			if (ctx.mode === "standalone")
			{
				try
				{
					const {userId, joinedAt, fullName, email} = await new LocalAccount(ctx.db).getAccount();
					return ok(
						{
							userId,
							joinedAt: joinedAt.toISOString(),
							fullName,
							email: email ?? "",
						},
					);
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
			const adapter = ctx.internalAdapter?.();
			if (!adapter)
			{
				return accountStateUnavailable();
			}
			const {userId, joinedAt, fullName} = await adapter.getAccount();
			return ok(
				{
					userId,
					joinedAt: joinedAt.toISOString(),
					fullName,
					email: ctx.config.accountEmail,
				},
			);
		},
	},
);
