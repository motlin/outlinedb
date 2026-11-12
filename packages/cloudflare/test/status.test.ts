import {afterAll, beforeAll, describe, expect, it} from "vite-plus/test";
import {probeStore, readJson, startHarness} from "./harness";
import type {Harness} from "./harness";

interface AdminStatus {
	storeName: string | null;
	mode: string;
	databaseSize: number;
	nodeCount: number;
	lastSync: unknown;
	snapshot: {enabled: boolean; warm: boolean};
	embeddings: unknown;
}

async function adminStatus(h: Harness): Promise<AdminStatus> {
	const response = await h.mf.dispatchFetch("http://localhost/api/admin/status");
	expect(response.status).toBe(200);
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test reads its own endpoint
	return (await response.json()) as AdminStatus;
}

async function searchSwitcher(h: Harness): Promise<unknown> {
	const response = await h.mf.dispatchFetch("http://localhost/api/search/switcher", {
		method: "POST",
		headers: {"content-type": "application/json"},
		body: JSON.stringify({query: "seed"}),
	});
	expect(response.status).toBe(200);
	return readJson(response);
}

describe("GET /api/admin/status", () => {
	let warm: Harness;
	let cold: Harness;

	beforeAll(async () => {
		warm = await startHarness("./probe-entry.ts", "ProbeStore", undefined, {
			ACCESS_DEV_IDENTITY: "dev",
			TREE_SNAPSHOT: "true",
		});
		cold = await startHarness("./probe-entry.ts", "ProbeStore");
		for (const h of [warm, cold]) {
			await probeStore(h.mf, "/__seed");
		}
	}, 120_000);

	afterAll(async () => {
		await warm.dispose();
		await cold.dispose();
	});

	it("reports database size, live node count, last sync, a cold snapshot and no embedding job without bindings", async () => {
		const status = await adminStatus(warm);
		expect(status.databaseSize).toBeGreaterThan(0);
		expect({...status, databaseSize: 0}).toStrictEqual({
			storeName: "dev",
			mode: "standalone",
			profile: null,
			databaseSize: 0,
			nodeCount: 1,
			lastSync: null,
			snapshot: {enabled: true, warm: false},
			embeddings: null,
		});
	});

	it("shows the snapshot warm after a search", async () => {
		await searchSwitcher(warm);
		expect((await adminStatus(warm)).snapshot).toStrictEqual({enabled: true, warm: true});
	});

	it("never warms the snapshot when disabled, and searches return the same results", async () => {
		const withSnapshot = await searchSwitcher(warm);
		const withoutSnapshot = await searchSwitcher(cold);
		expect((await adminStatus(cold)).snapshot).toStrictEqual({enabled: false, warm: false});
		expect(withoutSnapshot).toStrictEqual(withSnapshot);
	});
});
