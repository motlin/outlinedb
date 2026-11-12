import {afterAll, beforeAll, beforeEach, describe, expect, it} from "vite-plus/test";
import type {StoreClient} from "@outlinedb/web/node-host";
import {callTool, openHarness} from "./harness.js";
import type {Harness} from "./harness.js";
import {fakeNode, stubPublicApi} from "./fake-upstream.js";
import type {FakeNode} from "./fake-upstream.js";

let harness: Harness;

const OUTLINE: FakeNode[] = [
	fakeNode("p-work", "Parity work", null),
	fakeNode("p-projects", "Parity projects", "p-work"),
	fakeNode("p-alpha", "Parity alpha task", "p-projects"),
	{
		...fakeNode("p-beta", "Parity beta task", "p-projects", 1),
		completedAt: 1_600_000_100,
	},
	fakeNode("p-gamma", "Parity gamma task", "p-work", 1),
];

beforeAll(() =>
{
	harness = openHarness("outlinedb-mcp-parity-test-");
});

beforeEach(() =>
{
	for (const node of OUTLINE)
	{
		harness.cache.insertNode(node, node.parent_id);
	}
});

afterAll(() =>
{
	harness.restoreEnv();
});

function text(result: {content: unknown}): string
{
	return (
		(
			result.content as
			{
				text: string;
			}[]
		)[0]?.text ?? ""
	);
}

interface Recorded
{
	store: StoreClient;
	calls:
	{
		op: string;
		input: unknown;
	}[];
}

/** The harness store, recording every op call; `answers` replaces an op's result. */
function recording(answers: Record<string, unknown> = {}): Recorded
{
	const calls:
	{
		op: string;
		input: unknown;
	}[] = [];
	const call = async (op: string, input: unknown): Promise<unknown> =>
	{
		calls.push(
			{
				op,
				input,
			},
		);
		if (op in answers)
		{
			return Promise.resolve(answers[op]);
		}
		return harness.store.call(op as never, input as never);
	};
	return {
		store:
		{
			call,
		} as unknown as StoreClient,
		calls,
	};
}

function searchIds(result: {content: unknown}): string[]
{
	return (
		JSON.parse(text(result)) as
		{
			id: string;
		}[]
	).map(({id}) => id);
}

describe("outlinedb_search filters", () =>
{
	it("keeps completed matches without a filter", async () =>
	{
		const result = await callTool(
			harness.store,
			"outlinedb_search",
			{
				query: "Parity",
			},
		);

		expect(searchIds(result).toSorted()).toStrictEqual(["p-alpha", "p-beta", "p-gamma", "p-projects", "p-work"]);
	});

	it("returns completedAt for completed and incomplete matches", async () =>
	{
		const result = await callTool(
			harness.store,
			"outlinedb_search",
			{
				query: "beta OR alpha",
			},
		);

		expect(
			{
				isError: result.isError,
				value: JSON.parse(text(result)),
			},
		).toStrictEqual(
			{
				isError: undefined,
				value: [
					{
						id: "p-alpha",
						name: "Parity alpha task",
						note: null,
						parentPath: "Parity work > Parity projects",
						completedAt: null,
						url: "https://workflowy.com/#/palpha",
					},
					{
						id: "p-beta",
						name: "Parity beta task",
						note: null,
						parentPath: "Parity work > Parity projects",
						completedAt: 1_600_000_100,
						url: "https://workflowy.com/#/pbeta",
					},
				],
			},
		);
	});

	it("drops completed nodes with incomplete", async () =>
	{
		const result = await callTool(
			harness.store,
			"outlinedb_search",
			{
				query: "task",
				incomplete: true,
			},
		);

		expect(searchIds(result).toSorted()).toStrictEqual(["p-alpha", "p-gamma"]);
	});

	it("scopes to the descendants of a parent path", async () =>
	{
		stubPublicApi(OUTLINE);

		const result = await callTool(
			harness.store,
			"outlinedb_search",
			{
				query: "task",
				parentPath: "Parity work,Parity projects",
			},
		);

		expect(searchIds(result).toSorted()).toStrictEqual(["p-alpha", "p-beta"]);
	});

	it("passes limit and offset through for paging", async () =>
	{
		const {store, calls} = recording();

		await callTool(
			store,
			"outlinedb_search",
			{
				query: "task",
				parentId: "p-work",
				limit: 2,
				offset: 1,
			},
		);

		expect(calls).toStrictEqual([
			{
				op: "nodes.resolve",
				input:
				{
					id: "p-work",
					path: undefined,
					parent: true,
				},
			},
			{
				op: "search.text",
				input:
				{
					query: "task",
					limit: 2,
					offset: 1,
					parentId: "p-work",
				},
			},
		]);
	});
});

describe("outlinedb_node_update clearNote", () =>
{
	it("clears the note", async () =>
	{
		const upstream = stubPublicApi([
			{
				...fakeNode("p-noted", "Noted", null),
				note: "old note",
			},
		]);
		harness.cache.insertNode(
			{
				...fakeNode("p-noted", "Noted", null),
				note: "old note",
			},
			null,
		);

		const result = await callTool(
			harness.store,
			"outlinedb_node_update",
			{
				id: "p-noted",
				clearNote: true,
			},
		);

		expect(
			{
				isError: result.isError,
				value: JSON.parse(text(result)),
				upstreamNote: upstream.get("p-noted")?.note,
			},
		).toStrictEqual(
			{
				isError: undefined,
				value:
				{
					id: "p-noted",
					name: "Noted",
					note: "",
				},
				upstreamNote: "",
			},
		);
	});

	it("rejects clearNote together with a note", async () =>
	{
		await expect(
			callTool(
				harness.store,
				"outlinedb_node_update",
				{
					id: "p-alpha",
					note: "x",
					clearNote: true,
				},
			),
		).resolves.toStrictEqual(
			{
				isError: true,
				content: [
					{
						type: "text",
						text: "note and clearNote cannot be used together",
					},
				],
			},
		);
	});
});

describe("outlinedb_node_create children", () =>
{
	it("creates a tree depth-first under the new node", async () =>
	{
		const upstream = stubPublicApi(OUTLINE);

		const result = await callTool(
			harness.store,
			"outlinedb_node_create",
			{
				parentId: "p-work",
				name: "Plan",
				children: [
					{
						name: "Step 1",
						note: "first",
						children: [
							{
								name: "Step 1a",
							},
						],
					},
					{
						name: "Step 2",
					},
				],
			},
		);

		expect(
			{
				isError: result.isError,
				value: JSON.parse(text(result)),
				created: [...upstream.values()]
					.filter((node) => node.id.startsWith("created-"))
					.map(({id, name, note, parent_id: parentId}) => (
					{
						id,
						name,
						note,
						parentId,
					})),
			},
		).toStrictEqual(
			{
				isError: undefined,
				value:
				{
					id: "created-1",
					name: "Plan",
					createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
					url: "https://workflowy.com/#/created1",
					children: [
						{
							id: "created-2",
							name: "Step 1",
							url: "https://workflowy.com/#/created2",
							children: [
								{
									id: "created-3",
									name: "Step 1a",
									url: "https://workflowy.com/#/created3",
									children: [],
								},
							],
						},
						{
							id: "created-4",
							name: "Step 2",
							url: "https://workflowy.com/#/created4",
							children: [],
						},
					],
				},
				created: [
					{
						id: "created-1",
						name: "Plan",
						note: null,
						parentId: "p-work",
					},
					{
						id: "created-2",
						name: "Step 1",
						note: "first",
						parentId: "created-1",
					},
					{
						id: "created-3",
						name: "Step 1a",
						note: null,
						parentId: "created-2",
					},
					{
						id: "created-4",
						name: "Step 2",
						note: null,
						parentId: "created-1",
					},
				],
			},
		);
	});
});

describe("outlinedb_node_changes", () =>
{
	it("answers the changes.list op since the default one day", async () =>
	{
		const {store, calls} = recording();

		const result = await callTool(store, "outlinedb_node_changes", {});
		const direct = await harness.store.call(
			"changes.list",
			{
				since: "1d",
			},
		);
		const withoutCutoff = (value: object) => (
		{
			...value,
			cutoffDate: "<cutoff>",
		});

		expect(
			{
				isError: result.isError,
				value: withoutCutoff(JSON.parse(text(result)) as object),
				calls,
			},
		).toStrictEqual(
			{
				isError: undefined,
				value: withoutCutoff(direct.ok ? direct.value : {}),
				calls: [
					{
						op: "changes.list",
						input:
						{
							since: "1d",
						},
					},
				],
			},
		);
	});

	it("reports an invalid since", async () =>
	{
		await expect(
			callTool(
				harness.store,
				"outlinedb_node_changes",
				{
					since: "soon",
				},
			),
		).resolves.toStrictEqual(
			{
				isError: true,
				content: [
					{
						type: "text",
						text: 'Invalid since parameter: "soon"',
					},
				],
			},
		);
	});
});

describe("outlinedb_node_mirror", () =>
{
	const MIRROR =
	{
		id: "p-mirror",
		parent_id: "p-projects",
		name: "Parity gamma task",
		note: null,
		priority: 0,
		data:
		{
			layoutMode: null,
		},
		createdAt: 1,
		modifiedAt: 1,
		completedAt: null,
		isMirror: true,
		originalNodeId: "p-gamma",
	};

	it("mirrors a node to the top of a parent found by path", async () =>
	{
		stubPublicApi(OUTLINE);
		const {store, calls} = recording(
			{
				"nodes.mirror":
				{
					ok: true,
					value:
					{
						nodes: [MIRROR],
					},
				},
			},
		);

		const result = await callTool(
			store,
			"outlinedb_node_mirror",
			{
				nodeId: "p-gamma",
				parentPath: "Parity work,Parity projects",
			},
		);

		expect(
			{
				isError: result.isError,
				value: JSON.parse(text(result)),
				mirrorCall: calls.find(({op}) => op === "nodes.mirror"),
			},
		).toStrictEqual(
			{
				isError: undefined,
				value:
				{
					mirrorId: "p-mirror",
					originId: "p-gamma",
					parentId: "p-projects",
					url: "https://workflowy.com/#/pmirror",
				},
				mirrorCall:
				{
					op: "nodes.mirror",
					input:
					{
						item_ids: ["p-gamma"],
						parent_id: "p-projects",
						index: 0,
					},
				},
			},
		);
	});

	it("places the mirror at the bottom on request", async () =>
	{
		const {store, calls} = recording(
			{
				"nodes.mirror":
				{
					ok: true,
					value:
					{
						nodes: [MIRROR],
					},
				},
			},
		);

		await callTool(
			store,
			"outlinedb_node_mirror",
			{
				nodeId: "p-gamma",
				parentId: "p-projects",
				position: "bottom",
			},
		);

		expect(calls.find(({op}) => op === "nodes.mirror")).toStrictEqual(
			{
				op: "nodes.mirror",
				input:
				{
					item_ids: ["p-gamma"],
					parent_id: "p-projects",
				},
			},
		);
	});

	it("reports the op's error without the internal API", async () =>
	{
		await expect(
			callTool(
				harness.store,
				"outlinedb_node_mirror",
				{
					nodeId: "p-gamma",
					parentId: "p-projects",
				},
			),
		).resolves.toStrictEqual(
			{
				isError: true,
				content: [
					{
						type: "text",
						text: "Workflowy internal API is not configured (set WORKFLOWY_USERNAME and WORKFLOWY_PASSWORD, or run './bin/run.js internal login')",
					},
				],
			},
		);
	});
});
