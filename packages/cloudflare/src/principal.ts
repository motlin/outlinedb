import {getSessionCookie} from "better-auth/cookies";
import {resolveIdentity} from "./access";
import type {AccessEnv} from "./access";

/** Who a request acts as, and the name of the Durable Object that holds their outline. */
export type Principal =
	| {kind: "access"; email: string; storeName: string}
	| {kind: "user"; userId: string; storeName: string};

export type PrincipalResult = Principal | {status: 401 | 403; error: string};

/** The one Better Auth call a principal needs; absent while `BETTER_AUTH_SECRET` is unset. */
export interface SessionReader {
	api: {
		getSession(context: {headers: Headers}): Promise<{user: {id: string; emailVerified: boolean}} | null>;
	};
}

const UNAUTHENTICATED = {status: 401, error: "unauthenticated"} as const;

/**
 * An Access identity's Durable Object: its verified Better Auth user's id once that user signs up, so the CLI and
 * admin routes reach the same outline as the web session; until then the email itself.
 */
async function accessStoreName(db: D1Database, email: string): Promise<string> {
	const row = await db
		.prepare('SELECT id FROM "user" WHERE lower(email) = ? AND emailVerified = 1')
		.bind(email)
		.first<{id: string}>();
	return row?.id ?? email;
}

/**
 * Resolve a request's principal. A valid Access JWT or service token wins; otherwise a Better Auth session cookie,
 * which must belong to a verified email; `auth` is called only then. `ACCESS_DEV_IDENTITY` stands in for Access only on requests with no session
 * cookie, so local dev can still sign in as a session user.
 */
export async function resolvePrincipal(
	request: Request,
	env: AccessEnv & {AUTH_DB: D1Database},
	auth: () => SessionReader | undefined,
): Promise<PrincipalResult> {
	const hasSession = getSessionCookie(request) !== null;
	if (env.ACCESS_DEV_IDENTITY && !hasSession) {
		return {kind: "access", email: env.ACCESS_DEV_IDENTITY, storeName: env.ACCESS_DEV_IDENTITY};
	}
	let accessFailure: PrincipalResult | undefined;
	if (request.headers.has("Cf-Access-Jwt-Assertion")) {
		const identity = await resolveIdentity(request, {...env, ACCESS_DEV_IDENTITY: undefined});
		if ("email" in identity) {
			return {
				kind: "access",
				email: identity.email,
				storeName: await accessStoreName(env.AUTH_DB, identity.email),
			};
		}
		accessFailure = identity.status === 401 ? UNAUTHENTICATED : {status: 403, error: "forbidden"};
	}
	const reader = hasSession ? auth() : undefined;
	if (!reader) {
		return accessFailure ?? UNAUTHENTICATED;
	}
	const session = await reader.api.getSession({headers: request.headers});
	if (!session) {
		return accessFailure ?? UNAUTHENTICATED;
	}
	if (!session.user.emailVerified) {
		return {status: 403, error: "email-unverified"};
	}
	return {kind: "user", userId: session.user.id, storeName: session.user.id};
}
