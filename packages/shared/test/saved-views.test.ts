import {describe, expect, it} from "vite-plus/test";
import {savedViewsMap, toggleSavedView} from "../src/internal/saved-views.js";
import type {StarNodes} from "../src/internal/stars.js";

const P1 = "1a2b3c4d-0000-4000-8000-000000000001";
const P2 = "5e6f7a8b-0000-4000-8000-000000000002";
const GONE = "9c9c9c9c-0000-4000-8000-000000000009";

const names: Record<string, string> =
{
	[P1]: "Alpha",
	[P2]: "Bravo",
};
const nodes: StarNodes =
{
	exists: (nodeId) => Object.hasOwn(names, nodeId),
	nameText: (nodeId) => (nodeId === null ? "Home" : (names[nodeId] ?? "")),
};

function view(projectid: string | null, searchQuery: string, auxiliaryRootProjectId?: string)
{
	return {
		zoomedProject:
		{
			projectid,
			...(auxiliaryRootProjectId === undefined
				? {}
				:
					{
						auxiliaryRootProjectId,
					}),
		},
		searchQuery,
	};
}

describe("savedViewsMap", () =>
{
	it("maps each saved view to its location key and tree root, reading Home and a missing tree root as the main tree", () =>
	{
		const json = JSON.stringify([
			view(P1, ""),
			view(P2, "#todo", "None"),
			view(null, "date:past "),
			view("None", ""),
			view(P1, "", "other-tree"),
		]);

		expect(savedViewsMap(json)).toStrictEqual(
			{
				[P1]: "other-tree",
				[`${P2}_#todo`]: "None",
				"None_date:past ": "None",
				None: "None",
			},
		);
	});

	it("answers an empty map for missing, malformed or non-array JSON", () =>
	{
		expect(
			{
				missing: savedViewsMap(undefined),
				malformed: savedViewsMap("{"),
				object: savedViewsMap('{"a":1}'),
			},
		).toStrictEqual(
			{
				missing: {},
				malformed: {},
				object: {},
			},
		);
	});
});

describe("toggleSavedView", () =>
{
	it("appends a starred location to the valid views, sorted by name, and reports it as added", () =>
	{
		const json = JSON.stringify([view(P2, "", "None"), view(GONE, "", "None")]);

		expect(toggleSavedView(json, `${P1}_#todo`, true, nodes)).toStrictEqual(
			{
				json: JSON.stringify([view(P2, "", "None"), view(P1, "#todo", "None")]),
				delta: JSON.stringify(
					{
						added: [view(P1, "#todo", "None")],
					},
				),
			},
		);
	});

	it("removes an unstarred location and reports it as removed", () =>
	{
		const json = JSON.stringify([view(P1, "", "None"), view(P2, "", "None")]);

		expect(toggleSavedView(json, P2, false, nodes)).toStrictEqual(
			{
				json: JSON.stringify([view(P1, "", "None")]),
				delta: JSON.stringify(
					{
						removed: [view(P2, "", "None")],
					},
				),
			},
		);
	});

	it("matches a saved view without a tree root as the main-tree location", () =>
	{
		const json = JSON.stringify([view(P1, "")]);

		expect(toggleSavedView(json, P1, false, nodes)).toStrictEqual(
			{
				json: "[]",
				delta: JSON.stringify(
					{
						removed: [view(P1, "")],
					},
				),
			},
		);
	});

	it("leaves the list unchanged with an empty delta when it already holds a starred location or lacks an unstarred one", () =>
	{
		const json = JSON.stringify([view(P1, "", "None")]);

		expect(
			{
				star: toggleSavedView(json, P1, true, nodes),
				unstar: toggleSavedView(json, P2, false, nodes),
			},
		).toStrictEqual(
			{
				star:
				{
					json,
					delta: "{}",
				},
				unstar:
				{
					json,
					delta: "{}",
				},
			},
		);
	});

	it("writes Home as the None project", () =>
	{
		expect(toggleSavedView(undefined, "None_#later", true, nodes)).toStrictEqual(
			{
				json: JSON.stringify([view("None", "#later", "None")]),
				delta: JSON.stringify(
					{
						added: [view("None", "#later", "None")],
					},
				),
			},
		);
	});
});
