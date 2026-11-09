/**
 * Copy attachment bytes out of Workflowy into a local content-addressed store.
 *
 * Workflowy keeps attachment bytes on S3 behind short-lived signed URLs that only a
 * logged-in session can mint; no export or backup carries them. This walks the live
 * `s3_files` rows, downloads each original into `<storeDir>/blobs/<ab>/<sha256>`, and
 * records the result as a new `file_blobs` version. A live "ok" version whose file is
 * still on disk at the recorded size is skipped, so re-running resumes where the last
 * run stopped; failures are recorded as "error" versions and retried next time.
 */

import {createHash} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {pipeline} from "node:stream/promises";
import {setTimeout as sleep} from "node:timers/promises";
import {closeCurrentVersions, runUnitOfWork, startUnitOfWork} from "@outlinedb/shared/cache";
import {fileBlobs, s3Files} from "@outlinedb/shared/db";
import type * as schema from "@outlinedb/shared/db";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import {and, eq, isNull, or} from "drizzle-orm";
import type {BetterSQLite3Database} from "drizzle-orm/better-sqlite3";

const DEFAULT_CONCURRENCY = 3;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1000;

/** The store directory name used beside the database when none is configured. */
const STORE_DIR_NAME = "files-mirror";

/**
 * `WORKFLOWY_FILES_DIR`, else a `files-mirror` directory beside the cache database
 * (`WORKFLOWY_DB_PATH`, default `workflowy.sqlite` in the working directory).
 */
export function defaultStoreDir(env: NodeJS.ProcessEnv, cwd: string): string {
	const configured = env.WORKFLOWY_FILES_DIR ?? "";
	if (configured !== "") {
		return path.resolve(cwd, configured);
	}
	const dbPath = (env.WORKFLOWY_DB_PATH ?? "") || "workflowy.sqlite";
	return path.join(path.dirname(path.resolve(cwd, dbPath)), STORE_DIR_NAME);
}

/** Mints a fresh signed URL for one attachment's original bytes. */
export interface FileUrlSigner {
	signedOriginalUrl(nodeId: string): Promise<string>;
}

export interface MirrorFilesOptions {
	database: BetterSQLite3Database<typeof schema>;
	/** Required unless `dryRun`. */
	signer?: FileUrlSigner;
	fetch: typeof fetch;
	/** Root of the content-addressed store; `blobs/` and `tmp/` live under it. */
	storeDir: string;
	/** Download at most this many attachments not yet mirrored. */
	limit?: number;
	/** Report what would be downloaded without signing, fetching or writing anything. */
	dryRun?: boolean;
	/** Downloads in flight at once. */
	concurrency?: number;
	/** Tries per attachment, each with a freshly signed URL. */
	maxAttempts?: number;
	/** Pause before a retry, multiplied by the attempt number. */
	retryDelayMs?: number;
	/** The clock each recorded version's system time is read from. */
	now?: () => Date;
	/** Called once per finished attachment with a one-line progress message. */
	onProgress?: (line: string) => void;
}

export interface MirrorFailure {
	nodeId: string;
	fileName: string;
	error: string;
}

export interface MirrorFilesReport {
	/** Live (not deleted, current) attachments. */
	live: number;
	/** Live attachments already mirrored and present on disk. */
	alreadyMirrored: number;
	/** Attachments this run downloaded, or would download in a dry run. */
	selected: number;
	downloaded: number;
	failed: number;
	/** Bytes downloaded this run. */
	bytes: number;
	failures: MirrorFailure[];
}

interface LiveFile {
	nodeId: string;
	fileName: string;
	fileType: string;
}

interface Download {
	sha256: string;
	size: number;
	localPath: string;
}

/** The store-relative path of a blob: two-character fan-out directory, then the full hash. */
function blobRelativePath(sha256: string): string {
	return `blobs/${sha256.slice(0, 2)}/${sha256}`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function liveFiles(database: MirrorFilesOptions["database"]): LiveFile[] {
	return database
		.select({nodeId: s3Files.nodeId, fileName: s3Files.fileName, fileType: s3Files.fileType})
		.from(s3Files)
		.where(and(eq(s3Files.systemTo, FAR_FUTURE_DATE), or(isNull(s3Files.isDeleted), eq(s3Files.isDeleted, 0))))
		.orderBy(s3Files.nodeId)
		.all();
}

/** Node ids whose recorded blob is still on disk at the recorded size. */
function mirroredNodeIds(database: MirrorFilesOptions["database"], storeDir: string): Set<string> {
	const mirrored = new Set<string>();
	const live = and(eq(fileBlobs.status, "ok"), eq(fileBlobs.systemTo, FAR_FUTURE_DATE));
	for (const row of database.select().from(fileBlobs).where(live).all()) {
		if (row.localPath === null || row.size === null) {
			continue;
		}
		const stat = fs.statSync(path.join(storeDir, row.localPath), {throwIfNoEntry: false});
		if (stat?.size === row.size) {
			mirrored.add(row.nodeId);
		}
	}
	return mirrored;
}

/** Stream one signed URL into the store, hashing as it goes; the blob lands under its hash only when complete. */
async function downloadOnce(
	options: MirrorFilesOptions,
	file: LiveFile,
	tmpDir: string,
): Promise<Download & {contentType: string}> {
	if (options.signer === undefined) {
		throw new Error("no signer configured");
	}
	const url = await options.signer.signedOriginalUrl(file.nodeId);
	const response = await options.fetch(url);
	if (!response.ok || response.body === null) {
		throw new Error(`HTTP ${response.status} ${response.statusText}`);
	}
	const tmpPath = path.join(tmpDir, `${file.nodeId}.part`);
	const hash = createHash("sha256");
	let size = 0;
	try {
		await pipeline(
			response.body,
			async function* count(source: AsyncIterable<Buffer>) {
				for await (const chunk of source) {
					hash.update(chunk);
					size += chunk.length;
					yield chunk;
				}
			},
			fs.createWriteStream(tmpPath),
		);
		const declared = response.headers.get("content-length");
		if (declared !== null && Number(declared) !== size) {
			throw new Error(`size ${size} does not match Content-Length ${declared}`);
		}
		const sha256 = hash.digest("hex");
		const localPath = blobRelativePath(sha256);
		const target = path.join(options.storeDir, localPath);
		fs.mkdirSync(path.dirname(target), {recursive: true});
		if (fs.statSync(target, {throwIfNoEntry: false})?.size === size) {
			fs.rmSync(tmpPath);
		} else {
			fs.renameSync(tmpPath, target);
		}
		return {sha256, size, localPath, contentType: file.fileType};
	} finally {
		fs.rmSync(tmpPath, {force: true});
	}
}

async function downloadWithRetry(
	options: MirrorFilesOptions,
	file: LiveFile,
	tmpDir: string,
): Promise<Download & {contentType: string}> {
	const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
	const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
	let lastError: unknown;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return await downloadOnce(options, file, tmpDir);
		} catch (error) {
			lastError = error;
			if (attempt < maxAttempts && retryDelayMs > 0) {
				await sleep(retryDelayMs * attempt);
			}
		}
	}
	throw lastError;
}

type BlobVersion = Omit<typeof fileBlobs.$inferInsert, "systemFrom" | "systemTo">;

/** Phase out the attachment's live version, if any, and insert `row` as the new one, in one unit of work. */
function record(database: MirrorFilesOptions["database"], row: BlobVersion, at: Date): void {
	runUnitOfWork(
		database,
		({tx, systemTime}) => {
			closeCurrentVersions(tx, fileBlobs, systemTime, eq(fileBlobs.nodeId, row.nodeId));
			tx.insert(fileBlobs)
				.values({...row, systemFrom: systemTime, systemTo: FAR_FUTURE_DATE})
				.run();
		},
		startUnitOfWork(at),
	);
}

export async function mirrorFiles(options: MirrorFilesOptions): Promise<MirrorFilesReport> {
	const {database, storeDir} = options;
	const now = options.now ?? (() => new Date());
	const live = liveFiles(database);
	const mirrored = mirroredNodeIds(database, storeDir);
	const pending = live.filter((file) => !mirrored.has(file.nodeId));
	const selected = options.limit === undefined ? pending : pending.slice(0, options.limit);
	const report: MirrorFilesReport = {
		live: live.length,
		alreadyMirrored: live.length - pending.length,
		selected: selected.length,
		downloaded: 0,
		failed: 0,
		bytes: 0,
		failures: [],
	};
	if (options.dryRun) {
		for (const file of selected) {
			options.onProgress?.(`would fetch ${file.nodeId} ${file.fileName} (${file.fileType})`);
		}
		return report;
	}

	const tmpDir = path.join(storeDir, "tmp");
	fs.mkdirSync(tmpDir, {recursive: true});
	const failures = new Map<string, MirrorFailure>();
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < selected.length) {
			const file = selected[next++];
			if (file === undefined) {
				return;
			}
			try {
				const download = await downloadWithRetry(options, file, tmpDir);
				record(database, {nodeId: file.nodeId, status: "ok", ...download, error: null}, now());
				report.downloaded++;
				report.bytes += download.size;
				options.onProgress?.(
					`ok    ${file.nodeId} ${file.fileName} ${download.size} bytes ${download.localPath}`,
				);
			} catch (error) {
				const message = errorMessage(error);
				record(
					database,
					{
						nodeId: file.nodeId,
						status: "error",
						sha256: null,
						size: null,
						contentType: null,
						localPath: null,
						error: message,
					},
					now(),
				);
				report.failed++;
				failures.set(file.nodeId, {nodeId: file.nodeId, fileName: file.fileName, error: message});
				options.onProgress?.(`error ${file.nodeId} ${file.fileName}: ${message}`);
			}
		}
	};
	const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
	await Promise.all(Array.from({length: Math.min(concurrency, selected.length)}, worker));
	report.failures = selected.flatMap((file) => failures.get(file.nodeId) ?? []);
	return report;
}
