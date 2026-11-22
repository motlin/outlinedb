import {describe, expect, it} from "vite-plus/test";
import {rmSync} from "node:fs";
import
{
	accountRows,
	fakeUpstream,
	liveIds,
	makeNodes,
	POLL_MS,
	rowsPerSystemTime,
	rows,
	rowsSince,
	runToIdle,
	sleep,
	status,
	syncTables,
} from "./sync-upstream";
import type {SyncStatus} from "./sync-upstream";

describe("sync resumes and keeps local writes across runs", () =>
{
	const up = fakeUpstream();

	it("resumes after the object restarts between batches, stamping each alarm run with its own system time", async () =>
	{
		// Every node carries a tag, so each batch's node_tags rewrite is part of what the run versions below meter.
		up.current = makeNodes(
			50,
			new Map(
				Array.from(
					{
						length: 50,
					},
					(_, i) => [i, `node ${i} #tag`],
				),
			),
		);
		const first = await up.start(
			undefined,
			{
				SYNC_BATCHES_PER_TICK: "1",
				SYNC_TICK_DELAY_MS: "600000",
			},
		);
		const persistDir = first.persistDir;
		await first.mf.dispatchFetch(
			"http://localhost/api/admin/sync",
			{
				method: "POST",
			},
		);
		let parked: SyncStatus | undefined;
		for (let i = 0; i < 10_000 / POLL_MS; i++)
		{
			parked = await status(first);
			if (parked.applied > 0)
			{
				break;
			}
			await sleep(POLL_MS);
		}
		expect(parked).toMatchObject(
			{
				phase: "importing",
				applied: 20,
			},
		);
		const callsBefore = up.exportCalls;
		await up.stop(first, true);

		const second = await up.start(
			persistDir,
			{
				SYNC_BATCHES_PER_TICK: "1",
				SYNC_TICK_DELAY_MS: "0",
			},
		);
		await second.mf.dispatchFetch(
			"http://localhost/api/admin/sync",
			{
				method: "POST",
			},
		);
		let done: SyncStatus | undefined;
		for (let i = 0; i < 30_000 / POLL_MS; i++)
		{
			done = await status(second);
			if (done.phase === "idle" && done.lastResult?.status === "ok")
			{
				break;
			}
			await sleep(POLL_MS);
		}
		expect(done?.lastResult).toMatchObject(
			{
				status: "ok",
				totalNodes: 50,
				nodesAdded: 50,
				nodesPhasedOut: 0,
			},
		);
		expect(up.exportCalls).toBe(callsBefore);
		await expect(liveIds(second)).resolves.toHaveLength(50);
		// Each alarm run is its own unit of work with a fresh system time, so no stamp outlives one run.
		await expect(rowsPerSystemTime(second)).resolves.toStrictEqual([20, 20, 10]);
		// One run version per alarm run, each carrying the rows the run has read and written so far. Cost budget: a batch
		// rewrites its own nodes' content, metadata and tag rows, never an earlier batch's, so each alarm run adds a share
		// proportional to its batch. If these change, justify the new numbers in the commit.
		await expect(syncTables(second)).resolves.toStrictEqual(
			{
				runs: [
					{
						phase: "importing",
						applied: 20,
						status: null,
						rowsRead: 430,
						rowsWritten: 272,
						live: 0,
					},
					{
						phase: "importing",
						applied: 40,
						status: null,
						rowsRead: 854,
						rowsWritten: 538,
						live: 0,
					},
					{
						phase: "idle",
						applied: 50,
						status: "ok",
						rowsRead: 1473,
						rowsWritten: 674,
						live: 1,
					},
				],
				runSystemFroms: 3,
				seedRequests: [],
			},
		);

		// An identical export spanning three alarm runs changes nothing, so the nodes an earlier alarm run passed over
		// count as seen only from the export's applied prefix; otherwise the finish would phase them out.
		const beforeAgain = await rows(second);
		const again = await runToIdle(second, 1);
		const
		{
			exportKey: _exportKey,
			finishedAt: _finishedAt,
			durationMs: _durationMs,
			...againResult
		} = again.lastResult ?? {};
		expect(
			{
				result: againResult,
				live: (await liveIds(second)).length,
				rows: await rowsSince(second, beforeAgain),
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
					rowsRead: 508,
					rowsWritten: 15,
				},
				live: 50,
				// Cost budget: a version of the run per alarm run, and no row written per node. If these change, justify the
				// new numbers in the commit.
				rows:
				{
					rowsRead: 568,
					rowsWritten: 26,
				},
			},
		);
		await up.stop(second);
		rmSync(
			persistDir,
			{
				recursive: true,
				force: true,
			},
		);
	}, 180_000);

	it("keeps a node written while a run is in flight instead of ending it as absent from the older export", async () =>
	{
		up.current = makeNodes(30);
		const h = await up.start(
			undefined,
			{
				SYNC_BATCHES_PER_TICK: "1",
				SYNC_TICK_DELAY_MS: "600000",
			},
		);
		await h.mf.dispatchFetch(
			"http://localhost/api/admin/sync",
			{
				method: "POST",
			},
		);
		let parked: SyncStatus | undefined;
		for (let i = 0; i < 10_000 / POLL_MS; i++)
		{
			parked = await status(h);
			if (parked.applied > 0)
			{
				break;
			}
			await sleep(POLL_MS);
		}
		expect(parked).toMatchObject(
			{
				phase: "importing",
				applied: 20,
			},
		);

		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Miniflare types its namespace with undici classes
		const ns = (await h.mf.getDurableObjectNamespace("USER_STORE")) as unknown as DurableObjectNamespace;
		await ns.get(ns.idFromName("dev")).fetch("http://localhost/__seed?name=written-mid-run");

		const done = await runToIdle(h);
		expect(done.lastResult).toMatchObject(
			{
				status: "ok",
				totalNodes: 30,
				nodesPhasedOut: 0,
			},
		);
		const ids = await liveIds(h);
		expect(
			{
				count: ids.length,
				kept: ids.includes("seed-node"),
			},
		).toStrictEqual(
			{
				count: 31,
				kept: true,
			},
		);
		await up.stop(h);
	}, 180_000);

	it("leaves the account table empty when no internal auth exists", async () =>
	{
		up.current = makeNodes(100);
		const h = await up.start();
		await runToIdle(h);
		await expect(accountRows(h)).resolves.toStrictEqual([]);
		await up.stop(h);
	}, 60_000);
});
