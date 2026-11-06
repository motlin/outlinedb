import type {InternalAuth, SessionCookieStore} from "@workflowy/shared/api";
import type {ServerConfig} from "@workflowy/web/server-app";

/** Optional secret bindings and vars; set as Wrangler secrets (locally in `.dev.vars`). */
export interface WorkerSecrets {
	WORKFLOWY_API_KEY?: string;
	WORKFLOWY_USERNAME?: string;
	WORKFLOWY_PASSWORD?: string;
	WORKFLOWY_SESSION_COOKIE?: string;
	/** Var; tests point it at a fake upstream. */
	WORKFLOWY_API_URL?: string;
	/** Var; "false" serves search from SQL instead of an in-memory whole-tree snapshot. */
	TREE_SNAPSHOT?: string;
	/** Workers AI; with RELATED_INDEX it turns related notes on. */
	AI?: unknown;
	/** The Vectorize index holding node vectors; with AI it turns related notes on. */
	RELATED_INDEX?: unknown;
}

/** Parse {@link ServerConfig} from Worker bindings; an empty binding counts as unset. */
export function readWorkerConfig(env: WorkerSecrets): ServerConfig {
	return {
		apiKey: nonEmpty(env.WORKFLOWY_API_KEY),
		apiUrl: nonEmpty(env.WORKFLOWY_API_URL),
		accountEmail: env.WORKFLOWY_USERNAME ?? "",
		sqlQueryLogging: false,
		calendarEnsureEnabled: true,
		calendarLayoutEnabled: true,
		features: {
			embeddings: env.AI !== undefined && env.RELATED_INDEX !== undefined,
			treeSnapshot: env.TREE_SNAPSHOT !== "false",
		},
	};
}

/** Internal-API auth from bindings: credentials, a stored cookie, or both; undefined when neither exists. */
export function readWorkerInternalAuth(env: WorkerSecrets, sessionStore: SessionCookieStore): InternalAuth | undefined {
	const username = env.WORKFLOWY_USERNAME;
	const password = env.WORKFLOWY_PASSWORD;
	if (username && password) {
		return {credentials: {username, password}, sessionStore};
	}
	return sessionStore.read() === undefined ? undefined : {sessionStore};
}

function nonEmpty(value: string | undefined): string | undefined {
	return value === "" ? undefined : value;
}
