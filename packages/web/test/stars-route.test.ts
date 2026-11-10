import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import type {WorkflowyInternalAdapter} from "@outlinedb/shared/internal";
import {createHttpApp} from "../src/server/http/app.js";
import {Ops} from "../src/server/ops/index.js";
import {starsListWith} from "../src/server/ops/stars.js";
import {inProcessStore} from "../src/server/store.js";
import type {ServerContext} from "../src/server/context.js";
import type {NodeResponse} from "../src/node-types.js";
import {standaloneContext} from "./helpers/local-context.js";
import {httpAppFor} from "./http-app-for.js";
const P1 = "1a2b3c4d-0000-4000-8000-000000000001";
const P2 = "5e6f7a8b-0000-4000-8000-000000000002";

const NAMES: Record<string, string> = {[P1]: "<b>Zulu</b>", [P2]: "Bravo"};

function view(projectid: string, searchQuery: string) {
	return {zoomedProject: {projectid, auxiliaryRootProjectId: "None"}, searchQuery};
}

async function readResponse(res: Response) {
	const text = await res.text();
	return {status: res.status, body: text === "" ? null : (JSON.parse(text) as unknown)};
}

function setup(meta: Record<string, unknown> | undefined, savedViews?: string) {
	const adapter = {
		getRootMeta: vi.fn<WorkflowyInternalAdapter["getRootMeta"]>(async () => Promise.resolve(meta)),
		setRootMetaValues: vi.fn<WorkflowyInternalAdapter["setRootMetaValues"]>(async () => Promise.resolve()),
		getSetting: vi.fn<WorkflowyInternalAdapter["getSetting"]>(async (name) =>
			Promise.resolve(name === "saved_views_json" ? savedViews : undefined),
		),
		setSavedViews: vi.fn<WorkflowyInternalAdapter["setSavedViews"]>(async () => Promise.resolve()),
	};
	const cacheService = {
		getNode: (id: string) => (Object.hasOwn(NAMES, id) ? {id, name: NAMES[id]} : undefined),
	};
	const ctx = {
		cacheService,
		internalAuth: meta ? {} : undefined,
		internalAdapter: () => (meta ? (adapter as unknown as WorkflowyInternalAdapter) : undefined),
	} as unknown as ServerContext;
	const readNode = async (_ctx: ServerContext, id: string) =>
		Promise.resolve(cacheService.getNode(id) as unknown as NodeResponse | undefined);
	const app = createHttpApp({
		resolveStore: () => inProcessStore(ctx, {...Ops, "stars.list": starsListWith(readNode)}),
	});
	const request = async (method: string, path = "", body?: unknown) => {
		const res = await app.fetch(
			new Request(`http://x/api/v1/stars${path}`, {
				method,
				headers: {"content-type": "application/json"},
				...(body === undefined ? {} : {body: JSON.stringify(body)}),
			}),
		);
		const text = await res.text();
		return {status: res.status, body: text === "" ? null : (JSON.parse(text) as unknown)};
	};
	return {adapter, request};
}

const ORDERED = {
	starring: {
		isSynced: true,
		locations: {[P1]: "None", [`${P1}_#todo`]: "None"},
		order: `None/${P1}/#todo,None/${P1}/`,
	},
	location: {renamed: {[`None/${P1}/`]: "Alice"}},
};

describe("GET /api/v1/stars", () => {
	it("returns the stars in stored order", async () => {
		const {request} = setup(ORDERED);

		await expect(request("GET")).resolves.toStrictEqual({
			status: 200,
			body: {
				stars: [
					{key: `${P1}_#todo`, nodeId: P1, query: "#todo", name: null, position: 0},
					{key: P1, nodeId: P1, query: null, name: "Alice", position: 1},
				],
				nodes: [{id: P1, name: "<b>Zulu</b>"}],
			},
		});
	});

	it("orders by plain-text node name without a stored order", async () => {
		const {request} = setup({starring: {isSynced: true, locations: {[P1]: "None", [P2]: "None"}}});

		const response = await request("GET");

		expect(response).toStrictEqual({
			status: 200,
			body: {
				stars: [
					{key: P2, nodeId: P2, query: null, name: null, position: 0},
					{key: P1, nodeId: P1, query: null, name: null, position: 1},
				],
				nodes: [
					{id: P2, name: "Bravo"},
					{id: P1, name: "<b>Zulu</b>"},
				],
			},
		});
	});

	it("reads an unsynced account's stars from its saved views", async () => {
		const {request} = setup(
			{starring: {locations: {[P2]: "None"}}},
			JSON.stringify([view(P1, "#todo"), view("None", "")]),
		);

		await expect(request("GET")).resolves.toStrictEqual({
			status: 200,
			body: {
				stars: [
					{key: `${P1}_#todo`, nodeId: P1, query: "#todo", name: null, position: 0},
					{key: "None", nodeId: null, query: null, name: null, position: 1},
				],
				nodes: [{id: P1, name: "<b>Zulu</b>"}],
			},
		});
	});
});

describe("stars in a standalone context", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("stars, renames, orders and unstars in the local tables with no internal API", async () => {
		vi.useFakeTimers({toFake: ["Date"], now: 1_700_000_000_000});
		const app = httpAppFor(standaloneContext());
		const request = async (method: string, path = "", body?: unknown) =>
			readResponse(
				await app.fetch(
					new Request(`http://x/api/v1/stars${path}`, {
						method,
						headers: {"content-type": "application/json"},
						...(body === undefined ? {} : {body: JSON.stringify(body)}),
					}),
				),
			);
		// Each write is its own unit of work; a row may not be replaced in the millisecond it was written.
		let now = 1_700_000_000_000;
		const later = () => {
			now += 1000;
			vi.setSystemTime(now);
		};

		const before = await request("GET");
		const starred = await request("PUT", "/None_%23todo", {nodeId: null, query: "#todo"});
		later();
		await request("PUT", "/None", {nodeId: null, query: null});
		later();
		await request("PATCH", "/None_%23todo", {name: "Triage"});
		later();
		await request("PUT", "/order", {keys: ["None", "None_#todo"]});
		const afterWrites = await request("GET");
		later();
		await request("DELETE", "/None");

		expect({before, starred, afterWrites, afterRemove: await request("GET")}).toStrictEqual({
			before: {status: 200, body: {stars: [], nodes: []}},
			starred: {
				status: 201,
				body: {key: "None_#todo", nodeId: null, query: "#todo", name: null, position: 0},
			},
			afterWrites: {
				status: 200,
				body: {
					stars: [
						{key: "None", nodeId: null, query: null, name: null, position: 0},
						{key: "None_#todo", nodeId: null, query: "#todo", name: "Triage", position: 1},
					],
					nodes: [],
				},
			},
			afterRemove: {
				status: 200,
				body: {
					stars: [{key: "None_#todo", nodeId: null, query: "#todo", name: "Triage", position: 0}],
					nodes: [],
				},
			},
		});
	});
});

describe("PUT /api/v1/stars/:key", () => {
	it("stars the location and appends it to the order in one push, answering the new star", async () => {
		const {adapter, request} = setup(
			{starring: {isSynced: true, locations: {[P1]: "None"}, order: `None/${P1}/`}},
			JSON.stringify([view(P1, "")]),
		);
		adapter.getRootMeta
			.mockResolvedValueOnce({starring: {isSynced: true, locations: {[P1]: "None"}, order: `None/${P1}/`}})
			.mockResolvedValueOnce({
				starring: {
					isSynced: true,
					locations: {[P1]: "None", [`${P2}_#todo`]: "None"},
					order: `None/${P1}/,None/${P2}/#todo`,
				},
			});

		const response = await request("PUT", `/${P2}_%23todo`, {nodeId: P2, query: "#todo"});

		expect({
			response,
			writes: adapter.setRootMetaValues.mock.calls,
			savedViews: adapter.setSavedViews.mock.calls,
		}).toStrictEqual({
			response: {status: 201, body: {key: `${P2}_#todo`, nodeId: P2, query: "#todo", name: null, position: 1}},
			writes: [
				[
					[
						{path: ["starring", "locations", `${P2}_#todo`], value: "None"},
						{path: ["starring", "order"], value: `None/${P1}/,None/${P2}/#todo`},
					],
				],
			],
			savedViews: [
				[JSON.stringify([view(P1, ""), view(P2, "#todo")]), JSON.stringify({added: [view(P2, "#todo")]})],
			],
		});
	});

	it("copies a fresh account's toggled saved views into its locations and marks it synced in the same push", async () => {
		const {adapter, request} = setup({}, JSON.stringify([view(P2, "")]));
		adapter.getRootMeta
			.mockResolvedValueOnce({})
			.mockResolvedValueOnce({starring: {isSynced: true, locations: {[P1]: "None"}}});

		const response = await request("PUT", `/${P1}`, {nodeId: P1, query: null});

		expect({response, writes: adapter.setRootMetaValues.mock.calls}).toStrictEqual({
			response: {status: 201, body: {key: P1, nodeId: P1, query: null, name: null, position: 0}},
			writes: [
				[
					[
						{path: ["starring", "locations"], value: {[P2]: "None", [P1]: "None"}},
						{path: ["starring", "isSynced"], value: true},
					],
				],
			],
		});
	});

	it("rejects a body that does not match the key, and a node missing from the cache", async () => {
		const {adapter, request} = setup({});
		const missing = "9c9c9c9c-0000-4000-8000-000000000009";

		const mismatch = await request("PUT", `/${P1}`, {nodeId: P2, query: null});
		const unknown = await request("PUT", `/${missing}`, {nodeId: missing, query: null});

		expect({
			mismatch,
			unknown,
			writes: adapter.setRootMetaValues.mock.calls,
			savedViews: adapter.setSavedViews.mock.calls,
		}).toStrictEqual({
			mismatch: {status: 400, body: {error: "key must equal the location key of {nodeId, query}"}},
			unknown: {status: 404, body: {error: `Node not found: ${missing}`}},
			writes: [],
			savedViews: [],
		});
	});

	it("posts no saved-views delta when the saved views already hold the location", async () => {
		const {adapter, request} = setup(ORDERED, JSON.stringify([view(P1, "")]));

		await request("PUT", `/${P1}`, {nodeId: P1, query: null});

		expect(adapter.setSavedViews.mock.calls).toStrictEqual([]);
	});
});

describe("DELETE /api/v1/stars/:key", () => {
	it("removes the location and its order entry, keeping the rename", async () => {
		const {adapter, request} = setup(ORDERED, JSON.stringify([view(P1, "#todo"), view(P1, "")]));

		const response = await request("DELETE", `/${P1}`);

		expect({
			response,
			writes: adapter.setRootMetaValues.mock.calls,
			savedViews: adapter.setSavedViews.mock.calls,
		}).toStrictEqual({
			response: {status: 204, body: null},
			writes: [
				[
					[
						{path: ["starring", "locations", P1], value: undefined},
						{path: ["starring", "order"], value: `None/${P1}/#todo`},
					],
				],
			],
			savedViews: [[JSON.stringify([view(P1, "#todo")]), JSON.stringify({removed: [view(P1, "")]})]],
		});
	});
});

describe("PATCH /api/v1/stars/:key", () => {
	it("renames and clears a rename", async () => {
		const {adapter, request} = setup(ORDERED);

		const renamed = await request("PATCH", `/${P1}_%23todo`, {name: "Inbox triage"});
		const cleared = await request("PATCH", `/${P1}_%23todo`, {name: null});
		const invalid = await request("PATCH", `/${P1}_%23todo`, {name: 3});

		expect({renamed, cleared, invalid, writes: adapter.setRootMetaValues.mock.calls}).toStrictEqual({
			renamed: {status: 204, body: null},
			cleared: {status: 204, body: null},
			invalid: {status: 400, body: {error: "body must be {name: string | null}"}},
			writes: [
				[[{path: ["location", "renamed", `None/${P1}/#todo`], value: "Inbox triage"}]],
				[[{path: ["location", "renamed", `None/${P1}/#todo`], value: undefined}]],
			],
		});
	});
});

describe("PUT /api/v1/stars/order", () => {
	it("stores the keys as the order", async () => {
		const {adapter, request} = setup(ORDERED);

		const response = await request("PUT", "/order", {keys: [P1, `${P1}_#todo`]});
		const invalid = await request("PUT", "/order", {keys: "nope"});

		expect({response, invalid, writes: adapter.setRootMetaValues.mock.calls}).toStrictEqual({
			response: {status: 204, body: null},
			invalid: {status: 400, body: {error: "body must be {keys: string[]}"}},
			writes: [[[{path: ["starring", "order"], value: `None/${P1}/,None/${P1}/#todo`}]]],
		});
	});
});
