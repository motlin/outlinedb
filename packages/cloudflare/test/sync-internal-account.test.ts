import {describe, expect, it} from "vite-plus/test";
import
{
	accountRows,
	fakeUpstream,
	internalAuthBindings,
	internalMetadata,
	liveIds,
	makeNodes,
	runToIdle,
	treeLog,
} from "./sync-upstream";

describe("sync reads internal account data only with internal auth", () =>
{
	const up = fakeUpstream();

	it("seeds the account row (its join date is the epoch) from the initialization data when internal auth exists and none is live", async () =>
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
		await expect(accountRows(h)).resolves.toStrictEqual([]);
		const done = await runToIdle(h);
		expect(done.lastResult).toMatchObject(
			{
				status: "ok",
			},
		);
		await expect(accountRows(h)).resolves.toStrictEqual([
			{
				user_id: "123",
				date_joined_sec: 1_400_000_000,
			},
		]);
		await up.stop(h);
	}, 60_000);

	it("skips internal metadata when no internal auth exists", async () =>
	{
		up.current = makeNodes(100);
		up.internalCalls.length = 0;
		const h = await up.start();
		const done = await runToIdle(h);
		expect(done.lastResult).toMatchObject(
			{
				status: "ok",
				totalNodes: 100,
			},
		);
		expect(done.lastResult?.internalSyncError).toBeUndefined();
		expect(up.internalCalls).toStrictEqual([]);
		await expect(internalMetadata(h)).resolves.toStrictEqual([]);
		await up.stop(h);
	}, 60_000);

	it("completes the public import but reports a get_tree_data failure during a seed", async () =>
	{
		up.current = makeNodes(100);
		up.treeData = () =>
			new Response(
				"boom",
				{
					status: 500,
				},
			);
		const h = await up.start(undefined, internalAuthBindings);
		const done = await runToIdle(h, 0, "/api/admin/seed");
		expect(done.lastResult).toMatchObject(
			{
				status: "ok",
				totalNodes: 100,
				nodesAdded: 100,
			},
		);
		expect(done.lastResult?.internalSyncError).toMatch(/\S/u);
		await expect(liveIds(h)).resolves.toHaveLength(100);
		await expect(internalMetadata(h)).resolves.toStrictEqual([]);
		await expect(treeLog(h)).resolves.toStrictEqual(
			{
				txId: null,
				mirrors: [],
			},
		);
		await up.stop(h);
	}, 60_000);
});
