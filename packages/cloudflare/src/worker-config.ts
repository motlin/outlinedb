import type {ServerConfig} from "@outlinedb/web/server-app";

/** Optional secret bindings and vars; set as Wrangler secrets (locally in `.dev.vars`). */
export interface WorkerSecrets
{
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
	 * Secret; with each Durable Object's id it derives the AES-GCM key that seals that object's workflowy.com session.
	 * Unset, connecting a Workflowy account answers 503.
	 */
	OUTLINEDB_CREDENTIALS_KEY?: string;
}

/**
 * Parse {@link ServerConfig} from Worker bindings; an empty binding counts as unset. Every account starts standalone:
 * the Worker holds no Workflowy credentials of its own, and only an account's own connection, once it keeps syncing,
 * turns it into a mirror.
 */
export function readWorkerConfig(env: WorkerSecrets): ServerConfig
{
	return {
		mode: "standalone",
		apiKey: undefined,
		apiUrl: nonEmpty(env.WORKFLOWY_API_URL),
		accountEmail: "",
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

function nonEmpty(value: string | undefined): string | undefined
{
	return value === "" ? undefined : value;
}
