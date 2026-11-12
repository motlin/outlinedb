import type {InternalAuth, SessionCookieStore} from "@outlinedb/shared/api";
import type {ServerConfig} from "@outlinedb/web/server-app";

/** Optional secret bindings and vars; set as Wrangler secrets (locally in `.dev.vars`). */
export interface WorkerSecrets
{
	WORKFLOWY_API_KEY?: string;
	WORKFLOWY_USERNAME?: string;
	WORKFLOWY_PASSWORD?: string;
	WORKFLOWY_SESSION_COOKIE?: string;
	/** Var; tests point it at a fake upstream. */
	WORKFLOWY_API_URL?: string;
	/**
	 * Var; "true" serves search from an in-memory whole-tree snapshot. Off by default: a large account's snapshot with
	 * its text outgrows the 128 MB Durable Object isolate, which is reset, so search reads SQL and the jump-menu skeleton.
	 */
	TREE_SNAPSHOT?: string;
	/** Workers AI; with RELATED_INDEX it turns related notes on. */
	AI?: unknown;
	/** The Vectorize index holding node vectors; with AI it turns related notes on. */
	RELATED_INDEX?: unknown;
	/**
	 * Comma-separated Durable Object names that mirror workflowy.com and so get the secrets above; falls back to
	 * ALLOWED_EMAILS when unset, so the Access-named owner object keeps working with no new secret.
	 */
	OUTLINEDB_ENV_OWNERS?: string;
	ALLOWED_EMAILS?: string;
}

/** Whether the Durable Object named `storeName` is an owner: the one that mirrors workflowy.com with the env secrets. */
export function isStoreOwner(storeName: string | undefined, env: WorkerSecrets): boolean
{
	if (storeName === undefined)
	{
		return false;
	}
	const owners = (nonEmpty(env.OUTLINEDB_ENV_OWNERS) ?? env.ALLOWED_EMAILS ?? "")
		.split(",")
		.map((entry) => entry.trim().toLowerCase())
		.filter((entry) => entry !== "");
	return owners.includes(storeName.toLowerCase());
}

/**
 * Parse {@link ServerConfig} from Worker bindings; an empty binding counts as unset. A non-owner gets no API key and
 * no account email, so it can never write to the owner's workflowy.com account; it is standalone and writes locally.
 */
export function readWorkerConfig(env: WorkerSecrets, isOwner: boolean): ServerConfig
{
	return {
		mode: isOwner ? "mirror" : "standalone",
		apiKey: isOwner ? nonEmpty(env.WORKFLOWY_API_KEY) : undefined,
		apiUrl: nonEmpty(env.WORKFLOWY_API_URL),
		accountEmail: isOwner ? (env.WORKFLOWY_USERNAME ?? "") : "",
		sqlQueryLogging: false,
		calendarEnsureEnabled: true,
		calendarLayoutEnabled: true,
		features:
		{
			embeddings: env.AI !== undefined && env.RELATED_INDEX !== undefined,
			treeSnapshot: env.TREE_SNAPSHOT === "true",
		},
	};
}

/**
 * Internal-API auth from bindings: credentials, a stored cookie, or both; undefined when neither exists, and always
 * undefined for a non-owner.
 */
export function readWorkerInternalAuth(
	env: WorkerSecrets,
	sessionStore: SessionCookieStore,
	isOwner: boolean,
): InternalAuth | undefined
{
	if (!isOwner)
	{
		return undefined;
	}
	const username = env.WORKFLOWY_USERNAME;
	const password = env.WORKFLOWY_PASSWORD;
	if (username && password)
	{
		return {
			credentials:
			{
				username,
				password,
			},
			sessionStore,
		};
	}
	return sessionStore.read() === undefined
		? undefined
		:
			{
				sessionStore,
			};
}

function nonEmpty(value: string | undefined): string | undefined
{
	return value === "" ? undefined : value;
}
