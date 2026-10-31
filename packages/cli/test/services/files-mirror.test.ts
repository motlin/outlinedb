import {createHash} from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {setTimeout as sleep} from "node:timers/promises";
import {fileBlobs, s3Files} from "@workflowy/shared/db";
import {FAR_FUTURE_DATE} from "@workflowy/shared/temporal";
import {eq} from "drizzle-orm";
import {afterEach, beforeEach, describe, expect, it} from "vite-plus/test";
import {defaultStoreDir, mirrorFiles} from "../../src/services/files-mirror.js";
import type {FileUrlSigner, MirrorFilesOptions} from "../../src/services/files-mirror.js";
import {cleanupTestDatabase, createTestDatabase} from "../db/migration-helper.js";
import type {TestDatabase} from "../db/migration-helper.js";

const OPEN = {systemFrom: "2026-10-01 00:00:00", systemTo: FAR_FUTURE_DATE};
const FETCHED_AT = new Date(1_790_000_000_000);
const FETCHED_AT_SYSTEM_TIME = "2026-09-21 14:13:20.000";
const RETRIED_AT = new Date(1_790_000_060_000);
const RETRIED_AT_SYSTEM_TIME = "2026-09-21 14:14:20.000";

const BYTES: Record<string, string> = {
	"node-a": "jpeg bytes of photo a",
	"node-b": "png bytes of screenshot b",
	"node-c": "pdf bytes of document c",
};

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function blobPath(text: string): string {
	const hash = sha256(text);
	return `blobs/${hash.slice(0, 2)}/${hash}`;
}

interface FakeServer {
	fetch: typeof fetch;
	signer: FileUrlSigner;
	signed: string[];
	fetched: string[];
	maxInFlight: number;
}

/** Signs `https://s3.test/<nodeId>?sig=<n>` URLs and serves BYTES for them, with optional per-node failures. */
function fakeServer(
	options: {
		bytes?: Record<string, string>;
		fail?: (nodeId: string, attempt: number) => Response | null;
		contentLength?: (nodeId: string, body: string) => string;
	} = {},
): FakeServer {
	const bytes = options.bytes ?? BYTES;
	const signed: string[] = [];
	const fetched: string[] = [];
	let inFlight = 0;
	let maxInFlight = 0;
	const fakeFetch: typeof fetch = async (input) => {
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		const nodeId = url.pathname.slice(1);
		fetched.push(nodeId);
		const attempt = fetched.filter((id) => id === nodeId).length;
		inFlight++;
		maxInFlight = Math.max(maxInFlight, inFlight);
		await sleep(5);
		inFlight--;
		const failure = options.fail?.(nodeId, attempt);
		if (failure !== null && failure !== undefined) {
			return failure;
		}
		const body = bytes[nodeId];
		if (body === undefined) {
			return new Response("missing", {status: 404, statusText: "Not Found"});
		}
		return new Response(body, {
			status: 200,
			headers: {
				"content-type": "application/octet-stream",
				"content-length": options.contentLength?.(nodeId, body) ?? String(Buffer.byteLength(body)),
			},
		});
	};
	return {
		fetch: fakeFetch,
		signer: {
			async signedOriginalUrl(nodeId) {
				signed.push(nodeId);
				await sleep(0);
				return `https://s3.test/${nodeId}?sig=${signed.length}`;
			},
		},
		signed,
		fetched,
		get maxInFlight() {
			return maxInFlight;
		},
	};
}

describe("mirrorFiles", () => {
	let testDb: TestDatabase;
	let storeDir: string;

	beforeEach(() => {
		testDb = createTestDatabase();
		storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "files-mirror-"));
		testDb.db
			.insert(s3Files)
			.values([
				{nodeId: "node-a", fileName: "IMG_0001.jpeg", fileType: "image/jpeg", ...OPEN},
				{nodeId: "node-b", fileName: "screenshot.png", fileType: "image/png", isDeleted: 0, ...OPEN},
				{nodeId: "node-c", fileName: "document.pdf", fileType: "application/pdf", ...OPEN},
				{nodeId: "node-deleted", fileName: "gone.jpeg", fileType: "image/jpeg", isDeleted: 1, ...OPEN},
				{
					nodeId: "node-closed",
					fileName: "old.jpeg",
					fileType: "image/jpeg",
					systemFrom: "2026-09-01 00:00:00",
					systemTo: "2026-09-02 00:00:00",
				},
			])
			.run();
	});

	afterEach(() => {
		cleanupTestDatabase(testDb);
		fs.rmSync(storeDir, {recursive: true, force: true});
	});

	async function run(server: FakeServer, overrides: Partial<MirrorFilesOptions> = {}) {
		return mirrorFiles({
			database: testDb.db,
			signer: server.signer,
			fetch: server.fetch,
			storeDir,
			now: () => FETCHED_AT,
			retryDelayMs: 0,
			...overrides,
		});
	}

	function rows() {
		return testDb.db
			.select()
			.from(fileBlobs)
			.where(eq(fileBlobs.systemTo, FAR_FUTURE_DATE))
			.all()
			.toSorted((x, y) => x.nodeId.localeCompare(y.nodeId));
	}

	function okRow(nodeId: string, fileType: string, systemFrom = FETCHED_AT_SYSTEM_TIME) {
		const body = BYTES[nodeId] ?? "";
		return {
			nodeId,
			status: "ok",
			sha256: sha256(body),
			size: Buffer.byteLength(body),
			contentType: fileType,
			localPath: blobPath(body),
			error: null,
			systemFrom,
			systemTo: FAR_FUTURE_DATE,
		};
	}

	it("downloads every live attachment into a content-addressed store and records it", async () => {
		const server = fakeServer();
		const report = await run(server);

		expect(report).toStrictEqual({
			live: 3,
			alreadyMirrored: 0,
			selected: 3,
			downloaded: 3,
			failed: 0,
			bytes: Object.values(BYTES).reduce((sum, body) => sum + Buffer.byteLength(body), 0),
			failures: [],
		});
		expect(rows()).toStrictEqual([
			okRow("node-a", "image/jpeg"),
			okRow("node-b", "image/png"),
			okRow("node-c", "application/pdf"),
		]);
		for (const body of Object.values(BYTES)) {
			expect(fs.readFileSync(path.join(storeDir, blobPath(body)), "utf8")).toBe(body);
		}
		expect(fs.readdirSync(path.join(storeDir, "tmp"))).toStrictEqual([]);
	});

	it("is idempotent: a second run fetches nothing", async () => {
		await run(fakeServer());
		const second = fakeServer();
		const report = await run(second);

		expect({report, signed: second.signed, fetched: second.fetched}).toStrictEqual({
			report: {live: 3, alreadyMirrored: 3, selected: 0, downloaded: 0, failed: 0, bytes: 0, failures: []},
			signed: [],
			fetched: [],
		});
	});

	it("downloads again when the recorded file is missing from the store", async () => {
		await run(fakeServer());
		fs.rmSync(path.join(storeDir, blobPath(BYTES["node-b"] ?? "")));
		const second = fakeServer();
		const report = await run(second, {now: () => RETRIED_AT});

		expect({selected: report.selected, fetched: second.fetched}).toStrictEqual({selected: 1, fetched: ["node-b"]});
		expect(fs.existsSync(path.join(storeDir, blobPath(BYTES["node-b"] ?? "")))).toBe(true);
	});

	it("limits the run to the first N attachments not yet mirrored", async () => {
		const first = fakeServer();
		await run(first, {limit: 2});
		const second = fakeServer();
		await run(second, {limit: 2});

		expect({first: first.fetched, second: second.fetched}).toStrictEqual({
			first: ["node-a", "node-b"],
			second: ["node-c"],
		});
	});

	it("dry run lists what it would fetch without touching the network, the store or the table", async () => {
		const server = fakeServer();
		const report = await run(server, {dryRun: true, limit: 2});

		expect({
			report,
			signed: server.signed,
			fetched: server.fetched,
			rows: rows(),
			store: fs.readdirSync(storeDir),
		}).toStrictEqual({
			report: {live: 3, alreadyMirrored: 0, selected: 2, downloaded: 0, failed: 0, bytes: 0, failures: []},
			signed: [],
			fetched: [],
			rows: [],
			store: [],
		});
	});

	it("re-signs and retries when the signed URL is refused, then records a lasting failure as an error row", async () => {
		const server = fakeServer({
			fail: (nodeId, attempt) => {
				if (nodeId === "node-a" && attempt === 1) {
					return new Response("expired", {status: 403, statusText: "Forbidden"});
				}
				if (nodeId === "node-c") {
					return new Response("boom", {status: 500, statusText: "Internal Server Error"});
				}
				return null;
			},
		});
		const report = await run(server, {maxAttempts: 2});
		const errorRowC = {
			nodeId: "node-c",
			status: "error",
			sha256: null,
			size: null,
			contentType: null,
			localPath: null,
			error: "HTTP 500 Internal Server Error",
			systemFrom: FETCHED_AT_SYSTEM_TIME,
			systemTo: FAR_FUTURE_DATE,
		};

		expect({
			downloaded: report.downloaded,
			failed: report.failed,
			failures: report.failures,
			signedA: server.signed.filter((id) => id === "node-a").length,
			rowC: rows().find((row) => row.nodeId === "node-c"),
		}).toStrictEqual({
			downloaded: 2,
			failed: 1,
			failures: [{nodeId: "node-c", fileName: "document.pdf", error: "HTTP 500 Internal Server Error"}],
			signedA: 2,
			rowC: errorRowC,
		});

		const retry = fakeServer();
		const retryReport = await run(retry, {now: () => RETRIED_AT});
		expect({
			failed: retryReport.failed,
			fetched: retry.fetched,
			historyC: testDb.db
				.select()
				.from(fileBlobs)
				.where(eq(fileBlobs.nodeId, "node-c"))
				.orderBy(fileBlobs.systemFrom)
				.all(),
		}).toStrictEqual({
			failed: 0,
			fetched: ["node-c"],
			historyC: [
				{...errorRowC, systemTo: RETRIED_AT_SYSTEM_TIME},
				okRow("node-c", "application/pdf", RETRIED_AT_SYSTEM_TIME),
			],
		});
	});

	it("rejects a download whose size disagrees with Content-Length", async () => {
		const server = fakeServer({
			contentLength: (nodeId, body) =>
				nodeId === "node-b" ? String(Buffer.byteLength(body) + 10) : String(Buffer.byteLength(body)),
		});
		const report = await run(server, {maxAttempts: 1});

		expect(report.failures).toStrictEqual([
			{
				nodeId: "node-b",
				fileName: "screenshot.png",
				error: `size ${Buffer.byteLength(BYTES["node-b"] ?? "")} does not match Content-Length ${Buffer.byteLength(BYTES["node-b"] ?? "") + 10}`,
			},
		]);
		expect(fs.readdirSync(path.join(storeDir, "tmp"))).toStrictEqual([]);
	});

	it("never runs more downloads at once than the concurrency limit", async () => {
		const server = fakeServer();
		await run(server, {concurrency: 2});

		expect(server.maxInFlight).toBe(2);
	});

	it("stores identical bytes once when two attachments share them", async () => {
		testDb.db
			.insert(s3Files)
			.values({nodeId: "node-d", fileName: "copy.jpeg", fileType: "image/jpeg", ...OPEN})
			.run();
		const server = fakeServer({bytes: {...BYTES, "node-d": BYTES["node-a"] ?? ""}});
		await run(server);

		const pathA = rows().find((row) => row.nodeId === "node-a")?.localPath;
		const pathD = rows().find((row) => row.nodeId === "node-d")?.localPath;
		const blobFiles = fs
			.readdirSync(path.join(storeDir, "blobs"), {recursive: true, withFileTypes: true})
			.filter((entry) => entry.isFile());
		expect({pathD, blobCount: blobFiles.length}).toStrictEqual({pathD: pathA, blobCount: 3});
	});
});

describe("defaultStoreDir", () => {
	it("prefers WORKFLOWY_FILES_DIR", () => {
		expect(
			defaultStoreDir({WORKFLOWY_FILES_DIR: "/data/attachments", WORKFLOWY_DB_PATH: "/db/w.sqlite"}, "/cwd"),
		).toBe("/data/attachments");
	});

	it("sits beside the database file", () => {
		expect(defaultStoreDir({WORKFLOWY_DB_PATH: "/db/w.sqlite"}, "/cwd")).toBe("/db/files-mirror");
	});

	it("falls back to files-mirror in the working directory, next to the default workflowy.sqlite", () => {
		expect(defaultStoreDir({}, "/cwd")).toBe("/cwd/files-mirror");
	});
});
