import {describe, expect, it} from "vite-plus/test";
import {readJson, startHarness} from "./harness";
import
{
	bindings,
	fakeUpstream,
	liveIds,
	makeNodes,
	POLL_MS,
	rows,
	rowsSince,
	runToIdle,
	sleep,
	status,
	syncTables,
} from "./sync-upstream";
import type {SyncStatus} from "./sync-upstream";

describe("sync imports a fake upstream's export", () =>
{
	const up = fakeUpstream();

	it("imports a 50-node export, keeps a raw copy in R2, then reports no changes and phases out a removed node", async () =>
	{
		const h = await up.start();
		const first = await runToIdle(h);
		expect(first.lastResult).toMatchObject(
			{
				status: "ok",
				totalNodes: 50,
				nodesAdded: 50,
				nodesUnchanged: 0,
				nodesPhasedOut: 0,
			},
		);
		expect(up.auths).toStrictEqual(["Bearer fake-key-value"]);
		await expect(liveIds(h)).resolves.toHaveLength(50);

		const exportKey = first.lastResult?.exportKey ?? "";
		expect(exportKey).toMatch(/^exports\/.+\.json$/u);
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Miniflare types its bucket with undici classes
		const bucket = (await h.mf.getR2Bucket("SNAPSHOTS")) as unknown as R2Bucket;
		const stored = await bucket.get(exportKey);
		expect(JSON.parse((await stored?.text()) ?? "null")).toStrictEqual(
			{
				nodes: up.current,
			},
		);

		const beforeSecond = await rows(h);
		const second = await runToIdle(h, 1);
		const
		{
			exportKey: _exportKey,
			finishedAt: _finishedAt,
			durationMs: _durationMs,
			...secondResult
		} = second.lastResult ?? {};
		expect(
			{
				result: secondResult,
				rows: await rowsSince(h, beforeSecond),
			},
		).toStrictEqual(
			{
				result:
				{
					status: "ok",
					totalNodes: 50,
					nodesAdded: 0,
					nodesUpdated: 0,
					nodesUnchanged: 50,
					nodesDeleted: 0,
					nodesPhasedOut: 0,
					contentUpdated: 0,
					metadataUpdated: 0,
					priorityUpdated: 0,
					// Up to the run's final record, which the meter reading below includes.
					rowsRead: 1442,
					rowsWritten: 9,
				},
				// Cost budget: an identical export writes only the run's own bookkeeping and reads the stored rows it compares,
				// never a row per node more than that. If these change, justify the new numbers in the commit.
				rows:
				{
					rowsRead: 1468,
					rowsWritten: 14,
				},
			},
		);

		up.current = makeNodes(50, new Map([[20, "renamed"]])).slice(0, 49);
		const third = await runToIdle(h, 2);
		expect(third.lastResult).toMatchObject(
			{
				status: "ok",
				nodesUpdated: 1,
				nodesPhasedOut: 1,
			},
		);
		await expect(liveIds(h)).resolves.toHaveLength(49);
		// The next scheduled run is the short catch-up, a minute out, not another export half an hour out.
		expect(third.nextAlarmAt).toBeGreaterThan(Date.now());
		expect(third.nextAlarmAt).toBeLessThanOrEqual(Date.now() + 60_000);
		expect(third.outbox).toStrictEqual(
			{
				pending: 0,
				oldestEnqueuedAt: null,
				lastError: null,
			},
		);
		// Each run finished inside one alarm, so each is one live version. Cost budget: the first import writes every node's
		// rows, the identical one only its bookkeeping, and the one-rename-one-removal run a handful more. If these change,
		// justify the new numbers in the commit.
		await expect(syncTables(h)).resolves.toStrictEqual(
			{
				runs: [
					{
						phase: "idle",
						applied: 50,
						status: "ok",
						rowsRead: 1999,
						rowsWritten: 518,
						live: 1,
					},
					{
						phase: "idle",
						applied: 50,
						status: "ok",
						rowsRead: 1442,
						rowsWritten: 9,
						live: 1,
					},
					{
						phase: "idle",
						applied: 49,
						status: "ok",
						rowsRead: 1525,
						rowsWritten: 29,
						live: 1,
					},
				],
				runSystemFroms: 3,
				seedRequests: [],
			},
		);

		// Once the owners list no longer names this object, it drops the scheduled catch-up instead of ticking on.
		await up.stop(h, true);
		const demoted = await up.start(
			h.persistDir,
			{
				OUTLINEDB_ENV_OWNERS: "someone-else",
			},
		);
		await expect(status(demoted).then((current) => current.nextAlarmAt)).resolves.toBeNull();
		await up.stop(demoted);
	}, 180_000);

	it("backs off on a 429 without losing state", async () =>
	{
		const h = await up.start();
		up.rateLimit = true;
		const before = up.exportCalls;
		const post = await h.mf.dispatchFetch(
			"http://localhost/api/admin/sync",
			{
				method: "POST",
			},
		);
		expect(post.status).toBe(202);
		let result: SyncStatus | undefined;
		for (let i = 0; i < 10_000 / POLL_MS; i++)
		{
			result = await status(h);
			if (result.lastResult?.status === "rate_limited")
			{
				break;
			}
			await sleep(POLL_MS);
		}
		expect(result?.lastResult?.status).toBe("rate_limited");
		expect(up.exportCalls).toBe(before + 1);
		expect(result?.nextAlarmAt).toBeGreaterThan(Date.now() + 100_000);
		await expect(syncTables(h)).resolves.toStrictEqual(
			{
				runs: [
					{
						phase: "fetching",
						applied: 0,
						status: "rate_limited",
						// Cost budget: a rate-limited fetch writes only its run version. Justify any change in the commit.
						rowsRead: 5,
						rowsWritten: 6,
						live: 1,
					},
				],
				runSystemFroms: 1,
				seedRequests: [],
			},
		);
		up.rateLimit = false;
		await up.stop(h);
	}, 120_000);

	it("reports a failed first export to the signed-in user instead of waiting for it forever", async () =>
	{
		const h = await up.start();
		up.exportFails = true;
		const done = await runToIdle(h);
		up.exportFails = false;
		expect(
			{
				result: done.lastResult?.status,
				accountSync: await readJson(await h.mf.dispatchFetch("http://localhost/api/v1/sync-status")),
			},
		).toStrictEqual(
			{
				result: "error",
				accountSync:
				{
					phase: "failed",
					applied: 0,
					error: "nodes-export failed with 500",
					retriesOnSchedule: false,
				},
			},
		);
		await up.stop(h);
	}, 60_000);
});

describe.skipIf(process.env.CF_SLOW !== "1")("slow: 165k-node export (CF_SLOW=1)", () =>
{
	it("imports and reports the CPU time", async () =>
	{
		const nodes = makeNodes(165_000);
		const h = await startHarness(
			"./probe-entry.ts",
			"ProbeStore",
			undefined,
			{
				...bindings,
				SYNC_BATCHES_PER_TICK: "5",
			},
			{
				outboundService: (request: Request): Response =>
					new URL(request.url).pathname === "/api/v1/nodes-export"
						? Response.json(
								{
									nodes,
								},
							)
						: new Response(
								"unexpected",
								{
									status: 500,
								},
							),
			},
		);
		try
		{
			const started = performance.now();
			const done = await runToIdle(h);
			const wallMs = Math.round(performance.now() - started);
			// oxlint-disable-next-line no-console -- the report is the point of this opt-in test
			console.log(`165k-node sync: wall ${wallMs} ms, in-DO duration ${String(done.lastResult?.durationMs)} ms`);
			expect(done.lastResult).toMatchObject(
				{
					status: "ok",
					totalNodes: 165_000,
					nodesAdded: 165_000,
				},
			);
		}
		finally
		{
			await h.dispose();
		}
	}, 1_800_000);
});
