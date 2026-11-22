import {describe, expect, it} from "vite-plus/test";
import {readJson} from "./harness";
import
{
	fakeUpstream,
	files,
	internalAuthBindings,
	internalMetadata,
	makeNodes,
	POLL_MS,
	pollResult,
	rows,
	rowsSince,
	runScheduledSyncNow,
	runToIdle,
	sleep,
	status,
	syncTables,
	treeLog,
	uuid,
} from "./sync-upstream";
import type {Harness} from "./harness";
import type {SyncStatus} from "./sync-upstream";

/** Bring the scheduled catch-up forward to now and wait until it has run and scheduled the next one ten minutes out. */
async function catchUpNow(h: Harness): Promise<SyncStatus>
{
	await runScheduledSyncNow(h);
	for (let i = 0; i < 15_000 / POLL_MS; i++)
	{
		const current = await status(h);
		if ((current.nextAlarmAt ?? 0) > Date.now() + 540_000)
		{
			return current;
		}
		await sleep(POLL_MS);
	}
	throw new Error("the catch-up did not finish");
}

describe("sync seeds from get_tree_data only on request", () =>
{
	const up = fakeUpstream();

	it("reads get_tree_data only on an explicit seed, then a scheduled run catches up from the transaction log with no export or tree read", async () =>
	{
		up.current = makeNodes(100);
		up.treeData = () =>
			Response.json(
				{
					items: [
						{
							id: uuid(1),
							prnt: null,
							pr: 0,
							nm: "node 0",
							ct: 1,
							lm: 2,
							metadata:
							{
								numbered_start: 7,
							},
						},
						{
							id: uuid(2),
							prnt: null,
							pr: 1,
							nm: "node 1",
							ct: 1,
							lm: 2,
							metadata:
							{
								s3File:
								{
									isFile: true,
									fileName: "example-photo.jpg",
									fileType: "image/jpeg",
									isAnimatedGIF: false,
									imageOriginalWidth: 1536,
									imageOriginalHeight: 2048,
									imageOriginalPixels: 1,
								},
								layoutMode: "bullets",
							},
						},
					],
					most_recent_operation_transaction_id: "1",
				},
			);
		up.internalCalls.length = 0;
		up.pollStarts.length = 0;
		// Ten minutes, so the scheduled run never fires on its own; the test brings it forward once upstream is set up.
		const h = await up.start(
			undefined,
			{
				...internalAuthBindings,
				SYNC_INTERVAL_MINUTES: "10",
			},
		);
		const seeded = await runToIdle(h, 0, "/api/admin/seed");
		expect(seeded.nextAlarmAt).toBeGreaterThan(Date.now() + 540_000);
		expect(seeded.nextAlarmAt).toBeLessThanOrEqual(Date.now() + 600_000);
		expect(seeded.lastResult).toMatchObject(
			{
				status: "ok",
				totalNodes: 100,
			},
		);
		expect(seeded.lastResult?.internalSyncError).toBeUndefined();
		expect(up.internalCalls.filter((path) => path === "/get_tree_data/")).toStrictEqual(["/get_tree_data/"]);
		await expect(internalMetadata(h)).resolves.toStrictEqual([
			{
				node_id: uuid(1),
				numbered_start: 7,
			},
		]);
		await expect(files(h)).resolves.toStrictEqual([
			{
				node_id: uuid(2),
				file_name: "example-photo.jpg",
			},
		]);
		await expect(treeLog(h)).resolves.toStrictEqual(
			{
				txId: "1",
				mirrors: [],
			},
		);
		await expect(syncTables(h).then((tables) => tables.seedRequests)).resolves.toStrictEqual([
			{
				live: 0,
				ordered: 1,
			},
		]);

		// The first catch-up after the seed finds nothing new: it records its caught_up result once, and nothing else.
		const beforeFirst = await rows(h);
		const first = await catchUpNow(h);
		expect(
			{
				result: first.lastResult,
				rows: await rowsSince(h, beforeFirst),
			},
		).toStrictEqual(
			{
				result:
				{
					status: "caught_up",
					finishedAt: expect.any(Number),
					durationMs: expect.any(Number),
				},
				// Cost budget: one run version for the new result. If these change, justify the new numbers in the commit.
				rows:
				{
					rowsRead: 25,
					rowsWritten: 3,
				},
			},
		);

		const mirrored = JSON.stringify(
			{
				id: 4,
				client_timestamp: 300_000_000,
				ops: [
					{
						type: "edit",
						data:
						{
							projectid: uuid(3),
							metadataPatches: [
								{
									op: "add",
									path: ["mirror", "mirrorRootIds", uuid(4)],
									value: true,
								},
							],
						},
					},
				],
			},
		);
		up.pushAndPoll = () =>
			pollResult(
				"5",
				{
					concurrent_remote_operation_transactions: [mirrored],
				},
			);
		up.internalCalls.length = 0;
		up.pollStarts.length = 0;
		const exportsBefore = up.exportCalls;
		const beforeMirrored = await rows(h);
		const synced = await catchUpNow(h);
		expect(
			{
				result: synced.lastResult,
				rows: await rowsSince(h, beforeMirrored),
			},
		).toStrictEqual(
			{
				result:
				{
					status: "caught_up",
					finishedAt: expect.any(Number),
					durationMs: expect.any(Number),
				},
				// Cost budget: the one mirror the transaction adds and the new transaction id, with the result unchanged, so
				// no run version. If these change, justify the new numbers in the commit.
				rows:
				{
					rowsRead: 49,
					rowsWritten: 20,
				},
			},
		);
		expect(synced.nextAlarmAt).toBeLessThanOrEqual(Date.now() + 600_000);
		expect(
			{
				exports: up.exportCalls - exportsBefore,
				treeReads: up.internalCalls.filter((path) => path === "/get_tree_data/").length,
				firstPollStart: up.pollStarts[0],
				log: await treeLog(h),
			},
		).toStrictEqual(
			{
				exports: 0,
				treeReads: 0,
				firstPollStart: "1",
				log:
				{
					txId: "5",
					mirrors: [
						{
							mirror_id: uuid(4),
							original_id: uuid(3),
						},
					],
				},
			},
		);

		// A quiet minute: the catch-up finds nothing new, and writes no more than the alarm's own bookkeeping.
		up.pushAndPoll = () => pollResult("5");
		const beforeQuiet = await rows(h);
		await catchUpNow(h);
		expect(
			{
				polls: up.pollStarts,
				rows: await rowsSince(h, beforeQuiet),
			},
		).toStrictEqual(
			{
				polls: ["1", "5"],
				// Cost budget: a quiet catch-up writes nothing, and reads only what it needs to find nothing changed. If these
				// change, justify the new numbers in the commit.
				rows:
				{
					rowsRead: 31,
					rowsWritten: 0,
				},
			},
		);
		up.pushAndPoll = () => pollResult("1");
		await up.stop(h);
	}, 60_000);

	it("keeps the seed request live until the tree read lands, so a run cut off mid-read seeds again on its retry", async () =>
	{
		up.current = makeNodes(100);
		up.treeData = () =>
			Response.json(
				{
					items: [],
					most_recent_operation_transaction_id: "1",
				},
			);
		let release = (): void =>
		{
		};
		up.treeGate = new Promise((resolve) =>
		{
			release = resolve;
		});
		const reached = new Promise<void>((resolve) =>
		{
			up.treeReached = resolve;
		});
		const h = await up.start(undefined, internalAuthBindings);
		await h.mf.dispatchFetch(
			"http://localhost/api/admin/seed",
			{
				method: "POST",
			},
		);
		await reached;
		const whileReading = (await syncTables(h)).seedRequests;
		release();
		up.treeGate = undefined;
		up.treeReached = undefined;
		let done: SyncStatus | undefined;
		for (let i = 0; i < 30_000 / POLL_MS; i++)
		{
			done = await status(h);
			if (done.phase === "idle" && done.lastResult !== null)
			{
				break;
			}
			await sleep(POLL_MS);
		}
		expect(
			{
				whileReading,
				result: done?.lastResult?.status,
				afterwards: (await syncTables(h)).seedRequests,
			},
		).toStrictEqual(
			{
				whileReading: [
					{
						live: 1,
						ordered: 1,
					},
				],
				result: "ok",
				afterwards: [
					{
						live: 0,
						ordered: 1,
					},
				],
			},
		);
		await up.stop(h);
	}, 60_000);

	it("drops a seed requested while the run awaits the export instead of closing it before it began", async () =>
	{
		up.current = makeNodes(100);
		up.treeData = () =>
			Response.json(
				{
					items: [],
					most_recent_operation_transaction_id: "1",
				},
			);
		let release = (): void =>
		{
		};
		up.exportGate = new Promise((resolve) =>
		{
			release = resolve;
		});
		const reached = new Promise<void>((resolve) =>
		{
			up.exportReached = resolve;
		});
		const h = await up.start(undefined, internalAuthBindings);
		const accountSync = async () => readJson(await h.mf.dispatchFetch("http://localhost/api/v1/sync-status"));
		const beforeFirstRun = await accountSync();
		await h.mf.dispatchFetch(
			"http://localhost/api/admin/sync",
			{
				method: "POST",
			},
		);
		await reached;
		await sleep(50);
		const whileFetching = await accountSync();
		const seed = await h.mf.dispatchFetch(
			"http://localhost/api/admin/seed",
			{
				method: "POST",
			},
		);
		expect(seed.status).toBe(202);
		release();
		up.exportGate = undefined;
		up.exportReached = undefined;
		let done: SyncStatus | undefined;
		for (let i = 0; i < 30_000 / POLL_MS; i++)
		{
			done = await status(h);
			if (done.phase === "idle" && done.lastResult !== null)
			{
				break;
			}
			await sleep(POLL_MS);
		}
		expect(done?.lastResult).toMatchObject(
			{
				status: "ok",
				totalNodes: 100,
			},
		);
		// The signed-in user's own view of the sync, which the empty outline shows until the first import lands.
		expect(
			{
				beforeFirstRun,
				whileFetching,
				afterwards: await accountSync(),
			},
		).toStrictEqual(
			{
				beforeFirstRun:
				{
					phase: "waiting",
					applied: 0,
				},
				whileFetching:
				{
					phase: "fetching",
					applied: 0,
				},
				afterwards:
				{
					phase: "idle",
					applied: 0,
				},
			},
		);
		expect(up.internalCalls.filter((path) => path === "/get_tree_data/")).toContain("/get_tree_data/");
		// The request was never live before the run's system time, so closing it there would invert its interval.
		await expect(syncTables(h).then((tables) => tables.seedRequests)).resolves.toStrictEqual([]);
		await up.stop(h);
	}, 60_000);

	it("fails loudly without a seed: the public import completes, the status names the cause, and nothing reads the tree", async () =>
	{
		up.current = makeNodes(100);
		up.treeData = () =>
			Response.json(
				{
					items: [],
					most_recent_operation_transaction_id: "1",
				},
			);
		up.internalCalls.length = 0;
		const h = await up.start(undefined, internalAuthBindings);
		const done = await runToIdle(h);
		expect(done.lastResult).toMatchObject(
			{
				status: "ok",
				totalNodes: 100,
				nodesAdded: 100,
			},
		);
		expect(done.lastResult?.internalSyncError).toMatch(/no Workflowy transaction id.*POST \/api\/admin\/seed/u);
		expect(
			up.internalCalls.filter((path) => path === "/get_tree_data/" || path === "/push_and_poll"),
		).toStrictEqual([]);
		await expect(treeLog(h)).resolves.toStrictEqual(
			{
				txId: null,
				mirrors: [],
			},
		);
		await up.stop(h);
	}, 60_000);
});
