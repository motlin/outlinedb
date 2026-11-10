import {afterAll, beforeAll, describe, expect, it} from "vite-plus/test";
import {startHarness} from "./harness";
import type {Harness} from "./harness";

const url = "http://localhost/api/admin/account-state";

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

function state(rows: Record<string, unknown[]>, expandedKeys: string[] | null = null) {
	return {rows: {...Object.fromEntries(TABLES.map((name) => [name, []])), ...rows}, expandedKeys};
}

async function put(h: Harness, body: unknown) {
	return h.mf.dispatchFetch(url, {
		method: "PUT",
		headers: {"content-type": "application/json"},
		body: JSON.stringify(body),
	});
}

async function read(h: Harness): Promise<unknown> {
	return (await h.mf.dispatchFetch(url)).json();
}

describe("/api/admin/account-state", () => {
	let h: Harness;

	beforeAll(async () => {
		h = await startHarness("../src/worker.ts");
	}, 120_000);

	afterAll(async () => {
		await h.dispose();
	});

	it("starts empty, with expansion unseeded", async () => {
		await expect(read(h)).resolves.toStrictEqual(state({}));
	});

	it("merges a seed into the account tables, and a later seed replaces it", async () => {
		const account = [
			{userId: "1", fullName: null, dateJoinedSec: 1_324_752_241, entropyKey: null, username: null, email: null},
		];
		const first = await put(
			h,
			state({account, tagColors: [{tag: "#a", colorIndex: 1}], stars: [{locationKey: "n1", treeRoot: "None"}]}, [
				"aaaaaaaa",
			]),
		);
		expect({status: first.status, body: await first.json()}).toStrictEqual({
			status: 200,
			body: {rows: 3, expandedKeys: 1},
		});

		await put(h, state({account, tagColors: [{tag: "#a", colorIndex: 2}]}, ["bbbbbbbb"]));
		await expect(read(h)).resolves.toStrictEqual(
			state({account, tagColors: [{tag: "#a", colorIndex: 2}]}, ["bbbbbbbb"]),
		);
	});

	it("rejects malformed bodies and unsupported methods", async () => {
		const bad = await put(h, state({tagColors: [{tag: "#a"}]}));
		expect(bad.status).toBe(400);
		await bad.arrayBuffer();
		const notState = await put(h, [{key: "x"}]);
		expect(notState.status).toBe(400);
		await notState.arrayBuffer();
		const del = await h.mf.dispatchFetch(url, {method: "DELETE"});
		expect(del.status).toBe(405);
		await del.arrayBuffer();
	});
});
