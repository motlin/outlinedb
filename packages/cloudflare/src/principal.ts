import {getSessionCookie} from "better-auth/cookies";
import {resolveIdentity} from "./access";
import type {AccessEnv} from "./access";
import {provisionUser} from "./auth/provision";
import type {ProvisionEnv} from "./auth/provision";

/**
 * Who a request acts as, and the name of the Durable Object that holds their outline. An Access identity's `userId` is
 * its verified D1 user's id, or null until that email signs up.
 */
export type Principal =
	|
	  {
			kind: "access";
			email: string;
			userId: string | null;
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
 * An Access identity's verified Better Auth user id, or null before that email signs up. Its Durable Object is named
 * by that id, so the CLI and admin routes reach the same outline as the web session; until then by the email itself.
 * A verified user not yet provisioned is provisioned here first.
 */
async function accessUserId(env: ProvisionEnv, email: string): Promise<string | null>
{
	const row = await env.AUTH_DB.prepare(
		'SELECT id, email, provisioned_at FROM "user" WHERE lower(email) = ? AND emailVerified = 1',
	)
		.bind(email)
		.first<
		{
			id: string;
			email: string;
			provisioned_at: string | null;
		}>();
	if (!row)
	{
		return null;
	}
	if (row.provisioned_at === null)
	{
		await provisionUser(env, row);
	}
	return row.id;
}

/**
 * Resolve a request's principal. A valid Access JWT or service token wins; otherwise a Better Auth session cookie,
 * which must belong to a verified email; `auth` is called only then. A verified user whose provisioning never landed
 * (a failed hook) is provisioned lazily: one extra Durable Object RPC, on that first request only. `ACCESS_DEV_IDENTITY` stands in for Access only on requests with no session
 * cookie, so local dev can still sign in as a session user.
 */
export async function resolvePrincipal(
	request: Request,
	env: AccessEnv & ProvisionEnv,
	auth: () => SessionReader | undefined,
): Promise<PrincipalResult>
{
	const hasSession = getSessionCookie(request) !== null;
	if (env.ACCESS_DEV_IDENTITY && !hasSession)
	{
		return {
			kind: "access",
			email: env.ACCESS_DEV_IDENTITY,
			userId: null,
			storeName: env.ACCESS_DEV_IDENTITY,
		};
	}
	let accessFailure: PrincipalResult | undefined;
	if (request.headers.has("Cf-Access-Jwt-Assertion"))
	{
		const identity = await resolveIdentity(
			request,
			{
				...env,
				ACCESS_DEV_IDENTITY: undefined,
			},
		);
		if ("email" in identity)
		{
			const userId = await accessUserId(env, identity.email);
			return {
				kind: "access",
				email: identity.email,
				userId,
				storeName: userId ?? identity.email,
			};
		}
		accessFailure =
			identity.status === 401
				? UNAUTHENTICATED
				:
					{
						status: 403,
						error: "forbidden",
					};
	}
	const reader = hasSession ? auth() : undefined;
	if (!reader)
	{
		return accessFailure ?? UNAUTHENTICATED;
	}
	const session = await reader.api.getSession(
		{
			headers: request.headers,
		},
	);
	if (!session)
	{
		return accessFailure ?? UNAUTHENTICATED;
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
