// @vitest-environment happy-dom
import {describe, expect, it} from "vite-plus/test";
import {QueryClient} from "@tanstack/react-query";
import
{
	pasteSteps,
	planItemPaste,
	copyTreeFromCache,
	resolveShortId,
	stepsRunnable,
} from "../src/client/paste/items.js";
import type {ItemPasteLookup} from "../src/client/paste/items.js";
import {PASTE_LIMIT_ALERT} from "../src/client/paste/apply.js";
import {nodeKeys} from "../src/client/node-cache.js";
import type {NodeResponse} from "../src/node-types.js";
import expected from "./fixtures/copy-format-expected.json" with {type: "json"};

const A2 = "00000000-0000-0000-0000-0d8bb6069b31";
const BRAVO = "00000000-0000-0000-0000-70fab4089100";

function node(
	id: string,
	name: string,
	parentId: string | null,
	priority: number,
	extra: Partial<NodeResponse> = {},
): NodeResponse
{
	return {
		id,
		parent_id: parentId,
		name,
		note: null,
		priority,
		data:
		{
			layoutMode: null,
		},
		createdAt: null,
		modifiedAt: null,
		completedAt: null,
		...extra,
	};
}

describe("planItemPaste", () =>
{
	const cutIds = new Map([
		["0d8bb6069b31", A2],
		["70fab4089100", BRAVO],
	]);

	it("restores cut rows with their original ids", () =>
	{
		expect(
			planItemPaste(
				expected.a2_bravo.html,
				{
					cutId: (short) => cutIds.get(short),
					resolve: () =>
					{
					},
				},
			),
		).toStrictEqual([
			{
				kind: "restore",
				shortId: "0d8bb6069b31",
				id: A2,
			},
			{
				kind: "restore",
				shortId: "70fab4089100",
				id: BRAVO,
			},
		]);
	});

	it("copies rows that were not cut, resolving them from the cache", () =>
	{
		expect(
			planItemPaste(
				expected.a2_bravo.html,
				{
					cutId: () =>
					{
					},
					resolve: (short) => `full-${short}`,
				},
			),
		).toStrictEqual([
			{
				kind: "copy",
				shortId: "0d8bb6069b31",
				id: "full-0d8bb6069b31",
			},
			{
				kind: "copy",
				shortId: "70fab4089100",
				id: "full-70fab4089100",
			},
		]);
	});

	it("takes only the top item when html has data-chid children", () =>
	{
		const steps = planItemPaste(
			expected.alpha_charlie.html,
			{
				cutId: () =>
				{
				},
				resolve: () =>
				{
				},
			},
		);
		expect(steps).toStrictEqual([
			{
				kind: "copy",
				shortId: "1ccce67ee6ff",
				id: null,
			},
			{
				kind: "copy",
				shortId: "9da451f0256e",
				id: null,
			},
		]);
		expect(Array.isArray(steps) && stepsRunnable(steps)).toBe(false);
	});

	it("is null for html that is not copied rows", () =>
	{
		expect(
			planItemPaste(
				"<p>hi</p>",
				{
					cutId: () =>
					{
					},
					resolve: () =>
					{
					},
				},
			),
		).toBeNull();
	});

	it("alerts above ten thousand rows", () =>
	{
		const html = `<ul>${'<li><div class="name" data-wfid="aaaaaaaaaaaa">x</div></li>'.repeat(10_001)}</ul>`;
		expect(
			planItemPaste(
				html,
				{
					cutId: () =>
					{
					},
					resolve: () =>
					{
					},
				},
			),
		).toStrictEqual(
			{
				alert: PASTE_LIMIT_ALERT,
			},
		);
	});
});

describe("mirror-aware paste plan", () =>
{
	const ORIG = "00000000-0000-0000-0000-0d8bb6069b31";
	const MIRROR = "00000000-0000-0000-0000-70fab4089100";
	const mirrorOriginal = (id: string): string | undefined => (id === ORIG || id === MIRROR ? ORIG : undefined);
	const lookup: ItemPasteLookup =
	{
		cutId: () =>
		{
		},
		resolve: (short: string) =>
			short === "0d8bb6069b31" ? ORIG : short === "70fab4089100" ? MIRROR : `plain-${short}`,
		mirrorOriginal,
	};

	it("pastes an original that has mirrors, and a mirror, as mirrors of the original", () =>
	{
		expect(planItemPaste(expected.a2_bravo.html, lookup)).toStrictEqual([
			{
				kind: "mirror",
				shortId: "0d8bb6069b31",
				originalId: ORIG,
			},
			{
				kind: "mirror",
				shortId: "70fab4089100",
				originalId: ORIG,
			},
		]);
	});

	it("copies a plain row", () =>
	{
		expect(
			planItemPaste(
				expected.a2_bravo.html,
				{
					...lookup,
					mirrorOriginal: () =>
					{
					},
				},
			),
		).toStrictEqual([
			{
				kind: "copy",
				shortId: "0d8bb6069b31",
				id: ORIG,
			},
			{
				kind: "copy",
				shortId: "70fab4089100",
				id: MIRROR,
			},
		]);
	});

	it("lets a cut row restore before any mirror rule", () =>
	{
		expect(
			planItemPaste(
				expected.a2_bravo.html,
				{
					...lookup,
					cutId: (short) => (short === "0d8bb6069b31" ? ORIG : undefined),
				},
			),
		).toStrictEqual([
			{
				kind: "restore",
				shortId: "0d8bb6069b31",
				id: ORIG,
			},
			{
				kind: "mirror",
				shortId: "70fab4089100",
				originalId: ORIG,
			},
		]);
	});

	it("runs mirror steps through the mirror effect in order", async () =>
	{
		const calls: string[] = [];
		const steps = planItemPaste(expected.a2_bravo.html, lookup);
		const result = await pasteSteps(
			Array.isArray(steps) ? steps : [],
			3,
			{
				restore: async () =>
				{
				},
				copyFromCache: async () =>
				{
				},
				fallbackCopy: async () =>
				{
				},
				mirror: async (originalId, at) =>
				{
					calls.push(`${originalId}@${at}`);
					return Promise.resolve(`m${at}`);
				},
			},
		);
		expect(
			{
				calls,
				result,
			},
		).toStrictEqual(
			{
				calls: [`${ORIG}@3`, `${ORIG}@4`],
				result:
				{
					unmovable: false,
					lastId: "m4",
					fellBack: false,
				},
			},
		);
	});
});

describe("copying from the model", () =>
{
	it("duplicates a collapsed row with its children, note, completion and layout", () =>
	{
		const queryClient = new QueryClient();
		queryClient.setQueryData(nodeKeys.children(null), [
			node(
				"00000000-0000-0000-0000-9da451f0256e",
				"Charlie",
				null,
				1,
				{
					note: "n",
					completedAt: 5,
					data:
					{
						layoutMode: "todo",
					},
				},
			),
		]);
		queryClient.setQueryData(nodeKeys.children("00000000-0000-0000-0000-9da451f0256e"), [
			node("00000000-0000-0000-0000-c1c1c1c1c1c1", "C1", "00000000-0000-0000-0000-9da451f0256e", 1),
		]);
		const id = resolveShortId(queryClient, "9da451f0256e");
		expect(id).toBe("00000000-0000-0000-0000-9da451f0256e");
		expect(copyTreeFromCache(queryClient, id ?? "")).toStrictEqual(
			{
				name: "Charlie",
				note: "n",
				completed: true,
				layoutMode: "todo",
				children: [
					{
						name: "C1",
					},
				],
			},
		);
	});
});

describe("planItemPaste of a copied Mirror", () =>
{
	it("turns each data-wf-mirror div into a mirror step for that original", () =>
	{
		expect(
			planItemPaste(
				'<div data-wf-mirror="orig-a">&nbsp;</div><div data-wf-mirror="orig-b">&nbsp;</div>',
				{
					cutId: () =>
					{
					},
					resolve: () =>
					{
					},
				},
			),
		).toStrictEqual([
			{
				kind: "mirror",
				shortId: "orig-a",
				originalId: "orig-a",
			},
			{
				kind: "mirror",
				shortId: "orig-b",
				originalId: "orig-b",
			},
		]);
	});
});
