import {DurableObject} from "cloudflare:workers";
import {
	accountRowTotal,
	accountVersion,
	ensureNodeTags,
	readAccountRows,
	readAccountState,
	runUnitOfWork,
	writeAccountState,
} from "@outlinedb/shared/cache";
import type {AccountState} from "@outlinedb/shared/cache";
import * as schema from "@outlinedb/shared/db";
import {
	LadderEventBus,
	TreeEventBus,
	accountChangePublisher,
	bindTreeHost,
	buildServerContext,
	inProcessStore,
	peekTreeSnapshotRows,
} from "@outlinedb/web/server-app";
import type {
	Awaitable,
	EmbeddingIndex,
	OpInput,
	OpName,
	OpOutput,
	OpResult,
	StoreClient,
} from "@outlinedb/web/server-app";
import {WorkflowyInternalClient} from "@outlinedb/shared/api";
import type {SessionCookieStore} from "@outlinedb/shared/api";
import {drizzle} from "drizzle-orm/durable-sqlite";
import {migrate} from "drizzle-orm/durable-sqlite/migrator";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import {AlarmSchedule} from "./alarm-schedule";
import {doMigrationConfig} from "./do-migrations";
import {EmbeddingJob} from "./embedding-job";
import type {EmbeddingStatus} from "./embedding-job";
import {vectorizeIndex, workersAiEmbedder} from "./embeddings";
import type {Embedder} from "./embeddings";
import {kvSessionStore} from "./session-store";
import type {KvLike} from "./session-store";
import {SyncJob} from "./sync";
import {seedWelcomeContent} from "./welcome-content";
import type {SyncEnv, SyncStatus} from "./sync";
import {isStoreOwner, readWorkerConfig, readWorkerInternalAuth} from "./worker-config";
import type {WorkerSecrets} from "./worker-config";

/**
 * One user's outline: a SQLite-backed Durable Object answering RPC over its own database, plus the ladder and nodes
 * events WebSocket upgrades.
 */
export class UserStore extends DurableObject<Env & WorkerSecrets & SyncEnv> {
	/** How many migrations this boot applied; zero when the database was already current. */
	protected appliedOnBoot = 0;
	/**
	 * Whether this object mirrors workflowy.com: its name is in `OUTLINEDB_ENV_OWNERS`, or its profile was provisioned
	 * as a mirror. Only such an object gets the Workflowy secrets and the sync, so another user's object can never read
	 * or write the owner's account.
	 */
	private isOwner = false;
	/** Persists the Workflowy session cookie in this object's storage; only the owner is seeded from the binding. */
	protected sessionStore!: SessionCookieStore;
	/** Announces ladder writes; every accepted ladder socket receives each event. */
	protected readonly ladderEvents = new LadderEventBus();
	/** Announces `account.changed` to every accepted nodes events socket after a sync or seed rewrote the account tables. */
	protected readonly nodeEvents = new TreeEventBus();
	/** Publishes `account.changed` when the account tables' version moved since the last check. */
	private checkAccount: () => void = () => {};
	/** The one alarm, shared by the sync and the embedding job. */
	private readonly alarms = new AlarmSchedule(this.ctx.storage);
	private sync!: SyncJob;
	/** Keeps the related-notes index current; undefined without the AI and RELATED_INDEX bindings. */
	private embeddings: EmbeddingJob | undefined;
	private db!: ReturnType<typeof drizzle<typeof schema>>;
	private treeSnapshotEnabled = true;
	private store!: StoreClient;

	constructor(ctx: DurableObjectState, env: Env & WorkerSecrets & SyncEnv) {
		super(ctx, env);
		// Rebuilt on every wake, so sockets that survived hibernation are fed again.
		this.ladderEvents.subscribe((event) => {
			const frame = this.ladderEvents.format(event);
			for (const socket of ctx.getWebSockets("ladder")) {
				try {
					socket.send(frame);
				} catch {
					// A socket that just closed must not stop the others.
				}
			}
		});
		this.nodeEvents.subscribe((event) => {
			const frame = JSON.stringify(event);
			for (const socket of ctx.getWebSockets("nodes")) {
				try {
					socket.send(frame);
				} catch {
					// A socket that just closed must not stop the others.
				}
			}
		});
		void ctx.blockConcurrencyWhile(async () => {
			const db = drizzle(ctx.storage, {schema});
			this.db = db;
			const before = countApplied(ctx);
			await migrate(db, doMigrationConfig);
			ensureNodeTags(db);
			this.appliedOnBoot = countApplied(ctx) - before;
			await this.alarms.adoptLegacyAlarm();
			this.checkAccount = accountChangePublisher(this.nodeEvents, () => accountVersion(readAccountRows(db)));
			bindTreeHost(db, {
				// Only this object writes its database, so no other connection can bump the version.
				changeSource: {dataVersion: () => "durable-object", isOpen: () => true},
				scheduler: {
					setTimer(run, delayMs) {
						const timer = setTimeout(run, delayMs);
						return () => {
							clearTimeout(timer);
						};
					},
				},
			});
			this.configure();
		});
	}

	/**
	 * Build everything that depends on whether this object is the owner: the session store, the server context and
	 * its store, the sync and the embedding job. Runs at boot, and again when `provision` makes this object a mirror.
	 */
	private configure(): void {
		const {ctx, env, db} = this;
		this.isOwner = isStoreOwner(ctx.id.name, env) || readProfile(ctx.storage.kv)?.mode === "mirror";
		// A non-owner never seeds, so a later switch to mirror can still copy the binding's cookie in.
		this.sessionStore = this.isOwner
			? kvSessionStore(ctx.storage.kv, env.WORKFLOWY_SESSION_COOKIE)
			: kvSessionStore(ctx.storage.kv, undefined, {seed: false});
		const config = readWorkerConfig(env, this.isOwner);
		this.treeSnapshotEnabled = config.features.treeSnapshot;
		const embedding = config.features.embeddings ? this.embeddingBindings() : undefined;
		const internalAuth = readWorkerInternalAuth(env, this.sessionStore, this.isOwner);
		const serverContext = buildServerContext({
			db,
			config,
			ladderEvents: this.ladderEvents,
			internalAuth,
			embeddingIndex: embedding && (() => embedding.index),
		});
		this.embeddings =
			embedding &&
			new EmbeddingJob({
				storage: ctx.storage,
				db,
				index: embedding.index,
				embedder: embedding.embedder,
				markFinished: async () => this.markEmbeddingsFinished(),
				alarm: this.alarms.for("embeddings"),
			});
		this.store = inProcessStore(serverContext, undefined, {
			keepSnapshotWarm: this.treeSnapshotEnabled,
			keepSwitcherSkeletonWarm: !this.treeSnapshotEnabled,
		});
		this.sync = new SyncJob({
			storage: ctx.storage,
			db,
			env: {...env, WORKFLOWY_API_KEY: config.apiKey},
			readTreeSnapshot:
				internalAuth &&
				(async (signal) =>
					new WorkflowyInternalClient({...internalAuth, fetch: signalled(signal)}).getTreeSnapshot()),
			readAccount:
				internalAuth &&
				(async (signal) => {
					const session = await new WorkflowyInternalClient({
						...internalAuth,
						fetch: signalled(signal),
					}).bootstrap();
					return {userId: session.userId, dateJoinedSec: session.dateJoinedSec};
				}),
			catchUp: internalAuth && (async () => serverContext.internalAdapter?.()?.catchUp()),
			alarm: this.alarms.for("sync"),
		});
	}

	/**
	 * Record which user this object belongs to and its mode, once. A repeat for the same user is a no-op that keeps
	 * the first profile; another user gets 409. Provisioning as a mirror switches this object to mirror at once;
	 * provisioning standalone seeds an empty outline with an Inbox and a welcome.
	 */
	// fallow-ignore-next-line unused-class-member -- the Worker invokes it over RPC
	provision(input: ProvisionInput): ProvisionResult {
		const kv = this.ctx.storage.kv;
		const existing = readProfile(kv);
		if (existing) {
			return existing.userId === input.userId
				? {ok: true, created: false, profile: existing}
				: {ok: false, status: 409, error: "store-provisioned-for-another-user"};
		}
		const profile: Profile = {userId: input.userId, email: input.email, mode: input.mode};
		kv.put(PROFILE_KEYS.email, profile.email);
		kv.put(PROFILE_KEYS.mode, profile.mode);
		// Written last: a profile is present only once its user id is.
		kv.put(PROFILE_KEYS.userId, profile.userId);
		if (profile.mode === "mirror" && !this.isOwner) {
			this.configure();
		}
		// A mirror's nodes come only from workflowy.com, so only a standalone account starts with local content.
		if (profile.mode === "standalone" && !this.isOwner) {
			seedWelcomeContent(this.db);
		}
		return {ok: true, created: true, profile};
	}

	override webSocketClose(socket: WebSocket, code: number): void {
		// 1005 and 1006 are reserved and cannot be echoed back in a close frame.
		socket.close(code === 1005 || code === 1006 ? 1000 : code);
	}

	/**
	 * Vectorize and Workers AI from the bindings, the related-notes index namespaced to this object; the embedding
	 * test overrides it with in-memory fakes, since Miniflare has neither.
	 */
	protected embeddingBindings(): {index: EmbeddingIndex; embedder: Embedder} {
		return {
			index: vectorizeIndex(this.env.RELATED_INDEX, this.ctx.id.toString()),
			embedder: workersAiEmbedder(this.env.AI),
		};
	}

	/** Set `ai.embeddingStatus` to "finished" through the preferences op, so workflowy.com and the cache both see it. */
	protected markEmbeddingsFinished(): Awaitable<void> {
		return this.patchEmbeddingStatus("finished");
	}

	private async patchEmbeddingStatus(aiEmbeddingStatus: string): Promise<void> {
		const result = await this.store.call("preferences.patch", {patch: {aiEmbeddingStatus}});
		if (!result.ok) {
			throw new Error(`Could not set ai.embeddingStatus: ${JSON.stringify(result.body)}`);
		}
	}

	/** Queue embedding work for what changed; a failure is logged and the next write or sync retries the scan. */
	private async noticeEmbeddings(): Promise<void> {
		try {
			await this.embeddings?.notice();
		} catch (error) {
			console.error("Embedding change scan failed", error);
		}
	}

	/** The one entry point for app operations: runs an op over this object's database; errors come back as values. */
	async call<K extends OpName>(op: K, input: OpInput<K>): Promise<OpResult<OpOutput<K>>> {
		try {
			return await this.store.call(op, input);
		} finally {
			await this.noticeEmbeddings();
		}
	}

	/** Start a sync run, or continue the one in progress, on the next alarm. */
	// fallow-ignore-next-line unused-class-member -- the Worker invokes it over RPC
	async syncNow(): Promise<SyncStatus | SyncDisabled> {
		return this.isOwner ? this.sync.syncNow() : SYNC_DISABLED;
	}

	/** Reseed the edge tables from one whole-tree read at the end of the next sync run; the only get_tree_data path. */
	// fallow-ignore-next-line unused-class-member -- the Worker invokes it over RPC
	async seedTree(): Promise<SyncStatus | SyncDisabled> {
		return this.isOwner ? this.sync.seed() : SYNC_DISABLED;
	}

	// fallow-ignore-next-line unused-class-member -- the Worker invokes it over RPC
	async syncStatus(): Promise<SyncStatus> {
		return this.sync.status();
	}

	/** The signed-in user's view of the sync: its phase and how many items the run applied; idle for a standalone. */
	// fallow-ignore-next-line unused-class-member -- the Worker invokes it over RPC
	async accountSync(): Promise<AccountSync> {
		if (!this.isOwner) {
			return {phase: "idle", applied: 0};
		}
		const {phase, applied} = await this.sync.status();
		return {phase, applied};
	}

	/** Database size, live node count, the last sync result and whether the in-memory tree snapshot is held. */
	// fallow-ignore-next-line unused-class-member -- the Worker invokes it over RPC
	async adminStatus(): Promise<AdminStatus> {
		const count = this.ctx.storage.sql
			.exec("SELECT count(*) AS n FROM node_content WHERE system_to = ?", FAR_FUTURE_DATE)
			.one().n;
		return {
			storeName: this.ctx.id.name ?? null,
			mode: this.isOwner ? "mirror" : "standalone",
			profile: readProfile(this.ctx.storage.kv),
			databaseSize: this.ctx.storage.sql.databaseSize,
			nodeCount: Number(count),
			lastSync: (await this.sync.status()).lastResult,
			snapshot: {enabled: this.treeSnapshotEnabled, warm: peekTreeSnapshotRows(this.db) !== undefined},
			embeddings: this.embeddings?.status() ?? null,
		};
	}

	/** The account tables' live rows and the expanded keys. */
	// fallow-ignore-next-line unused-class-member -- the Worker invokes it over RPC
	getAccountState(): AccountState {
		return readAccountState(this.db);
	}

	/** Merge a seed into the account tables in one unit of work; rows already equal keep their versions. */
	// fallow-ignore-next-line unused-class-member -- the Worker invokes it over RPC
	putAccountState(state: AccountState): {rows: number; expandedKeys: number | null} {
		runUnitOfWork(this.db, (unitOfWork) => {
			writeAccountState(unitOfWork, state, Date.now());
		});
		this.checkAccount();
		return {
			rows: accountRowTotal(state.rows),
			expandedKeys: state.expandedKeys?.length ?? null,
		};
	}

	override async alarm(): Promise<void> {
		try {
			// A non-owner's sync slot is cleared without a run: it has nothing to sync from.
			if (this.alarms.take("sync", Date.now()) && this.isOwner) {
				await this.sync.tick();
			}
			await this.noticeEmbeddings();
			if (this.embeddings !== undefined && this.alarms.take("embeddings", Date.now())) {
				await this.embeddings.tick();
			}
		} finally {
			this.checkAccount();
			await this.alarms.arm();
		}
	}

	override fetch(request: Request): Response {
		const tag = EVENT_SOCKET_TAGS[new URL(request.url).pathname];
		if (tag !== undefined && request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
			// The Worker has already checked auth and the upgrade header; hibernation needs the DO to accept the socket.
			const pair = new WebSocketPair();
			this.ctx.acceptWebSocket(pair[1], [tag]);
			return new Response(null, {status: 101, webSocket: pair[0]});
		}
		return new Response("Not found", {status: 404});
	}
}

/** The WebSocket paths the Durable Object accepts, by the tag its broadcasts select sockets with. */
const EVENT_SOCKET_TAGS: Partial<Record<string, string>> = {
	"/api/v1/ladder/events": "ladder",
	"/api/v1/nodes/events": "nodes",
};

export type StoreMode = "mirror" | "standalone";

/** What `GET /api/v1/sync-status` tells the signed-in user about their account's import. */
export type AccountSync = Pick<SyncStatus, "phase" | "applied">;

/** The user an object was provisioned for, and whether it mirrors workflowy.com. */
export interface Profile {
	userId: string;
	email: string;
	mode: StoreMode;
}

export type ProvisionInput = Profile;

export type ProvisionResult =
	| {ok: true; created: boolean; profile: Profile}
	| {ok: false; status: 409; error: "store-provisioned-for-another-user"};

/** The profile's fields, one key each in `ctx.storage.kv`. */
const PROFILE_KEYS = {userId: "profile:userId", email: "profile:email", mode: "profile:mode"} as const;

function readProfile(kv: KvLike): Profile | null {
	const userId = kv.get(PROFILE_KEYS.userId);
	if (userId === undefined) {
		return null;
	}
	return {
		userId,
		email: kv.get(PROFILE_KEYS.email) ?? "",
		mode: kv.get(PROFILE_KEYS.mode) === "mirror" ? "mirror" : "standalone",
	};
}

/** What the sync entry points answer on an object that does not mirror workflowy.com. */
export interface SyncDisabled {
	state: "disabled";
}

const SYNC_DISABLED: SyncDisabled = {state: "disabled"};

export interface AdminStatus {
	/** This object's name, or null when workerd did not give it one. */
	storeName: string | null;
	/** "mirror" for the owner's object, which syncs from and writes through to workflowy.com; "standalone" otherwise. */
	mode: StoreMode;
	/** Whom `provision` gave this object to, or null before it was provisioned. */
	profile: Profile | null;
	databaseSize: number;
	nodeCount: number;
	lastSync: SyncStatus["lastResult"];
	snapshot: {enabled: boolean; warm: boolean};
	/** The related-notes index job, or null without the AI and RELATED_INDEX bindings. */
	embeddings: EmbeddingStatus | null;
}

function countApplied(ctx: DurableObjectState): number {
	const table = ctx.storage.sql
		.exec("SELECT count(*) AS n FROM sqlite_master WHERE name = '__drizzle_migrations'")
		.one().n;
	if (Number(table) === 0) {
		return 0;
	}
	return Number(ctx.storage.sql.exec("SELECT count(*) AS n FROM __drizzle_migrations").one().n);
}

/** A fetch whose every request aborts with `signal`. */
function signalled(signal: AbortSignal): typeof fetch {
	return async (input, init) => fetch(input, {...init, signal});
}
