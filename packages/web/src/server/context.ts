import {WorkflowyApiClient, WorkflowyInternalClient} from "@outlinedb/shared/api";
import type {InternalAuth} from "@outlinedb/shared/api";
import {CacheService, WorkflowyWriteThroughClient} from "@outlinedb/shared/cache";
import {WorkflowyInternalAdapter} from "@outlinedb/shared/internal";
import type {AppDatabase} from "@outlinedb/shared/db";
import type {ServerConfig, ServerMode} from "./config.js";
import type {DecisionStore} from "./decisions.js";
import type {EmbeddingIndex} from "./embedding-index.js";
import type {LadderEventBus} from "./ladder-events.js";

type ServerDatabase = AppDatabase;

/**
 * The server's composition root: the dependencies a router needs, assembled in
 * one place and handed to the routers instead of each handler reaching for the
 * `getDatabase()` singleton and `process.env`. A test builds one over an
 * in-memory database and drives `app.fetch(...)` with no disk, network, or env.
 */
export interface ServerContext {
	db: ServerDatabase;
	cacheService: CacheService;
	/** Settings parsed by the host; routers read these instead of `process.env`. */
	config: ServerConfig;
	/** Where ladder writes are announced; the ladder socket subscribes to the same instance. */
	ladderEvents: LadderEventBus;
	/** Where decision pages are staged and answered, or undefined when the host has no such files. */
	decisions?: DecisionStore;
	/** Where node writes go; see {@link ServerConfig.mode}. Never inferred from a missing API key. */
	mode: ServerMode;
	/** The Workflowy API key, or undefined when write operations are unavailable. */
	apiKey?: string;
	/**
	 * Called after a debounced expansion push lands in the expansion store, outside any op's unit of work; the Node
	 * host announces the new version on the events socket.
	 */
	expansionWritten?: () => void;
	/** Internal-API auth (saved session cookie and/or login), or undefined when internal-API routes are unavailable. */
	internalAuth?: InternalAuth;
	/**
	 * The internal-API adapter, built on first call and shared afterwards, or
	 * undefined when internal-API auth is not configured.
	 */
	internalAdapter?: () => WorkflowyInternalAdapter | undefined;
	/** A standalone context's provisioned identity, or undefined before provisioning or on a host that has none. */
	identity?: () => LocalIdentity | undefined;
	/**
	 * Whether `POST /api/v1/calendar/day/:dateId/ensure` may create day nodes
	 * (`CALENDAR_ENSURE_ENABLED`, on unless `false`): the M2-74 calendar-adopt
	 * probe confirmed workflowy.com adopts ensured day nodes.
	 */
	calendarEnsureEnabled?: boolean;
	/**
	 * Whether `PUT /api/v1/calendar/layout` may restructure the calendar
	 * (`CALENDAR_LAYOUT_ENABLED`, on unless `false`): it moves, creates and
	 * deletes level nodes account-wide, behind a confirm dialog and a one-shot Undo.
	 */
	calendarLayoutEnabled?: boolean;
	/** The vector index for an embedding model, or undefined when the host has no vector store. */
	embeddingIndex?: (model: string) => EmbeddingIndex;
}

/** Whom a standalone context was provisioned for: the sign-in user id and email, and when (ISO). */
export interface LocalIdentity {
	userId: string;
	email: string;
	joinedAt: string;
}

/** Hono environment: routers read the {@link ServerContext} via `c.get('ctx')`. */
export interface AppEnv {
	Variables: {ctx: ServerContext};
}

/** What a host supplies; {@link buildServerContext} derives the rest. */
export interface ServerContextDeps {
	db: ServerDatabase;
	config: ServerConfig;
	ladderEvents: LadderEventBus;
	/** Undefined when the host keeps no decision-page files. */
	decisions?: DecisionStore;
	/** Undefined when the host has no internal-API credentials. */
	internalAuth?: InternalAuth;
	/** Undefined when the host has no vector store; related notes then answer an empty list. */
	embeddingIndex?: (model: string) => EmbeddingIndex;
	/** Undefined when the host provisions no identity (a Node host). */
	identity?: () => LocalIdentity | undefined;
}

/** Assemble a {@link ServerContext} from host-supplied dependencies, with no process or filesystem access. */
export function buildServerContext(deps: ServerContextDeps): ServerContext {
	const {db, config, ladderEvents, decisions, internalAuth, embeddingIndex, identity} = deps;
	const cacheService = new CacheService(db);
	const apiKey = config.apiKey;
	let adapter: WorkflowyInternalAdapter | undefined;
	return {
		db,
		cacheService,
		config,
		ladderEvents,
		decisions,
		mode: config.mode,
		apiKey,
		internalAuth,
		embeddingIndex,
		identity,
		calendarEnsureEnabled: config.calendarEnsureEnabled,
		calendarLayoutEnabled: config.calendarLayoutEnabled,
		internalAdapter: () => {
			if (!adapter && internalAuth) {
				adapter = new WorkflowyInternalAdapter({
					client: new WorkflowyInternalClient(internalAuth),
					db,
					// Tree writes refresh the cache through the public API, which needs the key.
					writeThrough: apiKey
						? new WorkflowyWriteThroughClient(
								new WorkflowyApiClient(apiKey, undefined, config.apiUrl),
								cacheService,
							)
						: undefined,
				});
			}
			return adapter;
		},
	};
}
