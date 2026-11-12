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

/** A Better Auth `hooks.before` that answers 403 `{error: "signup-closed"}` to any `/sign-up/*` the mode rejects. */
export function signupGate(env: SignupEnv)
{
	return createAuthMiddleware(async (ctx) =>
	{
		await Promise.resolve();
		if (!ctx.path.startsWith("/sign-up/"))
		{
			return;
		}
		const body: unknown = ctx.body;
		const email = typeof body === "object" && body !== null && "email" in body ? body.email : undefined;
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
