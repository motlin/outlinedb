import {afterAll, beforeAll, describe, expect, it} from "vite-plus/test";
import {readJson, startHarness} from "./harness";
import type {Harness} from "./harness";

const sleep = async (ms: number): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

interface EmbeddingState {
	status: string | null;
	indexed: string[];
	batches: number[];
}

interface AdminStatus {
	embeddings: {phase: string; queued: number} | null;
}

async function probe(h: Harness, path: string): Promise<unknown> {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Miniflare types its namespace with undici classes
	const ns = (await h.mf.getDurableObjectNamespace("USER_STORE")) as unknown as DurableObjectNamespace;
	return (await ns.get(ns.idFromName("dev")).fetch(`http://localhost${path}`)).json();
}

async function node(h: Harness, id: string, name: string, parent?: string): Promise<void> {
	const params = new URLSearchParams({id, name, ...(parent === undefined ? {} : {parent})});
	await probe(h, `/__node?${params.toString()}`);
}

async function embeddingState(h: Harness): Promise<EmbeddingState> {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test reads its own probe
	return (await probe(h, "/__embeddings")) as EmbeddingState;
}

async function adminStatus(h: Harness): Promise<AdminStatus> {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test reads its own endpoint
	return (await readJson(await h.mf.dispatchFetch("http://localhost/api/admin/status"))) as AdminStatus;
}

async function related(h: Harness, nodeId: string): Promise<{status: number; ids: string[]}> {
	const response = await h.mf.dispatchFetch("http://localhost/api/related", {
		method: "POST",
		headers: {"content-type": "application/json"},
		body: JSON.stringify({nodeId, type: "similar", threshold: 2}),
	});
	const body = await readJson(response);
	const results = typeof body === "object" && body !== null && "results" in body ? body.results : [];
	return {
		status: response.status,
		ids: Array.isArray(results) ? results.map((r: {id: string}) => r.id).toSorted() : [],
	};
}

async function untilIdle(h: Harness, phase: string): Promise<AdminStatus> {
	for (let i = 0; i < 200; i++) {
		const current = await adminStatus(h);
		if (current.embeddings?.phase === phase && current.embeddings.queued === 0) {
			return current;
		}
		await sleep(50);
	}
	throw new Error(`embeddings did not reach ${phase}: ${JSON.stringify(await adminStatus(h))}`);
}

describe("related notes on the Worker", () => {
	let h: Harness;

	beforeAll(async () => {
		h = await startHarness("./embedding-probe-entry.ts", "EmbeddingProbeStore", undefined, {
			ACCESS_DEV_IDENTITY: "dev",
			AI: "bound",
			RELATED_INDEX: "bound",
		});
	}, 120_000);

	afterAll(async () => {
		await h.dispose();
	});

	it("embeds nothing until AI is enabled", async () => {
		await node(h, "garden", "Garden");
		await node(h, "tomatoes", "Tomatoes", "garden");
		await node(h, "basil", "Basil", "garden");
		await node(h, "kitchen", "Kitchen");
		await node(h, "recipes", "Recipes", "kitchen");
		await expect(related(h, "garden")).resolves.toStrictEqual({status: 404, ids: []});
		await expect(adminStatus(h)).resolves.toMatchObject({embeddings: {phase: "off", queued: 0}});
		await expect(embeddingState(h)).resolves.toStrictEqual({status: null, indexed: [], batches: []});
	});

	it("backfills every container once Enable AI requests it, then marks the status finished", async () => {
		await probe(h, "/__ai-status?value=requested");
		await related(h, "garden");
		await untilIdle(h, "ready");
		await expect(embeddingState(h)).resolves.toStrictEqual({
			status: "finished",
			indexed: ["garden", "kitchen"],
			batches: [2],
		});
		await expect(related(h, "garden")).resolves.toStrictEqual({status: 200, ids: ["kitchen"]});
	});

	it("embeds a node that gained a child after an app write, leaving unchanged neighbours alone", async () => {
		await node(h, "pesto", "Pesto", "basil");
		await related(h, "garden");
		await untilIdle(h, "ready");
		const state = await embeddingState(h);
		expect({indexed: state.indexed, last: state.batches.at(-1)}).toStrictEqual({
			indexed: ["basil", "garden", "kitchen"],
			last: 1,
		});
		await expect(related(h, "garden")).resolves.toStrictEqual({status: 200, ids: ["basil", "kitchen"]});
	});
});
