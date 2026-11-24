import
{
	ACCOUNT_IMPORT_NAME,
	accountRows,
	applyApiBatch,
	beginApiImport,
	closeCurrentVersions,
	finishApiImport,
	importInternalMetadata,
	markApplied,
	newSystemTimestamp,
	runUnitOfWork,
	stampImportTime,
	treeDataNode,
	writeAccountSnapshot,
} from "@outlinedb/shared/cache";
import type {AccountSnapshot, ApiImportState} from "@outlinedb/shared/cache";
import {MissingCredentialsError, SessionRejectedError} from "@outlinedb/shared/api";
import type
{
	InternalSession,
	InternalTreeItem,
	TreeDataItem,
	TreeDataTail,
	WorkflowyInternalClient,
} from "@outlinedb/shared/api";
import {fileBlobs, s3Files} from "@outlinedb/shared/db";
import type {AppDatabase} from "@outlinedb/shared/db";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import type {WorkflowyNode} from "@outlinedb/shared/types";
import {blobKey, sha256Hex} from "@outlinedb/web/server-app";
import type {BlobStore} from "@outlinedb/web/server-app";
import {and, asc, eq, gt, isNull, or} from "drizzle-orm";
import type {ScheduledJobAlarm} from "./alarm-schedule";
import {deleteR2Prefix} from "./blob-store-r2";
import type {RowCounts} from "./row-meter";
import type {TreeDownload} from "./tree-downloads";

const BATCH_SIZE = 2000;
/** An alarm run stops applying batches, and leaves the rest to a fresh run, once this much time is spent. */
const RUN_BUDGET_MS = 30_000;
/** The attachment the files phase starts after: every node id sorts after the empty string. */
const FIRST_FILE = "";
/** Why a run whose tree download died with an earlier instance of its object failed. */
const DOWNLOAD_INTERRUPTED = "the tree download ran out of memory or was interrupted; not retried";

/**
 * Each per-account import run, temporal like every other table: one version per alarm run, the newest live. A run
 * keeps what it found upstream per kind, what the node merge changed, what it could not import, and how copying the
 * attachments' bytes went, all as typed columns. `files_cursor` is the last attachment node id the files phase tried,
 * so a resumed alarm run never tries one twice. The fetched tree waits in R2 between alarm runs, in chunks of one
 * batch each; nothing of it is stored here.
 */
const IMPORT_TABLE = `
CREATE TABLE IF NOT EXISTS workflowy_imports (
	run_id TEXT NOT NULL,
	phase TEXT NOT NULL,
	applied INTEGER NOT NULL,
	started_at INTEGER NOT NULL,
	snapshot_at INTEGER,
	owner_id INTEGER,
	status TEXT NOT NULL,
	message TEXT,
	finished_at INTEGER,
	found_nodes INTEGER NOT NULL,
	found_completed INTEGER NOT NULL,
	found_mirrors INTEGER NOT NULL,
	found_backlinks INTEGER NOT NULL,
	found_expanded_keys INTEGER NOT NULL,
	found_stars INTEGER NOT NULL,
	found_star_order INTEGER NOT NULL,
	found_tag_colors INTEGER NOT NULL,
	found_saved_views INTEGER NOT NULL,
	found_settings INTEGER NOT NULL,
	nodes_added INTEGER NOT NULL,
	nodes_updated INTEGER NOT NULL,
	nodes_unchanged INTEGER NOT NULL,
	nodes_phased_out INTEGER NOT NULL,
	metadata_written INTEGER NOT NULL,
	invalid_nodes INTEGER NOT NULL,
	metadata_skipped INTEGER NOT NULL,
	files_found INTEGER NOT NULL,
	files_copied INTEGER NOT NULL,
	files_already_copied INTEGER NOT NULL,
	files_failed INTEGER NOT NULL,
	files_bytes INTEGER NOT NULL,
	files_cursor TEXT NOT NULL,
	rows_read INTEGER NOT NULL,
	rows_written INTEGER NOT NULL,
	system_from INTEGER NOT NULL,
	system_to INTEGER NOT NULL,
	PRIMARY KEY (run_id, system_from)
);
CREATE UNIQUE INDEX IF NOT EXISTS workflowy_imports_system_to_idx ON workflowy_imports (run_id, system_to);
CREATE INDEX IF NOT EXISTS workflowy_imports_closed_at_idx ON workflowy_imports (system_to)
	WHERE system_to < ${String(FAR_FUTURE_DATE)};
`;

/**
 * `queued`: waiting for its first alarm run. `fetching`: an alarm run is downloading the tree; set before the download
 * starts, so a run found fetching by an object instance that is not downloading it died mid-download.
 */
type Phase = "idle" | "queued" | "fetching" | "importing" | "files";

/** `expired`: workflowy.com refused the stored session, so the connection waits for the user to sign in again. */
type ImportStatus = "running" | "ok" | "error" | "expired";

/** What the run found on workflowy.com, by kind; every kind it found is what it imports. */
export interface ImportFound
{
	nodes: number;
	completed: number;
	mirrors: number;
	backlinks: number;
	expandedKeys: number;
	stars: number;
	starOrder: number;
	tagColors: number;
	savedViews: number;
	settings: number;
}

/** What the node merge changed: the outline found upstream replaces whatever was here, the tutorial included. */
export interface ImportNodeChanges
{
	added: number;
	updated: number;
	unchanged: number;
	phasedOut: number;
	metadataWritten: number;
}

/** What the run could not import, by kind. */
export interface ImportFailures
{
	/** Items whose node fields failed validation; left out. */
	invalidNodes: number;
	/** Items whose metadata belongs to a node the import left out. */
	metadataSkipped: number;
}

/** One attachment whose bytes the import could not copy, with why. */
export interface ImportFileFailure
{
	nodeId: string;
	fileName: string;
	error: string;
}

/**
 * Copying each live attachment's bytes from workflowy.com into R2. A re-import skips the ones already copied and
 * tries the ones that failed before once more; nothing is retried within a run.
 */
export interface ImportFiles
{
	/** Live (not deleted) attachments in the imported tree. */
	found: number;
	copied: number;
	/** Attachments an earlier import already copied; left as they are. */
	alreadyCopied: number;
	failed: number;
	/** Bytes this run copied. */
	bytes: number;
}

/** One import run, as the account sees it. */
export interface WorkflowyImportRun
{
	phase: Phase;
	status: ImportStatus;
	message: string | null;
	startedAt: number;
	finishedAt: number | null;
	/** Nodes of the fetched tree applied so far; a resumed alarm run continues after them. */
	applied: number;
	found: ImportFound;
	nodes: ImportNodeChanges;
	failures: ImportFailures;
	files: ImportFiles;
	rowsRead: number;
	rowsWritten: number;
}

export interface WorkflowyImportView
{
	/**
	 * The newest run, or null before the first import; `files.failures` lists each live attachment whose newest copy
	 * attempt failed.
	 */
	run:
		| (Omit<WorkflowyImportRun, "files"> &
		  {
				files: ImportFiles &
				{
					failures: ImportFileFailure[];
				};
		  })
		| null;
}

/** What the import job needs from its Durable Object. */
export interface WorkflowyImportDeps
{
	storage: DurableObjectStorage;
	db: AppDatabase;
	/** Holds the fetched tree between alarm runs, under {@link keyPrefix}. */
	bucket: R2Bucket;
	/**
	 * The runs whose tree download this instance of the object has under way. Owned by the object instance, so an
	 * instance that restarted (out of memory, a deploy) holds none, whatever import jobs it rebuilds.
	 */
	downloading: Set<string>;
	/** Where the attachments' bytes land: the object's own blob store, which serves them from then on. */
	blobs: BlobStore;
	/** Downloads an attachment's bytes from the signed URL workflowy.com mints (default: the global fetch). */
	fetch?: typeof fetch;
	/** Namespaces this object's R2 keys, so one account never reads another's fetched tree. */
	keyPrefix: string;
	/** A client on the account's stored session, with no password to fall back on; undefined when not connected. */
	openClient: () => Promise<WorkflowyInternalClient | undefined>;
	/** Mark the connection expired once workflowy.com refused its session. */
	expireSession: () => void;
	alarm: ScheduledJobAlarm;
	/** Rows the object's SQLite has read and written so far, index rows included. */
	rows?: () => RowCounts;
	/** Records each whole-tree download, whether it finished or failed part way. */
	recordDownload: (download: TreeDownload) => void;
	env: WorkflowyImportEnv;
	now?: () => number;
}

/** Tuning knobs the import reads from the Worker's bindings; all optional. */
export interface WorkflowyImportEnv
{
	/** Nodes applied per batch (default {@link BATCH_SIZE}). */
	SYNC_BATCH_SIZE?: string;
	/** Batches applied per alarm run before yielding (default: all within the run budget). */
	SYNC_BATCHES_PER_TICK?: string;
	/** Delay before the next alarm run when one yields mid-import (default 0). */
	SYNC_TICK_DELAY_MS?: string;
	/** Attachments copied per alarm run before yielding (default: all within the run budget). */
	IMPORT_FILES_PER_TICK?: string;
}

interface Job extends WorkflowyImportRun
{
	runId: string;
	snapshotAt: number | null;
	/** The workflowy.com tree owner the signed file URLs name; set by the fetch. */
	ownerId: number | null;
	filesCursor: string;
}

/** One batch of the fetched tree, as parked in R2: its export nodes, and each item's id and metadata. */
interface ParkedChunk
{
	nodes: WorkflowyNode[];
	items: InternalTreeItem[];
}

/** The fetched tree's transaction id and expanded keys, and how it was cut into chunks, as parked in R2. */
interface ParkedTree extends TreeDataTail
{
	chunkSize: number;
	chunks: number;
}

/** What the download counts of the items it reads, by kind. */
interface ItemCounts
{
	nodes: number;
	completed: number;
	mirrors: number;
	backlinks: number;
}

/** One live attachment the files phase copies. */
interface LiveFile
{
	nodeId: string;
	fileName: string;
	fileType: string;
}

const NO_ROWS: RowCounts =
{
	rowsRead: 0,
	rowsWritten: 0,
};

const NONE_FOUND: ImportFound =
{
	nodes: 0,
	completed: 0,
	mirrors: 0,
	backlinks: 0,
	expandedKeys: 0,
	stars: 0,
	starOrder: 0,
	tagColors: 0,
	savedViews: 0,
	settings: 0,
};

const NO_CHANGES: ImportNodeChanges =
{
	added: 0,
	updated: 0,
	unchanged: 0,
	phasedOut: 0,
	metadataWritten: 0,
};

const NO_FAILURES: ImportFailures =
{
	invalidNodes: 0,
	metadataSkipped: 0,
};

const NO_FILES: ImportFiles =
{
	found: 0,
	copied: 0,
	alreadyCopied: 0,
	failed: 0,
	bytes: 0,
};

/** workflowy.com refused the stored session mid-run: the run ends expired, not failed. */
class SessionExpired extends Error
{
}

/**
 * The account's one-time import from workflowy.com over its own stored session: one alarm run streams the account and
 * the whole tree into R2 in chunks of one batch, never holding the tree whole, later ones apply the chunks through the
 * export import path, and the last one ends
 * every node the tree does not hold (the tutorial outline among them, with no confirm), merges mirrors, backlinks and
 * item metadata, and replaces the account tables and expansion. Then it copies each live attachment's bytes into the
 * object's blob store, recording a `file_blobs` version that points the node at our copy. All progress lives in this
 * object's SQLite, so a restart resumes the run, except mid-download: a download that died with its object instance
 * fails the run rather than start again. Nothing is retried: a failed run stays failed until the user starts another,
 * and a file that failed is tried again only by the next import.
 */
export class WorkflowyImportJob
{
	/** The system time of the alarm run in progress: every version it writes takes this one value. */
	private systemTime = newSystemTimestamp();
	private rowsAtTick: RowCounts = NO_ROWS;
	private tickStartedAt = Date.now();

	constructor(private readonly deps: WorkflowyImportDeps)
	{
		deps.storage.sql.exec(IMPORT_TABLE);
	}

	private get sql(): SqlStorage
	{
		return this.deps.storage.sql;
	}

	private now(): number
	{
		return (this.deps.now ?? Date.now)();
	}

	private rows(): RowCounts
	{
		return this.deps.rows?.() ?? NO_ROWS;
	}

	/** Where this account's runs park what they fetched, each under its own run id. */
	private get parkedRoot(): string
	{
		return `imports/${this.deps.keyPrefix}/`;
	}

	/** Where the run parks what it fetched: every key under it is the run's, and the finish drops them all. */
	private prefix(runId: string): string
	{
		return `${this.parkedRoot}${runId}/`;
	}

	/** Delete what every run of this account ever parked in R2, as deleting the account does. */
	async dropAllParked(): Promise<void>
	{
		await deleteR2Prefix(this.deps.bucket, this.parkedRoot);
	}

	private key(job: Job, name: "tree" | "account"): string
	{
		return `${this.prefix(job.runId)}${name}.json`;
	}

	private chunkKey(job: Job, index: number): string
	{
		return `${this.prefix(job.runId)}chunks/${String(index)}.json`;
	}

	private newestJob(): Job | null
	{
		const row = this.sql
			.exec(
				"SELECT * FROM workflowy_imports WHERE system_to = ? ORDER BY started_at DESC, system_from DESC LIMIT 1",
				FAR_FUTURE_DATE,
			)
			.toArray()[0];
		return row === undefined ? null : jobFromRow(row);
	}

	private runningJob(): Job | null
	{
		const job = this.newestJob();
		return job?.status === "running" ? job : null;
	}

	/**
	 * The newest run, once a run whose download died with an earlier instance of this object is marked failed: it is
	 * never fetched again, since another download would most likely die the same way.
	 */
	private currentJob(): Job | null
	{
		const job = this.newestJob();
		if (job?.status !== "running" || job.phase !== "fetching" || this.deps.downloading.has(job.runId))
		{
			return job;
		}
		this.beginTick();
		const failed: Job =
		{
			...job,
			phase: "idle",
			status: "error",
			message: DOWNLOAD_INTERRUPTED,
			finishedAt: this.now(),
		};
		this.writeJob(failed);
		// The schedule drops the due time at once, before any new run can set it; R2 is cleaned up after.
		this.abandoning = Promise.all([this.deps.alarm.cancel(), this.dropParked(job.runId)]);
		return failed;
	}

	/** Unscheduling and dropping what a run whose download died parked in R2, once {@link currentJob} failed it. */
	private abandoning: Promise<unknown> | undefined;

	/** Wait for {@link abandoning}, if any; a failure only logs, since the run already failed. */
	private async abandoned(): Promise<void>
	{
		const abandoning = this.abandoning;
		this.abandoning = undefined;
		await abandoning?.catch((error: unknown) =>
		{
			console.error("cleaning up an interrupted import failed", error);
		});
	}

	/** Whether a run is in progress. */
	running(): boolean
	{
		return this.runningJob() !== null;
	}

	/** Whether any run has ever finished ok, so this object holds the account's tree and transaction id. */
	hasImported(): boolean
	{
		return this.sql.exec("SELECT 1 FROM workflowy_imports WHERE status = 'ok' LIMIT 1").toArray().length > 0;
	}

	view(): WorkflowyImportView
	{
		const job = this.currentJob();
		// A read never waits on R2; the cleanup finishes on its own.
		void this.abandoned();
		if (job === null)
		{
			return {
				run: null,
			};
		}
		const {runId: _runId, snapshotAt: _snapshotAt, ownerId: _ownerId, filesCursor: _filesCursor, ...run} = job;
		return {
			run:
			{
				...run,
				files:
				{
					...run.files,
					failures: this.fileFailures(),
				},
			},
		};
	}

	/** Start an import on the next alarm, or keep the one in progress. */
	async start(): Promise<WorkflowyImportView>
	{
		const current = this.currentJob();
		await this.abandoned();
		if (current?.status !== "running")
		{
			this.beginTick();
			this.writeJob(
				{
					runId: crypto.randomUUID(),
					phase: "queued",
					status: "running",
					message: null,
					startedAt: this.now(),
					finishedAt: null,
					snapshotAt: null,
					ownerId: null,
					filesCursor: FIRST_FILE,
					applied: 0,
					found: NONE_FOUND,
					nodes: NO_CHANGES,
					failures: NO_FAILURES,
					files: NO_FILES,
					rowsRead: 0,
					rowsWritten: 0,
				},
			);
			await this.deps.alarm.setAlarm(this.now());
		}
		return this.view();
	}

	private beginTick(): void
	{
		this.systemTime = newSystemTimestamp();
		this.rowsAtTick = this.rows();
		this.tickStartedAt = Date.now();
	}

	/** One alarm run: fetch the tree, or apply the next batches of it, or copy the next attachments, or finish. */
	async tick(): Promise<void>
	{
		this.beginTick();
		const current = this.currentJob();
		await this.abandoned();
		if (current?.status !== "running" || current.phase === "fetching")
		{
			return;
		}
		let job = current;
		try
		{
			if (job.phase === "queued")
			{
				const fetched = await this.fetch(job);
				if (fetched === undefined)
				{
					return;
				}
				job = fetched;
			}
			if (job.phase === "importing")
			{
				const imported = await this.importTree(job);
				if (imported === undefined)
				{
					return;
				}
				job = imported;
			}
			await this.copyFiles(job);
		}
		catch (error)
		{
			if (error instanceof SessionExpired)
			{
				this.deps.expireSession();
				await this.finish(this.runningJob() ?? job, "expired", "workflowy-session-expired");
				return;
			}
			// The live version holds the progress the failed alarm run committed.
			await this.finish(this.runningJob() ?? job, "error", errorMessage(error));
		}
	}

	/**
	 * Read the account and stream the whole tree over the stored session into R2, one chunk per batch. Returns undefined
	 * when the run ended instead: not connected, or workflowy.com refused the session.
	 */
	private async fetch(queued: Job): Promise<Job | undefined>
	{
		const client = await this.deps.openClient();
		if (client === undefined)
		{
			await this.finish(queued, "error", "workflowy-not-connected");
			return undefined;
		}
		const {downloading} = this.deps;
		const job: Job =
		{
			...queued,
			phase: "fetching",
			// Read before the request goes out: a node written after it is not the tree's to end.
			snapshotAt: Date.now(),
		};
		downloading.add(job.runId);
		try
		{
			this.writeJob(job);
			// Should this instance die mid-download, this wakes the next one, which finds the run fetching and fails it.
			await this.deps.alarm.setAlarm(this.now());
			let session: InternalSession;
			let parked: ParkedTree & ItemCounts;
			try
			{
				session = await client.bootstrap();
				parked = await this.download(job, client, session.dateJoinedSec);
			}
			catch (error)
			{
				if (error instanceof MissingCredentialsError || error instanceof SessionRejectedError)
				{
					this.deps.expireSession();
					await this.finish(job, "expired", "workflowy-session-expired");
					return undefined;
				}
				throw error;
			}
			const account = accountSnapshot(session);
			await this.deps.bucket.put(this.key(job, "account"), JSON.stringify(account));
			const next: Job =
			{
				...job,
				phase: "importing",
				ownerId: session.ownerId,
				found: found(parked, parked.expandedKeys.length, account),
			};
			this.writeJob(next);
			return next;
		}
		finally
		{
			downloading.delete(job.runId);
		}
	}

	/**
	 * Stream the tree into R2 as it arrives, one chunk of {@link batchSize} items at a time, so memory holds one chunk
	 * and never the tree; then park its transaction id and expanded keys. Returns them with what it counted.
	 */
	private async download(
		job: Job,
		client: WorkflowyInternalClient,
		dateJoinedSec: number,
	): Promise<ParkedTree & ItemCounts>
	{
		const {bucket} = this.deps;
		const chunkSize = this.batchSize();
		const counts: ItemCounts =
		{
			nodes: 0,
			completed: 0,
			mirrors: 0,
			backlinks: 0,
		};
		let chunks = 0;
		let chunk: ParkedChunk =
		{
			nodes: [],
			items: [],
		};
		const flush = async () =>
		{
			await bucket.put(this.chunkKey(job, chunks), JSON.stringify(chunk));
			chunks++;
			chunk =
			{
				nodes: [],
				items: [],
			};
		};
		const startedAt = this.now();
		let bytes = 0;
		const record = (outcome: TreeDownload["outcome"]) =>
		{
			this.deps.recordDownload(
				{
					cause: "import",
					outcome,
					startedAt,
					durationMs: this.now() - startedAt,
					bytes,
				},
			);
		};
		const tail = await client
			.streamTreeData(
				async (item) =>
				{
					countItem(counts, item);
					chunk.nodes.push(treeDataNode(item, dateJoinedSec));
					chunk.items.push(
						item.metadata === undefined
							?
								{
									id: item.id,
								}
							:
								{
									id: item.id,
									metadata: item.metadata,
								},
					);
					if (chunk.nodes.length === chunkSize)
					{
						await flush();
					}
				},
				(byteLength) =>
				{
					bytes += byteLength;
				},
			)
			.catch((error: unknown) =>
			{
				record("error");
				throw error;
			});
		record("ok");
		if (chunk.nodes.length > 0)
		{
			await flush();
		}
		const tree: ParkedTree =
		{
			...tail,
			chunkSize,
			chunks,
		};
		await bucket.put(this.key(job, "tree"), JSON.stringify(tree));
		return {
			...tree,
			...counts,
		};
	}

	private batchSize(): number
	{
		const size = Number(this.deps.env.SYNC_BATCH_SIZE);
		return Number.isInteger(size) && size > 0 ? size : BATCH_SIZE;
	}

	/** This alarm run's share of the node merge: a fresh system time, resuming the run's totals. */
	private importState(job: Job): ApiImportState
	{
		const state = beginApiImport(
			this.deps.db,
			{
				snapshotTakenAt: job.snapshotAt === null ? undefined : new Date(job.snapshotAt),
			},
		);
		state.nodesAdded = job.nodes.added;
		state.nodesUpdated = job.nodes.updated;
		state.nodesUnchanged = job.nodes.unchanged;
		state.totalNodes = job.applied;
		state.validationErrors = job.failures.invalidNodes;
		return state;
	}

	/** Apply the next chunks of the fetched tree. Returns the job in its files phase once the whole tree is in. */
	private async importTree(job: Job): Promise<Job | undefined>
	{
		const {env, storage} = this.deps;
		const tree = await this.readJson<ParkedTree>(this.key(job, "tree"));
		const state = this.importState(job);
		const perTick = Number(env.SYNC_BATCHES_PER_TICK);
		const limit = Number.isFinite(perTick) && perTick > 0 ? perTick : Infinity;
		let batches = 0;
		for (let index = Math.floor(job.applied / tree.chunkSize); index < tree.chunks; index++)
		{
			if (batches >= limit || (batches > 0 && this.overBudget()))
			{
				await this.yieldTick();
				return undefined;
			}
			// oxlint-disable-next-line no-await-in-loop -- one chunk in memory at a time
			const batch = (await this.readChunk(job, index)).nodes.slice(job.applied - index * tree.chunkSize);
			// One transaction, so the stored cursor never runs ahead of the rows it counts.
			storage.transactionSync(() =>
			{
				applyApiBatch(state, batch);
				job =
				{
					...job,
					applied: job.applied + batch.length,
					nodes:
					{
						...job.nodes,
						added: state.nodesAdded,
						updated: state.nodesUpdated,
						unchanged: state.nodesUnchanged,
					},
					failures:
					{
						...job.failures,
						invalidNodes: state.validationErrors,
					},
				};
				this.writeJob(job);
			});
			batches++;
		}
		if (batches > 0 && this.overBudget())
		{
			await this.yieldTick();
			return undefined;
		}

		// The finish needs every node the tree holds marked seen, and every item's metadata: one chunk read at a time.
		const items: InternalTreeItem[] = [];
		for (let index = 0; index < tree.chunks; index++)
		{
			// oxlint-disable-next-line no-await-in-loop -- one chunk in memory at a time
			const parked = await this.readChunk(job, index);
			for (const node of parked.nodes)
			{
				markApplied(state, node);
			}
			for (const item of parked.items)
			{
				items.push(item);
			}
		}
		const account = await this.readJson<AccountSnapshot>(this.key(job, "account"));
		const result = finishApiImport(state, items);
		const metadata = importInternalMetadata(
			this.deps.db,
			{
				items,
				txId: tree.txId,
				expandedKeys: tree.expandedKeys,
			},
			this.now(),
		);
		runUnitOfWork(this.deps.db, (unitOfWork) =>
		{
			writeAccountSnapshot(unitOfWork, account);
			stampImportTime(unitOfWork, ACCOUNT_IMPORT_NAME, this.now());
		});
		const next: Job =
		{
			...job,
			phase: "files",
			nodes:
			{
				added: result.nodesAdded,
				updated: result.nodesUpdated,
				unchanged: result.nodesUnchanged,
				phasedOut: result.nodesPhasedOut,
				metadataWritten: metadata.written,
			},
			failures:
			{
				invalidNodes: state.validationErrors,
				metadataSkipped: metadata.skipped,
			},
			files:
			{
				...NO_FILES,
				found: this.liveFiles(FIRST_FILE).length,
			},
		};
		this.writeJob(next);
		return next;
	}

	/** Leave the rest of the run to a fresh alarm run. */
	private async yieldTick(): Promise<void>
	{
		const delay = Number(this.deps.env.SYNC_TICK_DELAY_MS);
		await this.deps.alarm.setAlarm(this.now() + (Number.isFinite(delay) && delay > 0 ? delay : 0));
	}

	private overBudget(): boolean
	{
		return Date.now() - this.tickStartedAt >= RUN_BUDGET_MS;
	}

	/**
	 * Copy the live attachments after the run's cursor into the blob store, in node id order, then finish the run.
	 * One already copied (a live "ok" `file_blobs` version) is skipped; each other one is tried once, its outcome
	 * recorded as a new `file_blobs` version in the same transaction that advances the cursor.
	 */
	private async copyFiles(job: Job): Promise<void>
	{
		const pending = this.liveFiles(job.filesCursor);
		const copied = this.copiedNodeIds();
		const perTick = Number(this.deps.env.IMPORT_FILES_PER_TICK);
		const limit = Number.isFinite(perTick) && perTick > 0 ? perTick : Infinity;
		let client: WorkflowyInternalClient | undefined;
		let tried = 0;
		/** Skips not yet written: they ride along with the next tried file, the yield or the finish. */
		let unwritten = false;
		for (const file of pending)
		{
			if (copied.has(file.nodeId))
			{
				job =
				{
					...job,
					filesCursor: file.nodeId,
					files:
					{
						...job.files,
						alreadyCopied: job.files.alreadyCopied + 1,
					},
				};
				unwritten = true;
				continue;
			}
			if (tried >= limit || (tried > 0 && this.overBudget()))
			{
				if (unwritten)
				{
					this.writeJob(job);
				}
				await this.yieldTick();
				return;
			}
			client ??= await this.deps.openClient();
			if (client === undefined)
			{
				await this.finish(job, "error", "workflowy-not-connected");
				return;
			}
			tried++;
			job = await this.copyFile(client, job, file);
			unwritten = false;
		}
		await this.finish(job, "ok", null);
	}

	/** Try one attachment once: sign its original's URL over the session, download it, and store it under its hash. */
	private async copyFile(client: WorkflowyInternalClient, job: Job, file: LiveFile): Promise<Job>
	{
		let blob: typeof fileBlobs.$inferInsert;
		try
		{
			const url = await client.signedFileUrl(
				`/file-proxy/signed-original/${String(job.ownerId)}/${file.nodeId}/?attempt=1`,
			);
			const response = await (this.deps.fetch ?? fetch)(url);
			if (!response.ok)
			{
				throw new Error(`HTTP ${String(response.status)} ${response.statusText}`);
			}
			const bytes = new Uint8Array(await response.arrayBuffer());
			const sha256 = await sha256Hex(bytes);
			const localPath = blobKey(sha256);
			await this.deps.blobs.put(localPath, bytes);
			blob =
			{
				nodeId: file.nodeId,
				status: "ok",
				sha256,
				size: bytes.byteLength,
				contentType: file.fileType,
				localPath,
				error: null,
				systemFrom: 0,
				systemTo: FAR_FUTURE_DATE,
			};
		}
		catch (error)
		{
			if (error instanceof MissingCredentialsError || error instanceof SessionRejectedError)
			{
				throw new SessionExpired("workflowy-session-expired");
			}
			blob =
			{
				nodeId: file.nodeId,
				status: "error",
				sha256: null,
				size: null,
				contentType: null,
				localPath: null,
				error: errorMessage(error),
				systemFrom: 0,
				systemTo: FAR_FUTURE_DATE,
			};
		}
		const ok = blob.status === "ok";
		const next: Job =
		{
			...job,
			filesCursor: file.nodeId,
			files:
			{
				...job.files,
				copied: job.files.copied + (ok ? 1 : 0),
				failed: job.files.failed + (ok ? 0 : 1),
				bytes: job.files.bytes + (blob.size ?? 0),
			},
		};
		runUnitOfWork(this.deps.db, ({tx, systemTime}) =>
		{
			closeCurrentVersions(tx, fileBlobs, systemTime, eq(fileBlobs.nodeId, file.nodeId));
			tx.insert(fileBlobs)
				.values(
					{
						...blob,
						systemFrom: systemTime,
					},
				)
				.run();
			this.writeJob(next);
		});
		return next;
	}

	/** The live, not deleted attachments after `cursor`, in node id order. */
	private liveFiles(cursor: string): LiveFile[]
	{
		return this.deps.db
			.select(
				{
					nodeId: s3Files.nodeId,
					fileName: s3Files.fileName,
					fileType: s3Files.fileType,
				},
			)
			.from(s3Files)
			.where(
				and(
					eq(s3Files.systemTo, FAR_FUTURE_DATE),
					or(isNull(s3Files.isDeleted), eq(s3Files.isDeleted, 0)),
					gt(s3Files.nodeId, cursor),
				),
			)
			.orderBy(asc(s3Files.nodeId))
			.all();
	}

	/** Attachments whose live `file_blobs` version is a stored copy. */
	private copiedNodeIds(): Set<string>
	{
		return new Set(
			this.deps.db
				.select(
					{
						nodeId: fileBlobs.nodeId,
					},
				)
				.from(fileBlobs)
				.where(and(eq(fileBlobs.status, "ok"), eq(fileBlobs.systemTo, FAR_FUTURE_DATE)))
				.all()
				.map(({nodeId}) => nodeId),
		);
	}

	/** Each live attachment whose newest copy attempt failed. */
	private fileFailures(): ImportFileFailure[]
	{
		return this.deps.db
			.select(
				{
					nodeId: fileBlobs.nodeId,
					fileName: s3Files.fileName,
					error: fileBlobs.error,
				},
			)
			.from(fileBlobs)
			.innerJoin(s3Files, and(eq(s3Files.nodeId, fileBlobs.nodeId), eq(s3Files.systemTo, FAR_FUTURE_DATE)))
			.where(
				and(
					eq(fileBlobs.status, "error"),
					eq(fileBlobs.systemTo, FAR_FUTURE_DATE),
					or(isNull(s3Files.isDeleted), eq(s3Files.isDeleted, 0)),
				),
			)
			.orderBy(asc(fileBlobs.nodeId))
			.all()
			.map(({nodeId, fileName, error}) => (
			{
				nodeId,
				fileName,
				error: error ?? "",
			}));
	}

	private async readJson<T>(key: string): Promise<T>
	{
		const object = await this.deps.bucket.get(key);
		if (object === null)
		{
			throw new Error(`the fetched ${key} is missing from R2`);
		}
		return object.json<T>();
	}

	private async readChunk(job: Job, index: number): Promise<ParkedChunk>
	{
		return this.readJson<ParkedChunk>(this.chunkKey(job, index));
	}

	/**
	 * End the run, run its alarm no more, and drop what it parked in R2: the account's outline is never kept outside
	 * its own object.
	 */
	private async finish(job: Job, status: Exclude<ImportStatus, "running">, message: string | null): Promise<void>
	{
		this.writeJob(
			{
				...job,
				phase: "idle",
				status,
				message,
				finishedAt: this.now(),
			},
		);
		await this.deps.alarm.cancel();
		await this.dropParked(job.runId);
	}

	/** Delete every object the run parked in R2, however far its download got. */
	private async dropParked(runId: string): Promise<void>
	{
		await deleteR2Prefix(this.deps.bucket, this.prefix(runId));
	}

	/**
	 * Write the run's version for this alarm run: close the version an earlier alarm run wrote, or replace the one
	 * this alarm run already wrote, so each alarm run leaves one version.
	 */
	private writeJob(job: Job): void
	{
		this.sql.exec(
			"UPDATE workflowy_imports SET system_to = ? WHERE run_id = ? AND system_to = ? AND system_from <> ?",
			this.systemTime,
			job.runId,
			FAR_FUTURE_DATE,
			this.systemTime,
		);
		const rows = this.rows();
		this.sql.exec(
			"INSERT OR REPLACE INTO workflowy_imports (run_id, phase, applied, started_at, snapshot_at, owner_id, status, message, " +
				"finished_at, found_nodes, found_completed, found_mirrors, found_backlinks, found_expanded_keys, found_stars, " +
				"found_star_order, found_tag_colors, found_saved_views, found_settings, nodes_added, nodes_updated, " +
				"nodes_unchanged, nodes_phased_out, metadata_written, invalid_nodes, metadata_skipped, files_found, files_copied, " +
				"files_already_copied, files_failed, files_bytes, files_cursor, rows_read, rows_written, system_from, system_to) " +
				"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			job.runId,
			job.phase,
			job.applied,
			job.startedAt,
			job.snapshotAt,
			job.ownerId,
			job.status,
			job.message,
			job.finishedAt,
			job.found.nodes,
			job.found.completed,
			job.found.mirrors,
			job.found.backlinks,
			job.found.expandedKeys,
			job.found.stars,
			job.found.starOrder,
			job.found.tagColors,
			job.found.savedViews,
			job.found.settings,
			job.nodes.added,
			job.nodes.updated,
			job.nodes.unchanged,
			job.nodes.phasedOut,
			job.nodes.metadataWritten,
			job.failures.invalidNodes,
			job.failures.metadataSkipped,
			job.files.found,
			job.files.copied,
			job.files.alreadyCopied,
			job.files.failed,
			job.files.bytes,
			job.filesCursor,
			job.rowsRead + rows.rowsRead - this.rowsAtTick.rowsRead,
			job.rowsWritten + rows.rowsWritten - this.rowsAtTick.rowsWritten,
			this.systemTime,
			FAR_FUTURE_DATE,
		);
	}
}

/** The account tables' source, in the shape the account import writes. */
function accountSnapshot(session: InternalSession): AccountSnapshot
{
	return {
		account:
		{
			userId: String(session.userId),
			dateJoinedSec: session.dateJoinedSec,
			...(session.fullName === undefined
				? {}
				:
					{
						fullName: session.fullName,
					}),
			...(session.entropyKey === undefined
				? {}
				:
					{
						entropyKey: session.entropyKey,
					}),
		},
		rootMetadata: session.rootMetadata,
		settings: session.settings,
		visibleFeatures: session.visibleFeatures,
	};
}

/** Count one item the download read, by kind. */
function countItem(counts: ItemCounts, item: TreeDataItem): void
{
	counts.nodes++;
	if (item.cp !== undefined && item.cp !== null)
	{
		counts.completed++;
	}
	const mirror: unknown = item.metadata?.mirror;
	if (isRecord(mirror) && typeof mirror.originalId === "string" && mirror.originalId !== "")
	{
		counts.mirrors++;
	}
	const backlink: unknown = item.metadata?.backlink;
	if (isRecord(backlink) && typeof backlink.sourceID === "string" && backlink.sourceID !== "")
	{
		counts.backlinks++;
	}
}

/** What one fetch found upstream, by kind. */
function found(counts: ItemCounts, expandedKeys: number, account: AccountSnapshot): ImportFound
{
	const rows = accountRows(account);
	return {
		nodes: counts.nodes,
		completed: counts.completed,
		mirrors: counts.mirrors,
		backlinks: counts.backlinks,
		expandedKeys,
		stars: rows.stars.length,
		starOrder: rows.starOrder.length,
		tagColors: rows.tagColors.length,
		savedViews: rows.savedViews.length,
		settings: Object.keys(account.settings).length,
	};
}

function isRecord(value: unknown): value is Record<string, unknown>
{
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A `workflowy_imports` row as the run it versions. */
function jobFromRow(row: Record<string, SqlStorageValue>): Job
{
	const count = (column: string): number => Number(row[column]);
	const text = (column: string): string | null =>
	{
		const value = row[column];
		return typeof value === "string" ? value : null;
	};
	const phase = text("phase");
	const status = text("status");
	const finishedAt = row.finished_at;
	const snapshotAt = row.snapshot_at;
	const ownerId = row.owner_id;
	return {
		runId: text("run_id") ?? "",
		phase:
			phase === "queued" || phase === "fetching" || phase === "importing" || phase === "files" ? phase : "idle",
		status: status === "running" || status === "ok" || status === "expired" ? status : "error",
		message: text("message"),
		startedAt: count("started_at"),
		finishedAt: typeof finishedAt === "number" ? finishedAt : null,
		snapshotAt: typeof snapshotAt === "number" ? snapshotAt : null,
		ownerId: typeof ownerId === "number" ? ownerId : null,
		filesCursor: text("files_cursor") ?? FIRST_FILE,
		applied: count("applied"),
		found:
		{
			nodes: count("found_nodes"),
			completed: count("found_completed"),
			mirrors: count("found_mirrors"),
			backlinks: count("found_backlinks"),
			expandedKeys: count("found_expanded_keys"),
			stars: count("found_stars"),
			starOrder: count("found_star_order"),
			tagColors: count("found_tag_colors"),
			savedViews: count("found_saved_views"),
			settings: count("found_settings"),
		},
		nodes:
		{
			added: count("nodes_added"),
			updated: count("nodes_updated"),
			unchanged: count("nodes_unchanged"),
			phasedOut: count("nodes_phased_out"),
			metadataWritten: count("metadata_written"),
		},
		failures:
		{
			invalidNodes: count("invalid_nodes"),
			metadataSkipped: count("metadata_skipped"),
		},
		files:
		{
			found: count("files_found"),
			copied: count("files_copied"),
			alreadyCopied: count("files_already_copied"),
			failed: count("files_failed"),
			bytes: count("files_bytes"),
		},
		rowsRead: count("rows_read"),
		rowsWritten: count("rows_written"),
	};
}

function errorMessage(error: unknown): string
{
	return error instanceof Error ? error.message : String(error);
}
