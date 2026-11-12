import {describe, expect, it} from "vite-plus/test";
import {PendingCreates} from "../src/client/pending-creates.js";
import type {NodeResponse} from "../src/node-types.js";

function row(id: string, priority: number, parentId = "p"): NodeResponse
{
	return {
		id,
		parent_id: parentId,
		name: id,
		note: null,
		priority,
		data:
		{
			layoutMode: null,
		},
		createdAt: null,
		modifiedAt: null,
		completedAt: null,
	};
}

/** Whether `promise` has settled after the microtask queue drains. */
async function isSettled(promise: Promise<void>): Promise<boolean>
{
	let settled = false;
	void (async () =>
	{
		await promise;
		settled = true;
	})();
	await new Promise((resolve) =>
	{
		setTimeout(resolve, 0);
	});
	return settled;
}

describe("PendingCreates", () =>
{
	it("keeps a pending row that a racing children refetch does not have yet, at its slot", () =>
	{
		const pending = new PendingCreates();
		pending.begin(row("new", 0), 1);
		expect(pending.withPending("p", [row("a", 100), row("b", 200)]).map((child) => child.id)).toStrictEqual([
			"a",
			"new",
			"b",
		]);
	});

	it("leaves other parents' lists and rows the server already returned alone", () =>
	{
		const pending = new PendingCreates();
		pending.begin(row("new", 0), 0);
		const fetched = [row("a", 100), row("new", 150)];
		expect(
			{
				other: pending.withPending("q", [row("x", 100, "q")]).map((child) => child.id),
				same: pending.withPending("p", fetched),
			},
		).toStrictEqual(
			{
				other: ["x"],
				same: fetched,
			},
		);
	});

	it("holds requests naming a pending node until its create settles, then forgets the row", async () =>
	{
		const pending = new PendingCreates();
		pending.begin(row("new", 0), 0);
		const waiting = pending.settled(["new", "unrelated", null]);
		const before = await isSettled(waiting);
		pending.end("new");
		expect(
			{
				before,
				after: await isSettled(waiting),
				rows: pending.withPending("p", []).length,
			},
		).toStrictEqual(
			{
				before: false,
				after: true,
				rows: 0,
			},
		);
	});

	it("sends creates in order: a create waits for every create registered before it", async () =>
	{
		const pending = new PendingCreates();
		pending.begin(row("first", 0), 0);
		pending.begin(row("second", 0), 1);
		const second = pending.prior("second");
		const first = pending.prior("first");
		const blocked = await isSettled(second);
		pending.end("first");
		expect(
			{
				first: await isSettled(first),
				blocked,
				released: await isSettled(second),
			},
		).toStrictEqual(
			{
				first: true,
				blocked: false,
				released: true,
			},
		);
	});
});
