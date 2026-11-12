import {afterAll, beforeAll, describe, expect, it} from "vite-plus/test";
import {startHarness} from "./harness";
import type {Harness} from "./harness";

const event =
{
	verb: "move",
	nodeId: "node-1",
	name: "Write the report",
	fromTier: "3",
	toTier: "1",
	at: "2026-10-27T00:00:00.000Z",
};

async function publish(mf: Harness["mf"]): Promise<void>
{
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Miniflare types its namespace with undici classes
	const ns = (await mf.getDurableObjectNamespace("USER_STORE")) as unknown as DurableObjectNamespace;
	await ns.get(ns.idFromName("dev")).fetch(
		"http://localhost/__publish",
		{
			method: "POST",
		},
	);
}

const settle = async (): Promise<void> =>
	new Promise((resolve) =>
	{
		setTimeout(resolve, 200);
	});

async function nextFrame(ws: {
	addEventListener(type: "message", fn: (e: {data: unknown}) => void): void;
}): Promise<unknown>
{
	return new Promise((resolve) =>
	{
		ws.addEventListener("message", (e) =>
		{
			resolve(e.data);
		});
	});
}

describe("the ladder WebSocket on the Durable Object", () =>
{
	let harness: Harness;
	beforeAll(async () =>
	{
		harness = await startHarness("./probe-entry.ts", "ProbeStore");
	}, 60_000);
	afterAll(async () =>
	{
		await harness.dispose();
	});

	it("rejects a non-upgrade request to the events path", async () =>
	{
		const response = await harness.mf.dispatchFetch("http://localhost/api/v1/ladder/events");
		expect(response.status).toBe(426);
	});

	it("answers a non-upgrade request to the Durable Object itself with 404, since the 426 check lives in the Worker", async () =>
	{
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Miniflare types its namespace with undici classes
		const ns = (await harness.mf.getDurableObjectNamespace("USER_STORE")) as unknown as DurableObjectNamespace;
		const response = await ns.get(ns.idFromName("dev")).fetch("http://localhost/api/v1/ladder/events");
		expect(response.status).toBe(404);
	});

	it("sends exactly one frame per event and nothing after close", async () =>
	{
		const response = await harness.mf.dispatchFetch(
			"http://localhost/api/v1/ladder/events",
			{
				headers:
				{
					Upgrade: "websocket",
				},
			},
		);
		expect(response.status).toBe(101);
		const ws = response.webSocket;
		if (!ws)
		{
			throw new Error("no websocket on the response");
		}
		ws.accept();
		const frames: unknown[] = [];
		ws.addEventListener("message", (e) =>
		{
			frames.push(e.data);
		});
		const first = nextFrame(ws);
		await publish(harness.mf);
		await expect(first).resolves.toBe(JSON.stringify(event));
		expect(frames).toStrictEqual([JSON.stringify(event)]);

		ws.close();
		await settle();
		await publish(harness.mf);
		await settle();
		expect(frames).toStrictEqual([JSON.stringify(event)]);
	});
});
