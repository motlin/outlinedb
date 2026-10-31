import {DurableObject} from "cloudflare:workers";
import {
	accountRowTotal,
	ensureNodeTags,
	readAccountState,
	runUnitOfWork,
	writeAccountState,
} from "@workflowy/shared/cache";
import type {AccountState} from "@workflowy/shared/cache";
import * as schema from "@workflowy/shared/db";
import {
	LadderEventBus,
	bindTreeHost,
	buildServerContext,
	inProcessStore,
	peekTreeSnapshotRows,
} from "@workflowy/web/server-app";
import type {OpInput, OpName, OpOutput, OpResult, StoreClient} from "@workflowy/web/server-app";
import {WorkflowyInternalClient} from "@workflowy/shared/api";
import {drizzle} from "drizzle-orm/durable-sqlite";
import {migrate} from "drizzle-orm/durable-sqlite/migrator";
import {FAR_FUTURE_DATE} from "@workflowy/shared/temporal";
import {doMigrationConfig} from "./do-migrations";
import {kvSessionStore} from "./session-store";
import {SyncJob} from "./sync";
import type {SyncEnv, SyncStatus} from "./sync";
import {readWorkerConfig, readWorkerInternalAuth} from "./worker-config";
import type {WorkerSecrets} from "./worker-config";

/** One user's outline: a SQLite-backed Durable Object answering RPC over its own database, plus the ladder WebSocket upgrade. */
export class UserStore extends DurableObject<Env & WorkerSecrets & SyncEnv> {
	/** How many migrations this boot applied; zero when the database was already current. */
	protected appliedOnBoot = 0;
	/** Persists the Workflowy session cookie in this object's storage. */
	protected readonly sessionStore = kvSessionStore(this.ctx.storage.kv, this.env.WORKFLOWY_SESSION_COOKIE);
	/** Announces ladder writes; every accepted ladder socket receives each event. */
	protected readonly ladderEvents = new LadderEventBus();
	private sync!: SyncJob;
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
		void ctx.blockConcurrencyWhile(async () => {
			const db = drizzle(ctx.storage, {schema});
			this.db = db;
			this.treeSnapshotEnabled = readWorkerConfig(env).features.treeSnapshot;
			const before = countApplied(ctx);
			await migrate(db, doMigrationConfig);
			ensureNodeTags(db);
			this.appliedOnBoot = countApplied(ctx) - before;
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
			const serverContext = buildServerContext({
				db,
				config: readWorkerConfig(env),
				ladderEvents: this.ladderEvents,
				internalAuth: readWorkerInternalAuth(env, this.sessionStore),
			});
			this.store = inProcessStore(serverContext, undefined, {keepSnapshotWarm: this.treeSnapshotEnabled});
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
			});
		});
	}

	override webSocketClose(socket: WebSocket, code: number): void {
		// 1005 and 1006 are reserved and cannot be echoed back in a close frame.
		socket.close(code === 1005 || code === 1006 ? 1000 : code);
	}

	/** The one entry point for app operations: runs an op over this object's database; errors come back as values. */
	// fallow-ignore-next-line unused-class-member -- the Worker invokes it over RPC through `storeClient`
	async call<K extends OpName>(op: K, input: OpInput<K>): Promise<OpResult<OpOutput<K>>> {
		return this.store.call(op, input);
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
		return {
			rows: accountRowTotal(state.rows),
			expandedKeys: state.expandedKeys?.length ?? null,
		};
	}

	override async alarm(): Promise<void> {
		await this.sync.tick();
	}

	override fetch(request: Request): Response {
		if (
			new URL(request.url).pathname === "/api/v1/ladder/events" &&
			request.headers.get("Upgrade")?.toLowerCase() === "websocket"
		) {
			// The Worker has already checked auth and the upgrade header; hibernation needs the DO to accept the socket.
			const pair = new WebSocketPair();
			this.ctx.acceptWebSocket(pair[1], ["ladder"]);
			return new Response(null, {status: 101, webSocket: pair[0]});
		}
		return new Response("Not found", {status: 404});
	}
}

export interface AdminStatus {
	databaseSize: number;
	nodeCount: number;
	lastSync: SyncStatus["lastResult"];
	snapshot: {enabled: boolean; warm: boolean};
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
