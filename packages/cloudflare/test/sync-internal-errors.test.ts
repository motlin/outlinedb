import {describe, expect, it} from "vite-plus/test";
import {readJson} from "./harness";
import {fakeUpstream, internalAuthBindings, makeNodes, pollResult, runToIdle, treeLog, uuid} from "./sync-upstream";

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
