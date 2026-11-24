import {DurableObject} from "cloudflare:workers";
import
{
	accountRowTotal,
	accountVersion,
	ensureNodeTags,
	flaggedOutboxCount,
	provisionLocalAccount,
	readAccountRows,
	readAccountState,
	runUnitOfWork,
	writeAccountState,
} from "@outlinedb/shared/cache";
import type {AccountState} from "@outlinedb/shared/cache";
import * as schema from "@outlinedb/shared/db";
import
{
	LadderEventBus,
	TreeEventBus,
	accountChangePublisher,
	bindTreeHost,
	buildServerContext,
	inProcessStore,
	peekTreeSnapshotRows,
	withTreeChangePublish,
} from "@outlinedb/web/server-app";
import type
{
	Awaitable,
	EmbeddingIndex,
	OpInput,
	OpName,
	OpOutput,
	OpResult,
	StoreClient,
} from "@outlinedb/web/server-app";
import
{
	continueWorkflowyLogin,
	MissingCredentialsError,
	parseLoginAttemptState,
	SessionRejectedError,
	startWorkflowyLogin,
	WorkflowyInternalClient,
} from "@outlinedb/shared/api";
import type {InternalAuth, LoginFormField, LoginStepOutcome} from "@outlinedb/shared/api";
import {LoggedOut} from "@outlinedb/shared/internal";
import {drizzle} from "drizzle-orm/durable-sqlite";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import {AlarmSchedule} from "./alarm-schedule";
import {deriveCredentialsKey, openSecret, sealSecret} from "./credentials-crypto";
import {r2BlobStore} from "./blob-store-r2";
import {migrateDurableObject} from "./do-migrations";
import {EmbeddingJob} from "./embedding-job";
import type {EmbeddingStatus} from "./embedding-job";
import {vectorizeIndex, workersAiEmbedder} from "./embeddings";
import type {Embedder} from "./embeddings";
import {meterRows} from "./row-meter";
import {SyncJob} from "./sync";
import {seedWelcomeContent} from "./welcome-content";
import type {SyncEnv, SyncStatus} from "./sync";
import {readWorkerConfig} from "./worker-config";
import type {WorkerSecrets} from "./worker-config";
import {WorkflowyConnection} from "./workflowy-connection";
import type {WorkflowyConnectionStatus} from "./workflowy-connection";
import {WorkflowyLoginAttempt} from "./workflowy-login-attempt";
import {WorkflowyImportJob} from "./workflowy-import";
import {TreeDownloadLog} from "./tree-downloads";
import {UpstreamSignal, connectSignal} from "./upstream-signal";
import type {SignalConnect} from "./upstream-signal";
import type {TreeDownloadCounts} from "./tree-downloads";
import type {WorkflowyImportEnv, WorkflowyImportView} from "./workflowy-import";

/**
 * One user's outline: a SQLite-backed Durable Object answering RPC over its own database, plus the ladder and nodes
 * events WebSocket upgrades.
 */
export class UserStore extends DurableObject<Env & WorkerSecrets & SyncEnv & WorkflowyImportEnv>
{
	/** How many migrations this boot applied; zero when the database was already current. */
	protected appliedOnBoot = 0;
	/** Counts every row this object's SQLite reads and writes, index rows included, as Cloudflare bills them. */
	protected readonly rowMeter = meterRows(this.ctx.storage.sql);
	/**
	 * Whether this account mirrors workflowy.com through its own connection: keep-syncing is on and an import has
	 * landed the tree and transaction id to sync from. Writes then record outbox rows; while the session is expired
	 * they keep queueing until the user signs in again. The only way an account becomes a mirror.
	 */
	private connectionMirror = false;
	/** The connection's opened session cookie, held only in memory while the account keeps syncing. */
	private mirrorCookie: string | undefined;
	/** Set when workflowy.com refused the stored session during this alarm; the alarm pauses sync as it ends. */
	private sessionRefused = false;
	/** Announces ladder writes; every accepted ladder socket receives each event. */
	protected readonly ladderEvents = new LadderEventBus();
	/**
	 * Announces to every accepted nodes events socket: `tree.changed` after an op, drain or catch-up wrote the tree, and
	 * `account.changed` after a sync or seed rewrote the account tables.
	 */
	protected readonly nodeEvents = new TreeEventBus();
	/** Publishes `account.changed` when the account tables' version moved since the last check. */
	private checkAccount: () => void = () =>
	{
	};
	/** The one alarm, shared by the outbox drain, the sync and the embedding job. */
	private readonly alarms = new AlarmSchedule(this.ctx.storage);
	/** This account's own workflowy.com connection, set by the connect flow. */
	protected readonly workflowyConnection = new WorkflowyConnection(this.ctx.storage.sql);
	/** The sign-in to workflowy.com in progress between its form's steps; never holds a password or a code. */
	protected readonly workflowyLoginAttempt = new WorkflowyLoginAttempt(this.ctx.storage.sql);
	/** This account's one-time import from workflowy.com over its own stored session; runs in the shared alarm. */
	private workflowyImport!: WorkflowyImportJob;
	/** Every whole-tree download this object made, counted in GET /api/admin/sync and the daily usage alert. */
	private readonly treeDownloads = new TreeDownloadLog(
		this.ctx.storage.sql,
		this.ctx.id.toString(),
		this.env.TREE_DOWNLOADS,
	);
	/** The import runs whose tree download this instance has under way; a restarted instance starts with none. */
	private readonly importDownloads = new Set<string>();
	/** The session's `wfclientid`, which names its signal channel; undefined unless the account mirrors workflowy.com. */
	private signalClientId: (() => Promise<string | undefined>) | undefined;
	/**
	 * workflowy.com's signal socket, held while a tab shows the outline of an account that syncs: each nudge pulls the
	 * sync alarm to now, so nudges arriving before it runs share one catch-up. Holding an outbound socket keeps the
	 * object awake (billed by wall clock) for as long as a tab stays visible.
	 */
	private readonly signal = new UpstreamSignal(
		{
			connect: async () => this.connectSignal(),
			nudge: () =>
			{
				this.alarms.set("sync", Date.now()).catch((error: unknown) =>
				{
					console.error("arming the catch-up for a workflowy.com nudge failed", error);
				});
			},
			refused: async () =>
			{
				this.workflowyConnection.expire();
				await this.reconfigureSync();
			},
			log: (message) =>
			{
				console.warn(message);
			},
		},
	);
	/** Delivers mirror-mode writes' outbox rows to workflowy.com; undefined without the internal API. */
	protected drainOutbox: (() => Promise<unknown>) | undefined;
	private sync!: SyncJob;
	/** Keeps the related-notes index current; undefined without the AI and RELATED_INDEX bindings. */
	private embeddings: EmbeddingJob | undefined;
	private db!: ReturnType<typeof drizzle<typeof schema>>;
	private treeSnapshotEnabled = true;
	private store!: StoreClient;

	constructor(ctx: DurableObjectState, env: Env & WorkerSecrets & SyncEnv & WorkflowyImportEnv)
	{
		super(ctx, env);
		// Rebuilt on every wake, so sockets that survived hibernation are fed again.
		this.ladderEvents.subscribe((event) =>
		{
			const frame = this.ladderEvents.format(event);
			for (const socket of ctx.getWebSockets("ladder"))
			{
				try
				{
					socket.send(frame);
				}
				catch
				{
					// A socket that just closed must not stop the others.
				}
			}
		});
		this.nodeEvents.subscribe((event) =>
		{
			const frame = JSON.stringify(event);
			for (const socket of ctx.getWebSockets("nodes"))
			{
				try
				{
					socket.send(frame);
				}
				catch
				{
					// A socket that just closed must not stop the others.
				}
			}
		});
		void ctx.blockConcurrencyWhile(async () =>
		{
			const db = drizzle(
				ctx.storage,
				{
					schema,
				},
			);
			this.db = db;
			const before = countApplied(ctx);
			// Throws the failing migration, statement and SQLite message, which reach `wrangler tail` intact.
			migrateDurableObject(ctx.storage);
			ensureNodeTags(db);
			this.appliedOnBoot = countApplied(ctx) - before;
			await this.alarms.adoptLegacyAlarm();
			this.checkAccount = accountChangePublisher(this.nodeEvents, () => accountVersion(readAccountRows(db)));
			bindTreeHost(
				db,
				{
					// Only this object writes its database, so no other connection can bump the version.
					changeSource:
					{
						dataVersion: () => "durable-object",
						isOpen: () => true,
					},
					scheduler:
					{
						setTimer(run, delayMs)
						{
							const timer = setTimeout(run, delayMs);
							return () =>
							{
								clearTimeout(timer);
							};
						},
					},
				},
			);
			this.mirrorCookie = await this.openMirrorSession();
			this.configure();
			if (!this.syncs())
			{
				// An account that stopped syncing (its session expired, or it never kept syncing) drops the sync and drain it
				// had scheduled, instead of waking for them.
				await this.alarms.cancel(["sync", "outbox"]);
			}
		});
	}

	/**
	 * Build everything that depends on whether this account mirrors workflowy.com: the server context and its store,
	 * the sync and the embedding job. Runs at boot, and again whenever the connection or an import changes that.
	 */
	private configure(): void
	{
		const {ctx, env, db} = this;
		// Namespaced by object id like the related-notes index, so one user can never read another's bytes.
		const blobs = r2BlobStore(env.FILES, ctx.id.toString());
		this.workflowyImport = new WorkflowyImportJob(
			{
				storage: ctx.storage,
				db,
				bucket: env.SNAPSHOTS,
				downloading: this.importDownloads,
				blobs,
				keyPrefix: ctx.id.toString(),
				openClient: async () => this.storedSessionClient(),
				expireSession: () =>
				{
					this.workflowyConnection.expire();
				},
				alarm: this.alarms.for("import"),
				rows: () => this.rowMeter.rows(),
				recordDownload: (download) =>
				{
					this.treeDownloads.record(download);
				},
				env,
			},
		);
		const connection = this.workflowyConnection.view();
		const mirrorEmail = connection.connected && connection.mirror ? connection.email : undefined;
		this.connectionMirror = mirrorEmail !== undefined && this.workflowyImport.hasImported();
		const standalone = readWorkerConfig(env);
		const config: typeof standalone = this.connectionMirror
			?
				{
					...standalone,
					mode: "mirror",
					accountEmail: mirrorEmail ?? "",
				}
			: standalone;
		this.treeSnapshotEnabled = config.features.treeSnapshot;
		const embedding = config.features.embeddings ? this.embeddingBindings() : undefined;
		const internalAuth: InternalAuth | undefined = this.connectionMirror
			?
				{
					// No password to log in with: a refused session surfaces, and the alarm pauses sync on it.
					sessionStore:
					{
						read: () => this.mirrorCookie,
						write()
						{
							// Without a password nothing logs in, so no new cookie ever arrives.
						},
						clear()
						{
							// The connection, not the client, decides when the stored cookie goes.
						},
					},
				}
			: undefined;
		const serverContext = buildServerContext(
			{
				db,
				config,
				ladderEvents: this.ladderEvents,
				internalAuth,
				embeddingIndex: embedding && (() => embedding.index),
				blobs,
			},
		);
		// A drain or catch-up that wrote (a push's server run, an edit made on workflowy.com) tells open tabs to read it.
		const announced = async <T>(run: () => Promise<T>): Promise<T> =>
			withTreeChangePublish(db, this.nodeEvents, async () => this.watchSession(run));
		this.drainOutbox =
			internalAuth && (async () => announced(async () => serverContext.internalAdapter?.()?.drainOutbox()));
		this.signalClientId = internalAuth && (async () => serverContext.internalAdapter?.()?.clientId());
		// A mirror-mode write arms the outbox job for now; the request never waits for the drain.
		serverContext.outboxWritten = () =>
		{
			this.alarms.set("outbox", Date.now()).catch((error: unknown) =>
			{
				console.error("arming the outbox drain failed", error);
			});
		};
		this.embeddings =
			embedding &&
			new EmbeddingJob(
				{
					storage: ctx.storage,
					db,
					index: embedding.index,
					embedder: embedding.embedder,
					markFinished: async () => this.markEmbeddingsFinished(),
					alarm: this.alarms.for("embeddings"),
				},
			);
		this.store = inProcessStore(
			serverContext,
			undefined,
			{
				keepSnapshotWarm: this.treeSnapshotEnabled,
				keepSwitcherSkeletonWarm: !this.treeSnapshotEnabled,
				treeEvents: this.nodeEvents,
			},
		);
		this.sync = new SyncJob(
			{
				storage: ctx.storage,
				db,
				env,
				catchUp:
					internalAuth && (async () => announced(async () => serverContext.internalAdapter?.()?.catchUp())),
				alarm: this.alarms.for("sync"),
			},
		);
	}

	/**
	 * Whether the outbox drain and the transaction-log catch-up run: for a connection mirror while its session is
	 * usable and no import is rewriting the tree under them.
	 */
	private syncs(): boolean
	{
		return this.connectionMirror && this.mirrorCookie !== undefined && !this.workflowyImport.running();
	}

	/** Run a drain or catch-up over the stored session, marking the connection expired when workflowy.com refuses it. */
	private async watchSession<T>(run: () => Promise<T>): Promise<T>
	{
		try
		{
			return await run();
		}
		catch (error)
		{
			if (this.connectionMirror && isSessionRefused(error))
			{
				this.workflowyConnection.expire();
				this.sessionRefused = true;
			}
			throw error;
		}
	}

	/**
	 * Rebuild after the connection or an import changed whether this account mirrors workflowy.com: start the sync at
	 * once when it now runs, else drop its scheduled drain and catch-up and let go of the signal socket.
	 */
	private async reconfigureSync(): Promise<void>
	{
		this.mirrorCookie = await this.openMirrorSession();
		this.configure();
		if (!this.syncs())
		{
			await this.alarms.cancel(["sync", "outbox"]);
		}
		else if (this.alarms.due("sync") === null)
		{
			await this.alarms.set("sync", Date.now());
		}
		await this.holdSignal();
	}

	/**
	 * Hold workflowy.com's signal socket while a tab other than `closing` shows the outline of an account whose catch-up
	 * runs, and let go of it otherwise. Opening it catches up at once (unless `catchUp` is false, as when the alarm just
	 * did), for the edits made while no socket listened.
	 */
	private async holdSignal({
		closing,
		catchUp = true,
	}:
	{
		closing?: WebSocket;
		catchUp?: boolean;
	} = {}): Promise<void>
	{
		// Cheapest first: the visibility check reads no rows, while the other two read SQLite.
		if (!(this.outlineVisible(closing) && this.syncs() && !this.sync.needsSeed()))
		{
			this.signal.release();
			return;
		}
		if ((await this.signal.hold()) && catchUp)
		{
			await this.alarms.set("sync", Date.now());
		}
	}

	/** Open the signal socket on the stored session's `wfclientid` channel. */
	private async connectSignal(): Promise<SignalConnect>
	{
		const cookie = this.mirrorCookie;
		const apiUrl = this.env.WORKFLOWY_API_URL;
		let clientId: string | undefined;
		try
		{
			clientId = await this.signalClientId?.();
		}
		catch (error)
		{
			return isSessionRefused(error)
				?
					{
						kind: "refused",
					}
				:
					{
						kind: "failed",
						message: error instanceof Error ? error.message : String(error),
					};
		}
		if (cookie === undefined || clientId === undefined)
		{
			return {
				kind: "failed",
				message: "the account does not sync",
			};
		}
		return connectSignal(
			async (url, init) => this.signalFetch(url, init),
			apiUrl === undefined || apiUrl === "" ? "https://workflowy.com" : apiUrl,
			clientId,
			cookie,
		);
	}

	/** The upgrade request to workflowy.com's signal endpoint; the tests answer it with a socket pair of their own. */
	protected async signalFetch(url: string, init: RequestInit): Promise<Response>
	{
		return fetch(url, init);
	}

	/** The stored session cookie, opened, when the account keeps syncing and its session has not expired. */
	private async openMirrorSession(): Promise<string | undefined>
	{
		const connection = this.workflowyConnection.view();
		return connection.connected && connection.mirror && connection.status === "connected"
			? this.openStoredSession()
			: undefined;
	}

	/** The live stored session cookie, opened with this object's key; undefined when none is stored. */
	private async openStoredSession(): Promise<string | undefined>
	{
		const sealed = this.workflowyConnection.session();
		const secret = this.env.OUTLINEDB_CREDENTIALS_KEY;
		if (sealed === undefined || !secret)
		{
			return undefined;
		}
		return openSecret(await deriveCredentialsKey(secret, this.ctx.id.toString()), sealed);
	}

	/**
	 * A workflowy.com client on this account's stored session, opened with this object's key, and no password to fall
	 * back on: a refused session surfaces instead of logging in again. Undefined when not connected.
	 */
	private async storedSessionClient(): Promise<WorkflowyInternalClient | undefined>
	{
		const cookie = await this.openStoredSession();
		if (cookie === undefined)
		{
			return undefined;
		}
		const apiUrl = this.env.WORKFLOWY_API_URL;
		return new WorkflowyInternalClient(
			{
				sessionStore:
				{
					read: () => cookie,
					write()
					{
						// Without a password nothing logs in, so no new cookie ever arrives.
					},
					clear()
					{
						// The connection, not this client, decides when the stored cookie goes.
					},
				},
				baseUrl: apiUrl === "" ? undefined : apiUrl,
			},
		);
	}

	/**
	 * Record which user this object belongs to, once, and seed its standalone account with an Inbox and the tutorial. A
	 * repeat for the same user is a no-op that keeps the first profile; another user gets 409.
	 */
	// fallow-ignore-next-line unused-class-member -- the Worker invokes it over RPC
	provision(input: ProvisionInput): ProvisionResult
	{
		const kv = this.ctx.storage.kv;
		const existing = readProfile(kv);
		if (existing)
		{
			return existing.userId === input.userId
				?
					{
						ok: true,
						created: false,
						profile: existing,
					}
				:
					{
						ok: false,
						status: 409,
						error: "store-provisioned-for-another-user",
					};
		}
		const profile: Profile =
		{
			userId: input.userId,
			email: input.email,
		};
		kv.put(PROFILE_KEYS.email, profile.email);
		// Written last: a profile is present only once its user id is.
		kv.put(PROFILE_KEYS.userId, profile.userId);
		provisionLocalAccount(
			this.db,
			{
				userId: profile.userId,
				email: profile.email,
				joinedAt: new Date(),
			},
		);
		seedWelcomeContent(this.db);
		return {
			ok: true,
			created: true,
			profile,
		};
	}

	/** This account's workflowy.com connection, without the session cookie. */
	// fallow-ignore-next-line unused-class-member -- the Worker invokes it over RPC
	async getWorkflowyConnection(): Promise<WorkflowyConnectionStatus>
	{
		return this.workflowyConnectionStatus();
	}

	/** The connection with when it last synced: the newest successful import or keep-syncing catch-up. */
	private async workflowyConnectionStatus(): Promise<WorkflowyConnectionStatus>
	{
		const view = this.workflowyConnection.view();
		if (!view.connected)
		{
			return view;
		}
		const run = this.workflowyImport.view().run;
		const lastResult = (await this.sync.status()).lastResult;
		const finished = [
			run?.status === "ok" ? run.finishedAt : null,
			lastResult !== null && "finishedAt" in lastResult ? lastResult.finishedAt : null,
		].filter((at) => at !== null);
		return {
			...view,
			lastSyncAt: finished.length === 0 ? null : Math.max(...finished),
		};
	}

	/**
	 * Start signing in to workflowy.com: open its login form and submit the email, then answer with the fields the form
	 * asks for next. Any attempt already in progress ends.
	 */
	// fallow-ignore-next-line unused-class-member -- the Worker invokes it over RPC
	async startWorkflowyLogin(email: string): Promise<WorkflowyLoginResult>
	{
		const key = await this.credentialsKey();
		if (key === undefined)
		{
			return CREDENTIALS_KEY_NOT_CONFIGURED;
		}
		this.workflowyLoginAttempt.end();
		return this.afterLoginStep(key, crypto.randomUUID(), email, async () =>
			startWorkflowyLogin(email, this.loginRelayOptions()),
		);
	}

	/**
	 * Answer the fields the attempt's form asked for (a password, a code). The answers go to workflowy.com in this one
	 * request and are never stored; once the form ends and its cookie jar reads init data, only that jar is kept, sealed
	 * with this object's key, exactly as a reconnect replaces it.
	 */
	// fallow-ignore-next-line unused-class-member -- the Worker invokes it over RPC
	async continueWorkflowyLogin(attemptId: string, values: Record<string, string>): Promise<WorkflowyLoginResult>
	{
		const key = await this.credentialsKey();
		if (key === undefined)
		{
			return CREDENTIALS_KEY_NOT_CONFIGURED;
		}
		const live = this.workflowyLoginAttempt.live(attemptId);
		const state = live === undefined ? undefined : parseLoginAttemptState(await openSecret(key, live.state));
		if (live === undefined || state === undefined)
		{
			return {
				ok: false,
				status: 409,
				error: "workflowy-login-expired",
			};
		}
		const missing = [...new Set([...state.fields, ...Object.values(state.resend)])].filter(
			(name) => (values[name] ?? "") === "",
		);
		if (missing.length > 0)
		{
			return {
				ok: false,
				status: 400,
				error: "workflowy-login-incomplete",
				message: `Fill in ${missing.join(", ")}`,
			};
		}
		return this.afterLoginStep(key, attemptId, live.email, async () =>
			continueWorkflowyLogin(live.email, state, values, this.loginRelayOptions()),
		);
	}

	/** Start over: end the attempt in progress, if any, without asking workflowy.com anything. */
	// fallow-ignore-next-line unused-class-member -- the Worker invokes it over RPC
	async cancelWorkflowyLogin(): Promise<WorkflowyConnectionStatus>
	{
		this.workflowyLoginAttempt.end();
		return this.workflowyConnectionStatus();
	}

	private async credentialsKey(): Promise<CryptoKey | undefined>
	{
		const secret = this.env.OUTLINEDB_CREDENTIALS_KEY;
		return secret ? deriveCredentialsKey(secret, this.ctx.id.toString()) : undefined;
	}

	private loginRelayOptions():
	{
		baseUrl: string | undefined;
	}
	{
		return {
			baseUrl: this.env.WORKFLOWY_API_URL,
		};
	}

	/**
	 * Run one step of the login form and act on its reply: keep the attempt's sealed state while the form asks for more,
	 * connect once the session it set reads init data, and end the attempt on anything else.
	 */
	private async afterLoginStep(
		key: CryptoKey,
		attemptId: string,
		email: string,
		step: () => Promise<LoginStepOutcome>,
	): Promise<WorkflowyLoginResult>
	{
		let outcome: LoginStepOutcome;
		try
		{
			outcome = await step();
		}
		catch (error)
		{
			outcome =
			{
				kind: "refused",
				message: error instanceof Error ? error.message : String(error),
				detail: "",
			};
		}
		// An expired code cannot be answered again: every later code fails the same way, so the attempt ends.
		if (outcome.kind === "fields" && outcome.errors.some((error) => /expired/iu.test(error)))
		{
			this.workflowyLoginAttempt.end();
			return {
				ok: false,
				status: 409,
				error: "workflowy-login-code-expired",
				message: outcome.errors.join(" "),
				detail: outcome.detail,
			};
		}
		if (outcome.kind === "fields")
		{
			this.workflowyLoginAttempt.save(
				{
					attemptId,
					email,
					state: await sealSecret(key, JSON.stringify(outcome.state)),
				},
			);
			return {
				ok: true,
				attempt:
				{
					attemptId,
					fields: outcome.fields,
					errors: outcome.errors,
					resend: outcome.resend,
					detail: outcome.detail,
				},
			};
		}
		this.workflowyLoginAttempt.end();
		if (outcome.kind === "captcha")
		{
			return {
				ok: false,
				status: 422,
				error: "workflowy-captcha",
				message: "workflowy.com asked for a captcha. Try again later.",
			};
		}
		if (outcome.kind === "unverified")
		{
			return {
				ok: false,
				status: 422,
				error: "workflowy-login-unverified",
				message: "workflowy.com finished the sign-in, but did not accept the session it set.",
				detail: outcome.detail,
			};
		}
		if (outcome.kind === "refused")
		{
			// 422, never 401: the page treats a 401 as signed out of OutlineDB and goes to its login.
			return {
				ok: false,
				status: 422,
				error: "workflowy-login-failed",
				message: outcome.message,
				...(outcome.detail !== "" &&
				{
					detail: outcome.detail,
				}),
			};
		}
		this.workflowyConnection.connect(email, await sealSecret(key, outcome.cookie));
		await this.reconfigureSync();
		return {
			ok: true,
			connection: await this.workflowyConnectionStatus(),
		};
	}

	/**
	 * Turn the account's keep-syncing (two-way mirror) flag on or off; 409 when not connected. On, once an import has
	 * landed, the drain and catch-up start at once over the stored session; off, they stop.
	 */
	// fallow-ignore-next-line unused-class-member -- the Worker invokes it over RPC
	async setWorkflowyMirror(mirror: boolean): Promise<SetWorkflowyMirrorResult>
	{
		if (!this.workflowyConnection.setMirror(mirror))
		{
			return {
				ok: false,
				status: 409,
				error: "workflowy-not-connected",
			};
		}
		await this.reconfigureSync();
		return {
			ok: true,
			connection: await this.workflowyConnectionStatus(),
		};
	}

	/**
	 * Import the whole account from workflowy.com over its stored session on the next alarm (or keep the import in
	 * progress): the tree with its metadata, mirrors, backlinks and completion, and the account tables and expansion.
	 * The imported outline replaces the current one, the tutorial included, with no confirm.
	 */
	// fallow-ignore-next-line unused-class-member -- the Worker invokes it over RPC
	async startWorkflowyImport(): Promise<StartWorkflowyImportResult>
	{
		if (!this.env.OUTLINEDB_CREDENTIALS_KEY)
		{
			return {
				ok: false,
				status: 503,
				error: "credentials-key-not-configured",
			};
		}
		const connection = this.workflowyConnection.view();
		if (!connection.connected)
		{
			return {
				ok: false,
				status: 409,
				error: "workflowy-not-connected",
			};
		}
		if (connection.status === "expired")
		{
			return {
				ok: false,
				status: 409,
				error: "workflowy-session-expired",
			};
		}
		return {
			ok: true,
			import: await this.workflowyImport.start(),
		};
	}

	/** The newest workflowy.com import run: its phase, per-kind counts and failures. */
	// fallow-ignore-next-line unused-class-member -- the Worker invokes it over RPC
	workflowyImportStatus(): WorkflowyImportView
	{
		return this.workflowyImport.view();
	}

	/** Phase the connection out and wipe every stored copy of the session cookie. */
	// fallow-ignore-next-line unused-class-member -- the Worker invokes it over RPC
	async disconnectWorkflowy(): Promise<WorkflowyConnectionStatus>
	{
		this.workflowyConnection.disconnect();
		await this.reconfigureSync();
		return this.workflowyConnectionStatus();
	}

	/**
	 * A nodes socket's `{"type":"visibility","visible"}` frame, sent on open and on every visibility change, kept as the
	 * socket's attachment so it survives hibernation. The first visible tab opens workflowy.com's signal socket, and
	 * the last one to hide closes it.
	 */
	override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void>
	{
		const visible = visibilityFrame(message);
		if (visible === undefined)
		{
			return;
		}
		socket.serializeAttachment(
			{
				visible,
			},
		);
		await this.holdSignal();
	}

	/** Whether any open nodes socket but `closing` has a tab showing the outline now. */
	private outlineVisible(closing?: WebSocket): boolean
	{
		return this.ctx
			.getWebSockets("nodes")
			.some(
				(socket) =>
					socket !== closing && Reflect.get(Object(socket.deserializeAttachment()), "visible") === true,
			);
	}

	override async webSocketClose(socket: WebSocket, code: number): Promise<void>
	{
		// 1005 and 1006 are reserved and cannot be echoed back in a close frame.
		socket.close(code === 1005 || code === 1006 ? 1000 : code);
		await this.holdSignal(
			{
				closing: socket,
			},
		);
	}

	/**
	 * Vectorize and Workers AI from the bindings, the related-notes index namespaced to this object; the embedding
	 * test overrides it with in-memory fakes, since Miniflare has neither.
	 */
	protected embeddingBindings():
	{
		index: EmbeddingIndex;
		embedder: Embedder;
	}
	{
		return {
			index: vectorizeIndex(this.env.RELATED_INDEX, this.ctx.id.toString()),
			embedder: workersAiEmbedder(this.env.AI),
		};
	}

	/** Set `ai.embeddingStatus` to "finished" through the preferences op, so workflowy.com and the cache both see it. */
	protected markEmbeddingsFinished(): Awaitable<void>
	{
		return this.patchEmbeddingStatus("finished");
	}

	private async patchEmbeddingStatus(aiEmbeddingStatus: string): Promise<void>
	{
		const result = await this.store.call(
			"preferences.patch",
			{
				patch:
				{
					aiEmbeddingStatus,
				},
			},
		);
		if (!result.ok)
		{
			throw new Error(`Could not set ai.embeddingStatus: ${JSON.stringify(result.body)}`);
		}
	}

	/** Queue embedding work for what changed; a failure is logged and the next write or sync retries the scan. */
	private async noticeEmbeddings(): Promise<void>
	{
		try
		{
			await this.embeddings?.notice();
		}
		catch (error)
		{
			console.error("Embedding change scan failed", error);
		}
	}

	/** The one entry point for app operations: runs an op over this object's database; errors come back as values. */
	async call<K extends OpName>(op: K, input: OpInput<K>): Promise<OpResult<OpOutput<K>>>
	{
		try
		{
			return await this.store.call(op, input);
		}
		finally
		{
			await this.noticeEmbeddings();
		}
	}

	// fallow-ignore-next-line unused-class-member -- the Worker invokes it over RPC
	async syncStatus(): Promise<AdminSyncStatus>
	{
		return {
			...(await this.sync.status()),
			treeDownloads: this.treeDownloads.counts(),
		};
	}

	/**
	 * The signed-in user's view of the sync: `needs_seed` with its error once a connection mirror's catch-up stopped for
	 * good, else idle.
	 */
	// fallow-ignore-next-line unused-class-member -- the Worker invokes it over RPC
	async accountSync(): Promise<AccountSync>
	{
		const lastResult = this.connectionMirror ? (await this.sync.status()).lastResult : null;
		const unconfirmed = flaggedOutboxCount(this.db);
		const unconfirmedWrites =
			unconfirmed > 0
				?
					{
						unconfirmedWrites: unconfirmed,
					}
				: {};
		return lastResult?.status === "needs_seed"
			?
				{
					phase: "needs_seed",
					applied: 0,
					error: lastResult.message,
					...unconfirmedWrites,
				}
			:
				{
					phase: "idle",
					applied: 0,
					...unconfirmedWrites,
				};
	}

	/** Database size, live node count, the last sync result and whether the in-memory tree snapshot is held. */
	// fallow-ignore-next-line unused-class-member -- the Worker invokes it over RPC
	async adminStatus(): Promise<AdminStatus>
	{
		const count = this.ctx.storage.sql
			.exec("SELECT count(*) AS n FROM node_content WHERE system_to = ?", FAR_FUTURE_DATE)
			.one().n;
		return {
			storeName: this.ctx.id.name ?? null,
			mode: this.connectionMirror ? "mirror" : "standalone",
			profile: readProfile(this.ctx.storage.kv),
			databaseSize: this.ctx.storage.sql.databaseSize,
			nodeCount: Number(count),
			lastSync: (await this.sync.status()).lastResult,
			snapshot:
			{
				enabled: this.treeSnapshotEnabled,
				warm: peekTreeSnapshotRows(this.db) !== undefined,
			},
			embeddings: this.embeddings?.status() ?? null,
		};
	}

	/** The account tables' live rows and the expanded keys. */
	// fallow-ignore-next-line unused-class-member -- the Worker invokes it over RPC
	getAccountState(): AccountState
	{
		return readAccountState(this.db);
	}

	/** Merge a seed into the account tables in one unit of work; rows already equal keep their versions. */
	// fallow-ignore-next-line unused-class-member -- the Worker invokes it over RPC
	putAccountState(state: AccountState):
	{
		rows: number;
		expandedKeys: number | null;
	}
	{
		runUnitOfWork(this.db, (unitOfWork) =>
		{
			writeAccountState(unitOfWork, state, Date.now());
		});
		this.checkAccount();
		return {
			rows: accountRowTotal(state.rows),
			expandedKeys: state.expandedKeys?.length ?? null,
		};
	}

	override async alarm(): Promise<void>
	{
		try
		{
			// Outbox before sync, so a catch-up starts from a drained outbox; a scheduled sync tick is also a drain trigger
			// (approved 2026-11-15), and a drain with nothing pending sends nothing. An object that does not sync clears its
			// outbox and sync slots without a run: a standalone never enqueues, and a paused mirror's rows wait for sign-in.
			const due = this.alarms.takeDue(Date.now());
			const syncs = this.syncs();
			// Read only when the import ticks, so an alarm without one spends no rows on it.
			const importing = due.includes("import") && this.workflowyImport.running();
			// A sync that needs a seed cannot drain either, so the outbox waits for the seed instead of failing each write.
			if (
				(due.includes("outbox") || due.includes("sync")) &&
				syncs &&
				this.drainOutbox !== undefined &&
				!this.sync.needsSeed()
			)
			{
				try
				{
					await this.drainOutbox();
				}
				catch (error)
				{
					// The rows keep last_error and stay pending for the next trigger; the sync status reports them.
					console.error("outbox drain failed", error);
				}
			}
			if (due.includes("sync") && syncs && !this.sessionRefused)
			{
				await this.sync.tick();
			}
			if (due.includes("import"))
			{
				await this.workflowyImport.tick();
			}
			// A refused session pauses sync until the user signs in again; a finished import may start the mirror.
			if (this.sessionRefused || (importing && !this.workflowyImport.running()))
			{
				this.sessionRefused = false;
				await this.reconfigureSync();
			}
			// The hourly catch-up reopens a signal socket that dropped while a tab stayed visible, without catching up again.
			if (due.includes("sync"))
			{
				await this.holdSignal(
					{
						catchUp: false,
					},
				);
			}
			await this.noticeEmbeddings();
			if (
				this.embeddings !== undefined &&
				(due.includes("embeddings") || this.alarms.take("embeddings", Date.now()))
			)
			{
				await this.embeddings.tick();
			}
		}
		finally
		{
			this.checkAccount();
			await this.alarms.arm();
		}
	}

	override fetch(request: Request): Response
	{
		const tag = EVENT_SOCKET_TAGS[new URL(request.url).pathname];
		if (tag !== undefined && request.headers.get("Upgrade")?.toLowerCase() === "websocket")
		{
			// The Worker has already checked auth and the upgrade header; hibernation needs the DO to accept the socket.
			const pair = new WebSocketPair();
			this.ctx.acceptWebSocket(pair[1], [tag]);
			return new Response(
				null,
				{
					status: 101,
					webSocket: pair[0],
				},
			);
		}
		return new Response(
			"Not found",
			{
				status: 404,
			},
		);
	}
}

/** A `{"type":"visibility","visible":boolean}` frame's flag, or undefined for any other message. */
function visibilityFrame(message: string | ArrayBuffer): boolean | undefined
{
	if (typeof message !== "string")
	{
		return undefined;
	}
	try
	{
		const frame: unknown = JSON.parse(message);
		const visible: unknown = Reflect.get(Object(frame), "visible");
		return Reflect.get(Object(frame), "type") === "visibility" && typeof visible === "boolean"
			? visible
			: undefined;
	}
	catch
	{
		return undefined;
	}
}

/** The WebSocket paths the Durable Object accepts, by the tag its broadcasts select sockets with. */
const EVENT_SOCKET_TAGS: Partial<Record<string, string>> =
{
	"/api/v1/ladder/events": "ladder",
	"/api/v1/nodes/events": "nodes",
};

export type StoreMode = "mirror" | "standalone";

/** What `GET /api/v1/sync-status` tells the signed-in user about their account's sync. */
export type AccountSync = (
	|
	  {
			phase: "idle";
			applied: number;
	  }
	|
	  {
			/** The catch-up stopped because only a new import can fix what failed; nothing retries it on a schedule. */
			phase: "needs_seed";
			applied: number;
			error: string;
	  }
) &
{
	/**
	 * Local writes pushed to workflowy.com whose reply left their ops out: no longer sent, kept open until a catch-up
	 * shows them. Absent when there are none.
	 */
	unconfirmedWrites?: number;
};

/** The user an object was provisioned for. */
export interface Profile
{
	userId: string;
	email: string;
}

export type ProvisionInput = Profile;

export type ProvisionResult =
	|
	  {
			ok: true;
			created: boolean;
			profile: Profile;
	  }
	|
	  {
			ok: false;
			status: 409;
			error: "store-provisioned-for-another-user";
	  };

/** The profile's fields, one key each in `ctx.storage.kv`. */
const PROFILE_KEYS =
{
	userId: "profile:userId",
	email: "profile:email",
} as const;

/** The synchronous key-value surface of `DurableObjectStorage.kv`. */
interface KvLike
{
	get(key: string): string | undefined;
}

function readProfile(kv: KvLike): Profile | null
{
	const userId = kv.get(PROFILE_KEYS.userId);
	if (userId === undefined)
	{
		return null;
	}
	return {
		userId,
		email: kv.get(PROFILE_KEYS.email) ?? "",
	};
}

const CREDENTIALS_KEY_NOT_CONFIGURED =
{
	ok: false,
	status: 503,
	error: "credentials-key-not-configured",
} as const;

/** A login form step that wants more: the attempt to answer and the fields its form asks for, with its errors. */
export interface WorkflowyLoginAttemptView
{
	attemptId: string;
	fields: LoginFormField[];
	/** The form's error list, such as a wrong password; the person answers again. */
	errors: string[];
	/** Fields answered earlier whose answers the next step sends again, because the form echoed them back. */
	resend: string[];
	/** Each request so far (method, path, the form's names, status, redirect, cookie names) and the jar's names. */
	detail: string;
}

export type WorkflowyLoginResult =
	|
	  {
			ok: true;
			connection: WorkflowyConnectionStatus;
	  }
	|
	  {
			ok: true;
			attempt: WorkflowyLoginAttemptView;
	  }
	| typeof CREDENTIALS_KEY_NOT_CONFIGURED
	|
	  {
			ok: false;
			status: 400;
			error: "workflowy-login-incomplete";
			message: string;
	  }
	|
	  {
			ok: false;
			status: 409;
			error: "workflowy-login-expired";
	  }
	|
	  {
			ok: false;
			status: 409;
			error: "workflowy-login-code-expired";
			/** workflowy.com's error list. */
			message: string;
			detail: string;
	  }
	|
	  {
			ok: false;
			status: 422;
			error: "workflowy-captcha";
			message: string;
	  }
	|
	  {
			ok: false;
			status: 422;
			error: "workflowy-login-failed";
			message: string;
			/** workflowy.com's own reply (status and redacted text), when it answered unexpectedly. */
			detail?: string;
	  }
	|
	  {
			ok: false;
			status: 422;
			error: "workflowy-login-unverified";
			message: string;
			/** Each login request's status, redirect path and cookie names, the jar's names and init data's answer. */
			detail: string;
	  };

export type StartWorkflowyImportResult =
	|
	  {
			ok: true;
			import: WorkflowyImportView;
	  }
	|
	  {
			ok: false;
			status: 503;
			error: "credentials-key-not-configured";
	  }
	|
	  {
			ok: false;
			status: 409;
			error: "workflowy-not-connected" | "workflowy-session-expired";
	  };

export type SetWorkflowyMirrorResult =
	|
	  {
			ok: true;
			connection: WorkflowyConnectionStatus;
	  }
	|
	  {
			ok: false;
			status: 409;
			error: "workflowy-not-connected";
	  };

/** GET /api/admin/sync: the sync job's status and the object's whole-tree downloads. */
export interface AdminSyncStatus extends SyncStatus
{
	treeDownloads: TreeDownloadCounts;
}

export interface AdminStatus
{
	/** This object's name, or null when workerd did not give it one. */
	storeName: string | null;
	/** "mirror" while the account's own connection keeps syncing with workflowy.com; "standalone" otherwise. */
	mode: StoreMode;
	/** Whom `provision` gave this object to, or null before it was provisioned. */
	profile: Profile | null;
	databaseSize: number;
	nodeCount: number;
	lastSync: SyncStatus["lastResult"];
	snapshot:
	{
		enabled: boolean;
		warm: boolean;
	};
	/** The related-notes index job, or null without the AI and RELATED_INDEX bindings. */
	embeddings: EmbeddingStatus | null;
}

function countApplied(ctx: DurableObjectState): number
{
	const table = ctx.storage.sql
		.exec("SELECT count(*) AS n FROM sqlite_master WHERE name = '__drizzle_migrations'")
		.one().n;
	if (Number(table) === 0)
	{
		return 0;
	}
	return Number(ctx.storage.sql.exec("SELECT count(*) AS n FROM __drizzle_migrations").one().n);
}

/**
 * Whether workflowy.com refused the stored session, anywhere in the error's cause chain: a redirect or `logged_out`
 * answer, or no session saved at all.
 */
function isSessionRefused(error: unknown): boolean
{
	for (let current = error; current instanceof Error; current = current.cause)
	{
		if (
			current instanceof MissingCredentialsError ||
			current instanceof SessionRejectedError ||
			current instanceof LoggedOut
		)
		{
			return true;
		}
	}
	return false;
}
