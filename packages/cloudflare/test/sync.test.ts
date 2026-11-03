import {afterAll, describe, expect, it} from "vite-plus/test";
import {rmSync} from "node:fs";
import {readJson, startHarness} from "./harness";
import type {Harness} from "./harness";

const sleep = async (ms: number): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

function uuid(n: number): string {
	return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function makeNodes(count: number, rename = new Map<number, string>()) {
	return Array.from({length: count}, (_, i) => ({
		id: uuid(i + 1),
		name: rename.get(i) ?? `node ${i}`,
		note: null,
		parent_id: i < 10 ? null : uuid((i % 10) + 1),
		priority: i,
		createdAt: 1000 + i,
		modifiedAt: 2000 + i,
	}));
}

interface SyncStatus {
	phase: string;
	applied: number;
	nextAlarmAt: number | null;
	lastResult: {
		status: string;
		totalNodes?: number;
		nodesAdded?: number;
		nodesUpdated?: number;
		nodesUnchanged?: number;
		nodesPhasedOut?: number;
		exportKey?: string;
		internalSyncError?: string;
		durationMs?: number;
	} | null;
}

const bindings = {
	ACCESS_DEV_IDENTITY: "dev",
	WORKFLOWY_API_KEY: "fake-key-value",
	WORKFLOWY_API_URL: "http://upstream.test",
};

async function status(h: Harness): Promise<SyncStatus> {
	const response = await h.mf.dispatchFetch("http://localhost/api/admin/sync");
	expect(response.status).toBe(200);
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test reads its own endpoint
	return (await readJson(response)) as SyncStatus;
}

async function runToIdle(h: Harness, previousFinished = 0, path = "/api/admin/sync"): Promise<SyncStatus> {
	const post = await h.mf.dispatchFetch(`http://localhost${path}`, {method: "POST"});
	expect(post.status).toBe(202);
	for (let i = 0; i < 300; i++) {
		const current = await status(h);
		if (
			current.phase === "idle" &&
			current.lastResult !== null &&
			current.applied === 0 &&
			(i > 0 || previousFinished === 0)
		) {
			return current;
		}
		await sleep(100);
	}
	throw new Error("sync did not finish");
}

async function liveIds(h: Harness): Promise<string[]> {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Miniflare types its namespace with undici classes
	const ns = (await h.mf.getDurableObjectNamespace("USER_STORE")) as unknown as DurableObjectNamespace;
	const response = await ns.get(ns.idFromName("dev")).fetch("http://localhost/__live-ids");
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test reads its own endpoint
	return response.json();
}

/** How many node_content rows share each system time, in system-time order. */
async function rowsPerSystemTime(h: Harness): Promise<unknown> {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Miniflare types its namespace with undici classes
	const ns = (await h.mf.getDurableObjectNamespace("USER_STORE")) as unknown as DurableObjectNamespace;
	const response = await ns.get(ns.idFromName("dev")).fetch("http://localhost/__system-froms");
	return response.json();
}

interface SyncTables {
	runs: {phase: string; applied: number; status: string | null; live: number}[];
	runSystemFroms: number;
	seen: {live: number; n: number}[];
	seedRequests: {live: number; ordered: number}[];
}

/** The sync job's own temporal tables: every run version, the seen-id scratch and the seed requests. */
async function syncTables(h: Harness): Promise<SyncTables> {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Miniflare types its namespace with undici classes
	const ns = (await h.mf.getDurableObjectNamespace("USER_STORE")) as unknown as DurableObjectNamespace;
	const response = await ns.get(ns.idFromName("dev")).fetch("http://localhost/__sync-tables");
	return response.json();
}

async function accountRows(h: Harness): Promise<unknown> {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Miniflare types its namespace with undici classes
	const ns = (await h.mf.getDurableObjectNamespace("USER_STORE")) as unknown as DurableObjectNamespace;
	const response = await ns.get(ns.idFromName("dev")).fetch("http://localhost/__account");
	return response.json();
}

async function internalMetadata(h: Harness): Promise<unknown> {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Miniflare types its namespace with undici classes
	const ns = (await h.mf.getDurableObjectNamespace("USER_STORE")) as unknown as DurableObjectNamespace;
	const response = await ns.get(ns.idFromName("dev")).fetch("http://localhost/__internal-metadata");
	return response.json();
}

interface TreeLog {
	txId: string | null;
	mirrors: {mirror_id: string; original_id: string}[];
}

async function treeLog(h: Harness): Promise<TreeLog> {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Miniflare types its namespace with undici classes
	const ns = (await h.mf.getDurableObjectNamespace("USER_STORE")) as unknown as DurableObjectNamespace;
	const response = await ns.get(ns.idFromName("dev")).fetch("http://localhost/__tree-log");
	return response.json();
}

/** One `/push_and_poll` result, as the server sends it. */
function pollResult(txId: string, extra: Record<string, unknown> = {}): Response {
	return Response.json({results: [{new_most_recent_operation_transaction_id: txId, ...extra}]});
}

/** The transaction id a `/push_and_poll` form started from. */
function startTxId(body: string): string {
	const data: unknown = JSON.parse(new URLSearchParams(body).get("push_poll_data") ?? "[]");
	const first: unknown = Array.isArray(data) ? data[0] : undefined;
	return typeof first === "object" && first !== null && "most_recent_operation_transaction_id" in first
		? String(first.most_recent_operation_transaction_id)
		: "";
}

const internalAuthBindings = {WORKFLOWY_USERNAME: "alice@example.com", WORKFLOWY_PASSWORD: "hunter2"};

describe("sync from a fake upstream", () => {
	let current = makeNodes(5000);
	let exportCalls = 0;
	let rateLimit = false;
	let treeData: (() => Response) | undefined;
	let pushAndPoll: () => Response = () => pollResult("1");
	let exportGate: Promise<void> | undefined;
	let exportReached: (() => void) | undefined;
	const internalCalls: string[] = [];
	const pollStarts: string[] = [];
	const auths: (string | null)[] = [];
	const open = new Set<Harness>();
	const stop = async (h: Harness, keepData = false): Promise<void> => {
		open.delete(h);
		await h.dispose(keepData);
	};
	const start = async (persistDir?: string, extra: Record<string, string> = {}): Promise<Harness> => {
		const started = await startHarness(
			"./probe-entry.ts",
			"ProbeStore",
			persistDir,
			{...bindings, ...extra},
			{
				outboundService: async (request: Request): Promise<Response> => {
					const url = new URL(request.url);
					if (url.pathname === "/push_and_poll") {
						internalCalls.push(url.pathname);
						pollStarts.push(startTxId(await request.text()));
						return pushAndPoll();
					}
					if (url.pathname === "/api/v1/nodes-export") {
						exportCalls++;
						auths.push(request.headers.get("authorization"));
						exportReached?.();
						await exportGate;
						if (rateLimit) {
							return new Response("slow down", {status: 429, headers: {"retry-after": "120"}});
						}
						return Response.json({nodes: current});
					}
					if (
						url.pathname === "/ajax_login" ||
						url.pathname === "/get_tree_data/" ||
						url.pathname === "/get_initialization_data"
					) {
						internalCalls.push(url.pathname);
						if (url.pathname === "/ajax_login") {
							return new Response("{}", {status: 200, headers: {"set-cookie": "sessionid=abc; Path=/"}});
						}
						if (url.pathname === "/get_initialization_data") {
							return Response.json({
								projectTreeData: {
									mainProjectTreeInfo: {
										dateJoinedTimestampInSeconds: 1_400_000_000,
										initialMostRecentOperationTransactionId: "1",
									},
								},
								user: {id: 123},
							});
						}
						return treeData?.() ?? new Response("no tree data", {status: 500});
					}
					return new Response(`unexpected ${url.pathname}`, {status: 500});
				},
			},
		);
		open.add(started);
		return started;
	};
	afterAll(async () => {
		await Promise.all([...open].map(async (h) => stop(h)));
	});

	it("imports a 5k-node export, keeps a raw copy in R2, then reports no changes and phases out a removed node", async () => {
		const h = await start();
		const first = await runToIdle(h);
		expect(first.lastResult).toMatchObject({
			status: "ok",
			totalNodes: 5000,
			nodesAdded: 5000,
			nodesUnchanged: 0,
			nodesPhasedOut: 0,
		});
		expect(auths).toStrictEqual(["Bearer fake-key-value"]);
		await expect(liveIds(h)).resolves.toHaveLength(5000);

		const exportKey = first.lastResult?.exportKey ?? "";
		expect(exportKey).toMatch(/^exports\/.+\.json$/u);
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Miniflare types its bucket with undici classes
		const bucket = (await h.mf.getR2Bucket("SNAPSHOTS")) as unknown as R2Bucket;
		const stored = await bucket.get(exportKey);
		expect(JSON.parse((await stored?.text()) ?? "null")).toStrictEqual({nodes: current});

		const second = await runToIdle(h, 1);
		expect(second.lastResult).toMatchObject({status: "ok", nodesAdded: 0, nodesUpdated: 0, nodesUnchanged: 5000});

		current = makeNodes(5000, new Map([[20, "renamed"]])).slice(0, 4999);
		const third = await runToIdle(h, 2);
		expect(third.lastResult).toMatchObject({status: "ok", nodesUpdated: 1, nodesPhasedOut: 1});
		await expect(liveIds(h)).resolves.toHaveLength(4999);
		expect(third.nextAlarmAt).toBeGreaterThan(Date.now() + 25 * 60_000);
		// Each run finished inside one alarm, so each is one live version; its seen ids never outlived that alarm.
		await expect(syncTables(h)).resolves.toStrictEqual({
			runs: [
				{phase: "idle", applied: 5000, status: "ok", live: 1},
				{phase: "idle", applied: 5000, status: "ok", live: 1},
				{phase: "idle", applied: 4999, status: "ok", live: 1},
			],
			runSystemFroms: 3,
			seen: [],
			seedRequests: [],
		});
	}, 180_000);

	it("backs off on a 429 without losing state", async () => {
		const h = await start();
		rateLimit = true;
		const before = exportCalls;
		const post = await h.mf.dispatchFetch("http://localhost/api/admin/sync", {method: "POST"});
		expect(post.status).toBe(202);
		let result: SyncStatus | undefined;
		for (let i = 0; i < 100; i++) {
			result = await status(h);
			if (result.lastResult?.status === "rate_limited") {
				break;
			}
			await sleep(100);
		}
		expect(result?.lastResult?.status).toBe("rate_limited");
		expect(exportCalls).toBe(before + 1);
		expect(result?.nextAlarmAt).toBeGreaterThan(Date.now() + 100_000);
		await expect(syncTables(h)).resolves.toStrictEqual({
			runs: [{phase: "fetching", applied: 0, status: "rate_limited", live: 1}],
			runSystemFroms: 1,
			seen: [],
			seedRequests: [],
		});
		rateLimit = false;
		await stop(h);
	}, 120_000);

	it("resumes after the object restarts between batches, stamping each alarm run with its own system time", async () => {
		current = makeNodes(5000);
		const first = await start(undefined, {SYNC_BATCHES_PER_TICK: "1", SYNC_TICK_DELAY_MS: "600000"});
		const persistDir = first.persistDir;
		await first.mf.dispatchFetch("http://localhost/api/admin/sync", {method: "POST"});
		let parked: SyncStatus | undefined;
		for (let i = 0; i < 100; i++) {
			parked = await status(first);
			if (parked.applied > 0) {
				break;
			}
			await sleep(100);
		}
		expect(parked).toMatchObject({phase: "importing", applied: 2000});
		const callsBefore = exportCalls;
		await stop(first, true);

		const second = await start(persistDir, {SYNC_BATCHES_PER_TICK: "1", SYNC_TICK_DELAY_MS: "0"});
		await second.mf.dispatchFetch("http://localhost/api/admin/sync", {method: "POST"});
		let done: SyncStatus | undefined;
		for (let i = 0; i < 300; i++) {
			done = await status(second);
			if (done.phase === "idle" && done.lastResult?.status === "ok") {
				break;
			}
			await sleep(100);
		}
		expect(done?.lastResult).toMatchObject({status: "ok", totalNodes: 5000, nodesAdded: 5000, nodesPhasedOut: 0});
		expect(exportCalls).toBe(callsBefore);
		await expect(liveIds(second)).resolves.toHaveLength(5000);
		// Each alarm run is its own unit of work with a fresh system time, so no stamp outlives one run.
		await expect(rowsPerSystemTime(second)).resolves.toStrictEqual([2000, 2000, 1000]);
		// One run version per alarm run; the seen ids are scratch for the run in progress, so none outlive the run.
		await expect(syncTables(second)).resolves.toStrictEqual({
			runs: [
				{phase: "importing", applied: 2000, status: null, live: 0},
				{phase: "importing", applied: 4000, status: null, live: 0},
				{phase: "idle", applied: 5000, status: "ok", live: 1},
			],
			runSystemFroms: 3,
			seen: [],
			seedRequests: [],
		});
		await stop(second);
		rmSync(persistDir, {recursive: true, force: true});
	}, 180_000);

	it("keeps a node written while a run is in flight instead of ending it as absent from the older export", async () => {
		current = makeNodes(3000);
		const h = await start(undefined, {SYNC_BATCHES_PER_TICK: "1", SYNC_TICK_DELAY_MS: "600000"});
		await h.mf.dispatchFetch("http://localhost/api/admin/sync", {method: "POST"});
		let parked: SyncStatus | undefined;
		for (let i = 0; i < 100; i++) {
			parked = await status(h);
			if (parked.applied > 0) {
				break;
			}
			await sleep(100);
		}
		expect(parked).toMatchObject({phase: "importing", applied: 2000});

		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Miniflare types its namespace with undici classes
		const ns = (await h.mf.getDurableObjectNamespace("USER_STORE")) as unknown as DurableObjectNamespace;
		await ns.get(ns.idFromName("dev")).fetch("http://localhost/__seed?name=written-mid-run");

		const done = await runToIdle(h);
		expect(done.lastResult).toMatchObject({status: "ok", totalNodes: 3000, nodesPhasedOut: 0});
		const ids = await liveIds(h);
		expect({count: ids.length, kept: ids.includes("seed-node")}).toStrictEqual({count: 3001, kept: true});
		await stop(h);
	}, 180_000);

	it("reads get_tree_data only on an explicit seed, then catches up from the transaction log with no tree read", async () => {
		current = makeNodes(100);
		treeData = () =>
			Response.json({
				items: [
					{id: uuid(1), prnt: null, pr: 0, nm: "node 0", ct: 1, lm: 2, metadata: {numbered_start: 7}},
					{id: uuid(2), prnt: null, pr: 1, nm: "node 1", ct: 1, lm: 2},
				],
				most_recent_operation_transaction_id: "1",
			});
		internalCalls.length = 0;
		pollStarts.length = 0;
		const h = await start(undefined, internalAuthBindings);
		const seeded = await runToIdle(h, 0, "/api/admin/seed");
		expect(seeded.lastResult).toMatchObject({status: "ok", totalNodes: 100});
		expect(seeded.lastResult?.internalSyncError).toBeUndefined();
		expect(internalCalls.filter((path) => path === "/get_tree_data/")).toStrictEqual(["/get_tree_data/"]);
		await expect(internalMetadata(h)).resolves.toStrictEqual([{node_id: uuid(1), numbered_start: 7}]);
		await expect(treeLog(h)).resolves.toStrictEqual({txId: "1", mirrors: []});
		await expect(syncTables(h).then((tables) => tables.seedRequests)).resolves.toStrictEqual([
			{live: 0, ordered: 1},
		]);

		const mirrored = JSON.stringify({
			id: 4,
			client_timestamp: 300_000_000,
			ops: [
				{
					type: "edit",
					data: {
						projectid: uuid(3),
						metadataPatches: [{op: "add", path: ["mirror", "mirrorRootIds", uuid(4)], value: true}],
					},
				},
			],
		});
		pushAndPoll = () => pollResult("5", {concurrent_remote_operation_transactions: [mirrored]});
		internalCalls.length = 0;
		pollStarts.length = 0;
		const synced = await runToIdle(h, 1);
		expect(synced.lastResult).toMatchObject({status: "ok", totalNodes: 100, nodesUnchanged: 100});
		expect(synced.lastResult?.internalSyncError).toBeUndefined();
		expect({
			treeReads: internalCalls.filter((path) => path === "/get_tree_data/").length,
			pollStarts,
			log: await treeLog(h),
		}).toStrictEqual({
			treeReads: 0,
			pollStarts: ["1"],
			log: {txId: "5", mirrors: [{mirror_id: uuid(4), original_id: uuid(3)}]},
		});
		pushAndPoll = () => pollResult("1");
		await stop(h);
	}, 60_000);

	it("drops a seed requested while the run awaits the export instead of closing it before it began", async () => {
		current = makeNodes(100);
		treeData = () => Response.json({items: [], most_recent_operation_transaction_id: "1"});
		let release = (): void => {};
		exportGate = new Promise((resolve) => {
			release = resolve;
		});
		const reached = new Promise<void>((resolve) => {
			exportReached = resolve;
		});
		const h = await start(undefined, internalAuthBindings);
		await h.mf.dispatchFetch("http://localhost/api/admin/sync", {method: "POST"});
		await reached;
		await sleep(50);
		const seed = await h.mf.dispatchFetch("http://localhost/api/admin/seed", {method: "POST"});
		expect(seed.status).toBe(202);
		release();
		exportGate = undefined;
		exportReached = undefined;
		let done: SyncStatus | undefined;
		for (let i = 0; i < 300; i++) {
			done = await status(h);
			if (done.phase === "idle" && done.lastResult !== null) {
				break;
			}
			await sleep(100);
		}
		expect(done?.lastResult).toMatchObject({status: "ok", totalNodes: 100});
		expect(internalCalls.filter((path) => path === "/get_tree_data/")).toContain("/get_tree_data/");
		// The request was never live before the run's system time, so closing it there would invert its interval.
		await expect(syncTables(h).then((tables) => tables.seedRequests)).resolves.toStrictEqual([]);
		await stop(h);
	}, 60_000);

	it("fails loudly without a seed: the public import completes, the status names the cause, and nothing reads the tree", async () => {
		current = makeNodes(100);
		treeData = () => Response.json({items: [], most_recent_operation_transaction_id: "1"});
		internalCalls.length = 0;
		const h = await start(undefined, internalAuthBindings);
		const done = await runToIdle(h);
		expect(done.lastResult).toMatchObject({status: "ok", totalNodes: 100, nodesAdded: 100});
		expect(done.lastResult?.internalSyncError).toMatch(/no Workflowy transaction id.*POST \/api\/admin\/seed/u);
		expect(internalCalls.filter((path) => path === "/get_tree_data/" || path === "/push_and_poll")).toStrictEqual(
			[],
		);
		await expect(treeLog(h)).resolves.toStrictEqual({txId: null, mirrors: []});
		await stop(h);
	}, 60_000);

	it("fails loudly on need_refreshed_project_tree and does not reseed", async () => {
		current = makeNodes(100);
		treeData = () => Response.json({items: [], most_recent_operation_transaction_id: "1"});
		const h = await start(undefined, internalAuthBindings);
		await runToIdle(h, 0, "/api/admin/seed");
		pushAndPoll = () => pollResult("9", {need_refreshed_project_tree: true});
		internalCalls.length = 0;
		const done = await runToIdle(h, 1);
		expect(done.lastResult).toMatchObject({status: "ok", totalNodes: 100});
		expect(done.lastResult?.internalSyncError).toMatch(/need_refreshed_project_tree.*POST \/api\/admin\/seed/u);
		expect({
			treeReads: internalCalls.filter((path) => path === "/get_tree_data/").length,
			log: await treeLog(h),
		}).toStrictEqual({treeReads: 0, log: {txId: "1", mirrors: []}});
		pushAndPoll = () => pollResult("1");
		await stop(h);
	}, 60_000);

	it("reports a seed request without internal auth instead of reading anything", async () => {
		current = makeNodes(100);
		internalCalls.length = 0;
		const h = await start();
		const done = await runToIdle(h, 0, "/api/admin/seed");
		expect(done.lastResult).toMatchObject({status: "ok", totalNodes: 100});
		expect(done.lastResult?.internalSyncError).toMatch(/internal auth/u);
		expect(internalCalls).toStrictEqual([]);
		await stop(h);
	}, 60_000);

	it("resolves a calendar day from the calendar metadata a /get_tree_data/ import stores, with no backup import", async () => {
		const node = (n: number, name: string, parent: number | null) => ({
			id: uuid(n),
			name,
			note: null,
			parent_id: parent === null ? null : uuid(parent),
			priority: n,
			createdAt: 1,
			modifiedAt: 2,
		});
		current = [
			node(1, "📆 Calendar", null),
			node(2, "2026", 1),
			node(3, "10", 2),
			node(4, '<time startYear="2026" startMonth="10" startDay="27">Tue, Oct 27, 2026</time>', 3),
			node(5, "journal entry", 4),
		];
		const item = (n: number, parent: number | null, calendar: Record<string, unknown>) => ({
			id: uuid(n),
			prnt: parent === null ? null : uuid(parent),
			pr: n,
			nm: current[n - 1]?.name,
			ct: 1,
			lm: 2,
			metadata: {calendar},
		});
		treeData = () =>
			Response.json({
				items: [
					item(1, null, {root: true}),
					item(2, 1, {level: "year", dateId: 20_260_000}),
					item(3, 2, {level: "month", dateId: 20_261_000}),
					item(4, 3, {level: "day", dateId: 20_261_027}),
					{id: uuid(5), prnt: uuid(4), pr: 5, nm: "journal entry", ct: 1, lm: 2},
				],
				most_recent_operation_transaction_id: "1",
			});
		const h = await start(undefined, internalAuthBindings);
		const done = await runToIdle(h, 0, "/api/admin/seed");
		expect(done.lastResult).toMatchObject({status: "ok", totalNodes: 5});
		const response = await h.mf.dispatchFetch("http://localhost/api/v1/calendar/day/20261027");
		expect(response.status).toBe(200);
		await expect(readJson(response)).resolves.toStrictEqual({id: uuid(4), firstChildId: uuid(5)});
		await stop(h);
	}, 60_000);

	it("seeds the account row (its join date is the epoch) from the initialization data when internal auth exists and none is live", async () => {
		current = makeNodes(100);
		treeData = () => Response.json({items: [], most_recent_operation_transaction_id: "1"});
		const h = await start(undefined, internalAuthBindings);
		await expect(accountRows(h)).resolves.toStrictEqual([]);
		const done = await runToIdle(h);
		expect(done.lastResult).toMatchObject({status: "ok"});
		await expect(accountRows(h)).resolves.toStrictEqual([{user_id: 123, date_joined_sec: 1_400_000_000}]);
		await stop(h);
	}, 60_000);

	it("leaves the account table empty when no internal auth exists", async () => {
		current = makeNodes(100);
		const h = await start();
		await runToIdle(h);
		await expect(accountRows(h)).resolves.toStrictEqual([]);
		await stop(h);
	}, 60_000);

	it("skips internal metadata when no internal auth exists", async () => {
		current = makeNodes(100);
		internalCalls.length = 0;
		const h = await start();
		const done = await runToIdle(h);
		expect(done.lastResult).toMatchObject({status: "ok", totalNodes: 100});
		expect(done.lastResult?.internalSyncError).toBeUndefined();
		expect(internalCalls).toStrictEqual([]);
		await expect(internalMetadata(h)).resolves.toStrictEqual([]);
		await stop(h);
	}, 60_000);

	it("completes the public import but reports a get_tree_data failure during a seed", async () => {
		current = makeNodes(100);
		treeData = () => new Response("boom", {status: 500});
		const h = await start(undefined, internalAuthBindings);
		const done = await runToIdle(h, 0, "/api/admin/seed");
		expect(done.lastResult).toMatchObject({status: "ok", totalNodes: 100, nodesAdded: 100});
		expect(done.lastResult?.internalSyncError).toMatch(/\S/u);
		await expect(liveIds(h)).resolves.toHaveLength(100);
		await expect(internalMetadata(h)).resolves.toStrictEqual([]);
		await expect(treeLog(h)).resolves.toStrictEqual({txId: null, mirrors: []});
		await stop(h);
	}, 60_000);
});

describe.skipIf(process.env.CF_SLOW !== "1")("slow: 165k-node export (CF_SLOW=1)", () => {
	it("imports and reports the CPU time", async () => {
		const nodes = makeNodes(165_000);
		const h = await startHarness(
			"./probe-entry.ts",
			"ProbeStore",
			undefined,
			{...bindings, SYNC_BATCHES_PER_TICK: "5"},
			{
				outboundService: (request: Request): Response =>
					new URL(request.url).pathname === "/api/v1/nodes-export"
						? Response.json({nodes})
						: new Response("unexpected", {status: 500}),
			},
		);
		try {
			const started = performance.now();
			const done = await runToIdle(h);
			const wallMs = Math.round(performance.now() - started);
			// oxlint-disable-next-line no-console -- the report is the point of this opt-in test
			console.log(`165k-node sync: wall ${wallMs} ms, in-DO duration ${String(done.lastResult?.durationMs)} ms`);
			expect(done.lastResult).toMatchObject({status: "ok", totalNodes: 165_000, nodesAdded: 165_000});
		} finally {
			await h.dispose();
		}
	}, 1_800_000);
});
