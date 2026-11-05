import {afterAll, beforeAll, describe, expect, it} from "vite-plus/test";
import {startHarness} from "./harness";
import type {Harness} from "./harness";

const TABLES = [
	"account",
	"rootPreferences",
	"accountSettings",
	"tagColors",
	"stars",
	"starOrder",
	"locationRenames",
	"enabledFeatures",
	"visibleFeatures",
	"changelogReads",
	"surveys",
	"savedViews",
	"aiAssistants",
	"aiPromptButtons",
];

function state(rows: Record<string, unknown[]>) {
	return {rows: {...Object.fromEntries(TABLES.map((name) => [name, []])), ...rows}, expandedKeys: null};
}

async function put(h: Harness, body: unknown): Promise<void> {
	const response = await h.mf.dispatchFetch("http://localhost/api/admin/account-state", {
		method: "PUT",
		headers: {"content-type": "application/json"},
		body: JSON.stringify(body),
	});
	await response.arrayBuffer();
}

const settle = async (): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, 200);
	});

describe("the nodes events WebSocket on the Durable Object", () => {
	let h: Harness;
	beforeAll(async () => {
		h = await startHarness("../src/worker.ts");
	}, 120_000);
	afterAll(async () => {
		await h.dispose();
	});

	it("rejects a non-upgrade request to the events path", async () => {
		const response = await h.mf.dispatchFetch("http://localhost/api/v1/nodes/events");
		await response.arrayBuffer();
		expect(response.status).toBe(426);
	});

	it("sends one account.changed frame when an account write moves the flags, and none for an equal rewrite", async () => {
		const response = await h.mf.dispatchFetch("http://localhost/api/v1/nodes/events", {
			headers: {Upgrade: "websocket"},
		});
		expect(response.status).toBe(101);
		const ws = response.webSocket;
		if (!ws) {
			throw new Error("no websocket on the response");
		}
		ws.accept();
		const frames: unknown[] = [];
		ws.addEventListener("message", (e) => {
			frames.push(typeof e.data === "string" ? (JSON.parse(e.data) as {type: unknown}).type : e.data);
		});
		const seed = state({enabledFeatures: [{codename: "full_width_page", enabled: 1}]});
		await put(h, seed);
		await settle();
		await put(h, seed);
		await settle();
		ws.close();
		expect(frames).toStrictEqual(["account.changed"]);
	});
});
