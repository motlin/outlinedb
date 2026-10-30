// @vitest-environment happy-dom
import {QueryClient} from "@tanstack/react-query";
import {describe, expect, it} from "vite-plus/test";
import {ChangeFeed, applyNodeChanges} from "../src/client/change-feed.js";
import {nodeKeys} from "../src/client/node-cache.js";
import type {BacklinksResponse, NodeChangesResponse, NodeResponse} from "../src/node-types.js";

function row(id: string, parentId: string | null, fields: Partial<NodeResponse> = {}): NodeResponse {
	return {
		id,
		parent_id: parentId,
		name: id,
		note: null,
		priority: 100,
		data: {layoutMode: null},
		createdAt: 0,
		modifiedAt: 0,
		completedAt: null,
		hasChildren: false,
		hasUncompletedChildren: false,
		isMirror: false,
		...fields,
	};
}

function changes(fields: Partial<NodeChangesResponse>): NodeChangesResponse {
	return {latest: "1", reset: false, changedIds: [], deletedIds: [], children: [], ...fields};
}

const listIds = (client: QueryClient, parentId: string | null) =>
	client.getQueryData<NodeResponse[]>(nodeKeys.children(parentId))?.map((node) => node.id);

/** Whether `key` was marked stale (invalidated) since it was set. */
const stale = (client: QueryClient, key: readonly unknown[]) => client.getQueryState(key)?.isInvalidated ?? false;

describe("applyNodeChanges", () => {
	it("moves a row between cached lists and resets both parents' flags without invalidating them", () => {
		const client = new QueryClient();
		client.setQueryData(nodeKeys.children(null), [
			row("A", null, {hasChildren: true, hasUncompletedChildren: true}),
			row("B", null),
		]);
		client.setQueryData(nodeKeys.children("A"), [row("x", "A")]);
		client.setQueryData(nodeKeys.detail("x"), row("x", "A", {name: "old"}));

		applyNodeChanges(
			client,
			changes({
				changedIds: ["x"],
				children: [
					{parentId: "A", nodes: []},
					{parentId: "B", nodes: [row("x", "B")]},
				],
			}),
		);

		const home = client.getQueryData<NodeResponse[]>(nodeKeys.children(null));
		expect({
			a: listIds(client, "A"),
			b: listIds(client, "B"),
			flags: home?.map(({id, hasChildren, hasUncompletedChildren}) => ({
				id,
				hasChildren,
				hasUncompletedChildren,
			})),
			detail: client.getQueryData<NodeResponse>(nodeKeys.detail("x"))?.parent_id,
			stale: [stale(client, nodeKeys.children(null)), stale(client, nodeKeys.children("A"))],
		}).toStrictEqual({
			a: [],
			// B's list was not cached: a list only replaces one the cache holds.
			b: undefined,
			flags: [
				{id: "A", hasChildren: false, hasUncompletedChildren: false},
				{id: "B", hasChildren: true, hasUncompletedChildren: true},
			],
			detail: "B",
			stale: [false, false],
		});
	});

	it("gives a mirror of a changed parent the same children", () => {
		const client = new QueryClient();
		client.setQueryData(nodeKeys.children(null), [
			row("O", null),
			row("M", null, {isMirror: true, originalNodeId: "O"}),
		]);
		client.setQueryData(nodeKeys.children("M"), [row("c1", "O")]);

		applyNodeChanges(
			client,
			changes({changedIds: ["c2"], children: [{parentId: "O", nodes: [row("c1", "O"), row("c2", "O")]}]}),
		);

		expect(listIds(client, "M")).toStrictEqual(["c1", "c2"]);
	});

	it("invalidates only the ancestors, Backlinks and details that show a changed or deleted node", () => {
		const client = new QueryClient();
		client.setQueryData(nodeKeys.ancestors("deep"), [row("x", null), row("deep", "x")]);
		client.setQueryData(nodeKeys.ancestors("other"), [row("y", null), row("other", "y")]);
		const backlinks = (sourceId: string, crumbId: string): BacklinksResponse => ({
			rootId: null,
			items: [{sourceId, node: row(sourceId, null), crumbs: [{id: crumbId, name: crumbId}]}],
		});
		client.setQueryData(nodeKeys.backlinks("t1"), backlinks("s1", "x"));
		client.setQueryData(nodeKeys.backlinks("t2"), backlinks("s2", "y"));
		client.setQueryData(nodeKeys.backlinks("t3"), backlinks("gone", "y"));
		client.setQueryData(nodeKeys.detail("gone"), row("gone", null));

		applyNodeChanges(client, changes({changedIds: ["x", "gone"], deletedIds: ["gone"]}));

		expect({
			deep: stale(client, nodeKeys.ancestors("deep")),
			other: stale(client, nodeKeys.ancestors("other")),
			t1: stale(client, nodeKeys.backlinks("t1")),
			t2: stale(client, nodeKeys.backlinks("t2")),
			t3: stale(client, nodeKeys.backlinks("t3")),
			gone: stale(client, nodeKeys.detail("gone")),
		}).toStrictEqual({deep: true, other: false, t1: true, t2: false, t3: true, gone: true});
	});
});

describe("ChangeFeed", () => {
	it("asks for changes since its high-water mark and only ever advances it", async () => {
		const client = new QueryClient();
		client.setQueryData(nodeKeys.children(null), [row("a", null)]);
		const asked: (string | undefined)[] = [];
		const answers = [
			changes({latest: "5"}),
			changes({
				latest: "9",
				changedIds: ["b"],
				children: [{parentId: null, nodes: [row("a", null), row("b", null)]}],
			}),
			changes({latest: "7"}),
			changes({latest: "7"}),
		];
		const feed = new ChangeFeed(async (since) => {
			asked.push(since);
			return Promise.resolve(answers.shift() ?? changes({}));
		});

		await feed.seed();
		await feed.sync(client);
		await feed.sync(client);
		await feed.sync(client);

		expect({asked, home: listIds(client, null)}).toStrictEqual({
			asked: [undefined, "5", "9", "9"],
			home: ["a", "b"],
		});
	});

	it("compares watermarks as timestamps and takes the server's mark after a reset", async () => {
		const client = new QueryClient();
		const asked: (string | undefined)[] = [];
		const answers = [
			changes({latest: "2026-10-29 12:00:09.000"}),
			changes({latest: "2026-10-29 12:00:10.000"}),
			changes({latest: "2026-10-29 12:00:03.000", reset: true}),
			changes({latest: "2026-10-29 12:00:04.000"}),
		];
		const feed = new ChangeFeed(async (since) => {
			asked.push(since);
			return Promise.resolve(answers.shift() ?? changes({}));
		});

		await feed.seed();
		await feed.sync(client);
		await feed.sync(client);
		await feed.sync(client);

		// A reset answers a watermark the server never issued (its clock went back), so its mark replaces the client's
		// even when lower.
		expect(asked).toStrictEqual([
			undefined,
			"2026-10-29 12:00:09.000",
			"2026-10-29 12:00:10.000",
			"2026-10-29 12:00:03.000",
		]);
	});

	it("refetches every node query when it has no mark yet or the server answers reset", async () => {
		const client = new QueryClient();
		client.setQueryData(nodeKeys.children(null), [row("a", null)]);
		const answers = [changes({latest: "5"}), changes({reset: true})];
		const feed = new ChangeFeed(async () => Promise.resolve(answers.shift() ?? changes({})));

		await feed.sync(client);
		const unseeded = stale(client, nodeKeys.children(null));
		client.setQueryData(nodeKeys.children(null), [row("a", null)]);
		await feed.sync(client);

		expect({unseeded, reset: stale(client, nodeKeys.children(null))}).toStrictEqual({unseeded: true, reset: true});
	});

	it("passes each list through prepare, so a pending create survives and a parent mid-move keeps its list", async () => {
		const client = new QueryClient();
		client.setQueryData(nodeKeys.children(null), [row("a", null)]);
		const answers = [
			changes({latest: "5"}),
			changes({
				changedIds: ["b"],
				children: [
					{parentId: null, nodes: [row("a", null), row("b", null)]},
					{parentId: "moving", nodes: []},
				],
			}),
		];
		const feed = new ChangeFeed(
			async () => Promise.resolve(answers.shift() ?? changes({})),
			(parentId, nodes) => (parentId === "moving" ? undefined : [...nodes, row("pending", null)]),
		);
		client.setQueryData(nodeKeys.children("moving"), [row("m", "moving")]);

		await feed.seed();
		await feed.sync(client);

		expect({home: listIds(client, null), moving: listIds(client, "moving")}).toStrictEqual({
			home: ["a", "b", "pending"],
			moving: ["m"],
		});
	});
});
