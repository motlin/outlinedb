import {describe, expect, it} from "vite-plus/test";
import {readJson} from "./harness";
import
{
	fakeUpstream,
	internalAuthBindings,
	makeNodes,
	POLL_MS,
	pollResult,
	rows,
	rowsSince,
	runScheduledSyncNow,
	runToIdle,
	sleep,
	status,
	treeLog,
	uuid,
} from "./sync-upstream";
import type {SyncStatus} from "./sync-upstream";

const NEED_REFRESHED =
	"Workflowy answered need_refreshed_project_tree: the cache's transaction id 1 is no longer in the tree's log; run './bin/run.js cache import-api' to reseed it. On the Worker, POST /api/admin/seed instead.";

describe("sync reports internal-API failures", () =>
{
	const up = fakeUpstream();

	it("fails loudly on need_refreshed_project_tree and does not reseed", async () =>
	{
		up.current = makeNodes(100);
		up.treeData = () =>
			Response.json(
				{
					items: [],
					most_recent_operation_transaction_id: "1",
				},
			);
		const h = await up.start(undefined, internalAuthBindings);
		await runToIdle(h, 0, "/api/admin/seed");
		up.pushAndPoll = () =>
			pollResult(
				"9",
				{
					need_refreshed_project_tree: true,
				},
			);
		up.internalCalls.length = 0;
		const done = await runToIdle(h, 1);
		expect(done.lastResult).toMatchObject(
			{
				status: "ok",
				totalNodes: 100,
			},
		);
		expect(done.lastResult?.internalSyncError).toMatch(/need_refreshed_project_tree.*POST \/api\/admin\/seed/u);
		expect(
			{
				treeReads: up.internalCalls.filter((path) => path === "/get_tree_data/").length,
				log: await treeLog(h),
			},
		).toStrictEqual(
			{
				treeReads: 0,
				log:
				{
					txId: "1",
					mirrors: [],
				},
			},
		);

		// The next scheduled catch-up can never succeed without a seed: it says so and stops instead of retrying every minute.
		const beforeStop = await rows(h);
		await runScheduledSyncNow(h);
		let stopped: SyncStatus | undefined;
		for (let i = 0; i < 15_000 / POLL_MS; i++)
		{
			stopped = await status(h);
			if (stopped.lastResult?.status !== "ok")
			{
				break;
			}
			await sleep(POLL_MS);
		}
		const admin = (await readJson(await h.mf.dispatchFetch("http://localhost/api/admin/status"))) as
		{
			lastSync: unknown;
		};
		const needsSeed =
		{
			status: "needs_seed",
			message: NEED_REFRESHED,
			at: expect.any(Number),
		};
		expect(
			{
				status: stopped,
				adminLastSync: admin.lastSync,
				accountSync: await readJson(await h.mf.dispatchFetch("http://localhost/api/v1/sync-status")),
				rows: await rowsSince(h, beforeStop),
			},
		).toStrictEqual(
			{
				status:
				{
					phase: "idle",
					applied: 0,
					// No catch-up is scheduled: only a seed or sync request wakes the job again.
					nextAlarmAt: null,
					lastResult: needsSeed,
					outbox:
					{
						pending: 0,
						oldestEnqueuedAt: null,
						lastError: null,
					},
				},
				adminLastSync: needsSeed,
				accountSync:
				{
					phase: "needs_seed",
					applied: 0,
					error: NEED_REFRESHED,
				},
				// Cost budget: the one run version that records the stop. If these change, justify the new numbers in the commit.
				rows:
				{
					rowsRead: 30,
					rowsWritten: 3,
				},
			},
		);

		// A write meanwhile stays pending: a drain from the stale transaction id could only fail, so none runs until a seed.
		up.internalCalls.length = 0;
		const created = await h.mf.dispatchFetch(
			"http://localhost/api/v1/nodes",
			{
				method: "POST",
				headers:
				{
					"content-type": "application/json",
				},
				body: JSON.stringify(
					{
						parent_id: "None",
						name: "written while stopped",
					},
				),
			},
		);
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Miniflare types its namespace with undici classes
		const ns = (await h.mf.getDurableObjectNamespace("USER_STORE")) as unknown as DurableObjectNamespace;
		const outboxDue = async () =>
			(
				await (
					await ns.get(ns.idFromName("dev")).fetch("http://localhost/__alarm-due?job=outbox")
				).json<
				{
					due: number | null;
				}>()
			).due;
		for (let i = 0; i < 15_000 / POLL_MS && (await outboxDue()) !== null; i++)
		{
			await sleep(POLL_MS);
		}
		expect(
			{
				created: created.status,
				outboxDue: await outboxDue(),
				outbox: (await status(h)).outbox,
				internalCalls: up.internalCalls,
			},
		).toStrictEqual(
			{
				created: 201,
				// The alarm took the drain job without running it.
				outboxDue: null,
				outbox:
				{
					// The create and its placement, waiting for the seed with no error recorded.
					pending: 2,
					oldestEnqueuedAt: expect.any(Number),
					lastError: null,
				},
				internalCalls: [],
			},
		);
		up.pushAndPoll = () => pollResult("1");
		await up.stop(h);
	}, 60_000);

	it("reports a seed request without internal auth instead of reading anything", async () =>
	{
		up.current = makeNodes(100);
		up.internalCalls.length = 0;
		const h = await up.start();
		const done = await runToIdle(h, 0, "/api/admin/seed");
		expect(done.lastResult).toMatchObject(
			{
				status: "ok",
				totalNodes: 100,
			},
		);
		expect(done.lastResult?.internalSyncError).toMatch(/internal auth/u);
		expect(up.internalCalls).toStrictEqual([]);
		await up.stop(h);
	}, 60_000);

	it("resolves a calendar day from the calendar metadata a /get_tree_data/ import stores, with no backup import", async () =>
	{
		const node = (n: number, name: string, parent: number | null) => (
		{
			id: uuid(n),
			name,
			note: null,
			parent_id: parent === null ? null : uuid(parent),
			priority: n,
			createdAt: 1,
			modifiedAt: 2,
		});
		up.current = [
			node(1, "📆 Calendar", null),
			node(2, "2026", 1),
			node(3, "10", 2),
			node(4, '<time startYear="2026" startMonth="10" startDay="27">Tue, Oct 27, 2026</time>', 3),
			node(5, "journal entry", 4),
		];
		const item = (n: number, parent: number | null, calendar: Record<string, unknown>) => (
		{
			id: uuid(n),
			prnt: parent === null ? null : uuid(parent),
			pr: n,
			nm: up.current[n - 1]?.name,
			ct: 1,
			lm: 2,
			metadata:
			{
				calendar,
			},
		});
		up.treeData = () =>
			Response.json(
				{
					items: [
						item(
							1,
							null,
							{
								root: true,
							},
						),
						item(
							2,
							1,
							{
								level: "year",
								dateId: 20_260_000,
							},
						),
						item(
							3,
							2,
							{
								level: "month",
								dateId: 20_261_000,
							},
						),
						item(
							4,
							3,
							{
								level: "day",
								dateId: 20_261_027,
							},
						),
						{
							id: uuid(5),
							prnt: uuid(4),
							pr: 5,
							nm: "journal entry",
							ct: 1,
							lm: 2,
						},
					],
					most_recent_operation_transaction_id: "1",
				},
			);
		const h = await up.start(undefined, internalAuthBindings);
		const done = await runToIdle(h, 0, "/api/admin/seed");
		expect(done.lastResult).toMatchObject(
			{
				status: "ok",
				totalNodes: 5,
			},
		);
		const response = await h.mf.dispatchFetch("http://localhost/api/v1/calendar/day/20261027");
		expect(response.status).toBe(200);
		await expect(readJson(response)).resolves.toStrictEqual(
			{
				id: uuid(4),
				firstChildId: uuid(5),
			},
		);
		await up.stop(h);
	}, 60_000);
});
