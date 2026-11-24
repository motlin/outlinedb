import {APIError, createAuthMiddleware} from "better-auth/api";

/** Who may sign up: `SIGNUP_MODE` is a var, `SIGNUP_INVITES` a secret so no personal email is committed. */
export interface SignupEnv
{
	/** "closed" (the default), "invite" (only `SIGNUP_INVITES`) or "open". Anything else counts as closed. */
	SIGNUP_MODE?: string;
	/** Comma-separated invited emails, matched case-insensitively. */
	SIGNUP_INVITES?: string;
}

/** Whether `email` may create an account under the configured signup mode. */
export function signupAllowed(env: SignupEnv, email: string): boolean
{
	switch (env.SIGNUP_MODE)
	{
		case "open":
		{
			return true;
		}
		case "invite":
		{
			const invites = (env.SIGNUP_INVITES ?? "")
				.split(",")
				.map((entry) => entry.trim().toLowerCase())
				.filter((entry) => entry !== "");
			return invites.includes(email.trim().toLowerCase());
		}
		case undefined:
		default:
		{
			return false;
		}
	}
}

/** `body[name]` when `body` is an object, else undefined. */
function bodyField(body: unknown, name: string): unknown
{
	return typeof body === "object" && body !== null && name in body ? Reflect.get(body, name) : undefined;
}

/**
 * A Better Auth `hooks.before` that answers 403 `{error: "signup-closed"}` to any `/sign-up/*` the mode rejects, and
 * 400 `{error: "password-required"}` to a `/delete-user` without a password, so a session alone, even a fresh one,
 * never deletes an account.
 */
export function requestGate(env: SignupEnv)
{
	return createAuthMiddleware(async (ctx) =>
	{
		await Promise.resolve();
		if (ctx.path === "/delete-user")
		{
			const password = bodyField(ctx.body, "password");
			if (typeof password !== "string" || password === "")
			{
				throw new APIError(
					"BAD_REQUEST",
					{
						error: "password-required",
					},
				);
			}
			return;
		}
		if (!ctx.path.startsWith("/sign-up/"))
		{
			return;
		}
		const email = bodyField(ctx.body, "email");
		if (typeof email !== "string" || !signupAllowed(env, email))
		{
			throw new APIError(
				"FORBIDDEN",
				{
					error: "signup-closed",
				},
			);
		}
	});
}
