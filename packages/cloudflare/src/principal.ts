import {getSessionCookie} from "better-auth/cookies";
import {provisionUser} from "./auth/provision";
import type {ProvisionEnv} from "./auth/provision";

/** `DEV_IDENTITY` is a local-only bypass: it names the Durable Object a request with no session cookie acts on. */
export interface DevEnv
{
	DEV_IDENTITY?: string;
}

/**
 * Who a request acts as, and the name of the Durable Object that holds their outline. The local dev identity has no
 * D1 user, so its `userId` is null.
 */
export type Principal =
	|
	  {
			kind: "dev";
			email: string;
			userId: null;
			storeName: string;
	  }
	|
	  {
			kind: "user";
			email: string;
			userId: string;
			storeName: string;
	  };

export type PrincipalResult =
	| Principal
	|
	  {
			status: 401 | 403;
			error: string;
	  };

/** The one Better Auth call a principal needs; absent while `BETTER_AUTH_SECRET` is unset. */
export interface SessionReader
{
	api:
	{
		getSession(context: {headers: Headers}): Promise<
		{
			user:
			{
				id: string;
				email: string;
				emailVerified: boolean;
				provisionedAt?: Date | null;
			};
		} | null>;
	};
}

const UNAUTHENTICATED =
{
	status: 401,
	error: "unauthenticated",
} as const;

/**
 * Resolve a request's principal from a Better Auth session cookie, which must belong to a verified email; `auth` is
 * called only then. A verified user whose provisioning never landed (a failed hook) is provisioned lazily: one extra
 * Durable Object RPC, on that first request only. `DEV_IDENTITY` answers only requests with no session cookie, so local
 * dev can still sign in as a session user.
 */
export async function resolvePrincipal(
	request: Request,
	env: DevEnv & ProvisionEnv,
	auth: () => SessionReader | undefined,
): Promise<PrincipalResult>
{
	const hasSession = getSessionCookie(request) !== null;
	if (env.DEV_IDENTITY && !hasSession)
	{
		return {
			kind: "dev",
			email: env.DEV_IDENTITY,
			userId: null,
			storeName: env.DEV_IDENTITY,
		};
	}
	const reader = hasSession ? auth() : undefined;
	if (!reader)
	{
		return UNAUTHENTICATED;
	}
	const session = await reader.api.getSession(
		{
			headers: request.headers,
		},
	);
	if (!session)
	{
		return UNAUTHENTICATED;
	}
	if (!session.user.emailVerified)
	{
		return {
			status: 403,
			error: "email-unverified",
		};
	}
	if (!session.user.provisionedAt)
	{
		await provisionUser(env, session.user);
	}
	return {
		kind: "user",
		email: session.user.email,
		userId: session.user.id,
		storeName: session.user.id,
	};
}
