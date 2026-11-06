import {DurableObject} from "cloudflare:workers";
import {
	accountRowTotal,
	accountVersion,
	ensureNodeTags,
	readAccountRows,
	readAccountState,
	runUnitOfWork,
	writeAccountState,
} from "@workflowy/shared/cache";
import type {AccountState} from "@workflowy/shared/cache";
import * as schema from "@workflowy/shared/db";
import {
	LadderEventBus,
	TreeEventBus,
	accountChangePublisher,
	bindTreeHost,
	buildServerContext,
	inProcessStore,
	peekTreeSnapshotRows,
} from "@workflowy/web/server-app";
import type {
	Awaitable,
	EmbeddingIndex,
	OpInput,
	OpName,
	OpOutput,
	OpResult,
	StoreClient,
} from "@workflowy/web/server-app";
import {WorkflowyInternalClient} from "@workflowy/shared/api";
import {drizzle} from "drizzle-orm/durable-sqlite";
import {migrate} from "drizzle-orm/durable-sqlite/migrator";
import {FAR_FUTURE_DATE} from "@workflowy/shared/temporal";
import {AlarmSchedule} from "./alarm-schedule";
import {doMigrationConfig} from "./do-migrations";
import {EmbeddingJob} from "./embedding-job";
import type {EmbeddingStatus} from "./embedding-job";
import {vectorizeIndex, workersAiEmbedder} from "./embeddings";
import type {Embedder} from "./embeddings";
import {kvSessionStore} from "./session-store";
import {SyncJob} from "./sync";
import type {SyncEnv, SyncStatus} from "./sync";
import {readWorkerConfig, readWorkerInternalAuth} from "./worker-config";
import type {WorkerSecrets} from "./worker-config";

/**
 * One user's outline: a SQLite-backed Durable Object answering RPC over its own database, plus the ladder and nodes
 * events WebSocket upgrades.
 */
export class UserStore extends DurableObject<Env & WorkerSecrets & SyncEnv> {
	/** How many migrations this boot applied; zero when the database was already current. */
	protected appliedOnBoot = 0;
	/** Persists the Workflowy session cookie in this object's storage. */
	protected readonly sessionStore = kvSessionStore(this.ctx.storage.kv, this.env.WORKFLOWY_SESSION_COOKIE);
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
			this.treeSnapshotEnabled = readWorkerConfig(env).features.treeSnapshot;
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
			const config = readWorkerConfig(env);
			const embedding = config.features.embeddings ? this.embeddingBindings() : undefined;
			const serverContext = buildServerContext({
				db,
				config,
				ladderEvents: this.ladderEvents,
				internalAuth: readWorkerInternalAuth(env, this.sessionStore),
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
			const internalAuth = readWorkerInternalAuth(env, this.sessionStore);
			this.sync = new SyncJob({
				storage: ctx.storage,
				db,
				env,
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
		});
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
	async syncNow(): Promise<SyncStatus> {
		return this.sync.syncNow();
	}

	/** Reseed the edge tables from one whole-tree read at the end of the next sync run; the only get_tree_data path. */
	// fallow-ignore-next-line unused-class-member -- the Worker invokes it over RPC
	async seedTree(): Promise<SyncStatus> {
		return this.sync.seed();
	}

	// fallow-ignore-next-line unused-class-member -- the Worker invokes it over RPC
	async syncStatus(): Promise<SyncStatus> {
		return this.sync.status();
	}

	/** Database size, live node count, the last sync result and whether the in-memory tree snapshot is held. */
	// fallow-ignore-next-line unused-class-member -- the Worker invokes it over RPC
	async adminStatus(): Promise<AdminStatus> {
		const count = this.ctx.storage.sql
			.exec("SELECT count(*) AS n FROM node_content WHERE system_to = ?", FAR_FUTURE_DATE)
			.one().n;
		return {
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
			if (this.alarms.take("sync", Date.now())) {
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

export interface AdminStatus {
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
