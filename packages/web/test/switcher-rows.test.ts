import {describe, expect, it} from "vite-plus/test";
import type {Star} from "@outlinedb/shared";
import type {SwitcherResult} from "../src/server/switcher-search.js";
import {buildSwitcherRows, starredNodeIds} from "../src/client/switcher-rows.js";
import type {StarredEntry} from "../src/client/switcher-rows.js";

function star(nodeId: string | null, query: string | null = null, name: string | null = null): Star
{
	const key = (nodeId ?? "None") + (query ? `_${query}` : "");
	return {
		key,
		nodeId,
		query,
		name,
		position: 0,
	};
}

function entry(
	overrides: Partial<StarredEntry> &
	{
		star: Star;
	},
): StarredEntry
{
	return {
		name: "",
		note: "",
		completed: false,
		ancestors: [],
		...overrides,
	};
}

function result(id: string, labelHtml: string): SwitcherResult
{
	return {
		id,
		labelHtml,
		completed: false,
		starred: false,
		ancestors: [],
	};
}

const IDLE =
{
	status: "idle",
	results: [],
} as const;

describe("buildSwitcherRows", () =>
{
	it("lists every starred location in the given order for an empty filter", () =>
	{
		const starred = [
			entry(
				{
					star: star("b"),
					name: "Beta",
					ancestors: [
						{
							id: "p",
							name: "Parent",
						},
					],
				},
			),
			entry(
				{
					star: star("a", "#todo", "Todos"),
					name: "Alpha",
				},
			),
		];
		expect(buildSwitcherRows(starred, IDLE, "")).toStrictEqual(
			{
				rows: [
					{
						key: "b",
						id: "b",
						nodeId: "b",
						query: null,
						search: "Beta",
						labelHtml: "Beta",
						completed: false,
						starred: true,
						ancestors: [
							{
								id: "p",
								name: "Parent",
							},
							{
								id: "b",
								name: "Beta",
							},
						],
					},
					{
						key: "a_#todo",
						id: "a",
						nodeId: "a",
						query: "#todo",
						search: "Todos",
						labelHtml: "Todos",
						completed: false,
						starred: true,
						ancestors: [
							{
								id: "a",
								name: "Alpha",
							},
						],
					},
				],
				emptyText: null,
				indexing: false,
			},
		);
	});

	it("ends a starred search's crumbs in its page's plain-text name", () =>
	{
		const starred = [
			entry(
				{
					star: star("a", "#todo", "Todos"),
					name: '<span class="colored c-red">Bat</span> mitzvah',
					ancestors: [
						{
							id: "p",
							name: "Parent",
						},
					],
				},
			),
		];
		expect(buildSwitcherRows(starred, IDLE, "")).toStrictEqual(
			{
				rows: [
					{
						key: "a_#todo",
						id: "a",
						nodeId: "a",
						query: "#todo",
						search: "Todos",
						labelHtml: "Todos",
						completed: false,
						starred: true,
						ancestors: [
							{
								id: "p",
								name: "Parent",
							},
							{
								id: "a",
								name: "Bat mitzvah",
							},
						],
					},
				],
				emptyText: null,
				indexing: false,
			},
		);
	});

	it("shows the starred-pages hint with no stars and an empty filter", () =>
	{
		expect(buildSwitcherRows([], IDLE, "")).toStrictEqual(
			{
				rows: [],
				emptyText: "Your starred pages will appear here.",
				indexing: false,
			},
		);
	});

	it("reports a failed search", () =>
	{
		expect(
			buildSwitcherRows(
				[],
				{
					status: "error",
					results: [],
				},
				"qwzx",
			),
		).toStrictEqual(
			{
				rows: [],
				emptyText: "Search is unavailable right now.",
				indexing: false,
			},
		);
	});

	it("says nothing while the first request is in flight but not yet slow", () =>
	{
		expect(buildSwitcherRows([], IDLE, "qwzx")).toStrictEqual(
			{
				rows: [],
				emptyText: null,
				indexing: false,
			},
		);
	});

	it("shows the indexing message once the first request is slow", () =>
	{
		expect(
			buildSwitcherRows(
				[],
				{
					status: "pending",
					results: [],
				},
				"qwzx",
			),
		).toStrictEqual(
			{
				rows: [],
				emptyText: "Indexing your data! One sec …",
				indexing: true,
			},
		);
	});

	it("reports no matches once the search is done and some stars exist", () =>
	{
		expect(
			buildSwitcherRows(
				[
					entry(
						{
							star: star("s"),
							name: "other",
						},
					),
				],
				{
					status: "done",
					results: [],
				},
				"qwzx",
			),
		).toStrictEqual(
			{
				rows: [],
				emptyText: "No matches found. Try adjusting your search.",
				indexing: false,
			},
		);
	});

	it("puts matching starred entries first and drops their server duplicates", () =>
	{
		const starred = [
			entry(
				{
					star: star("s"),
					name: "qwzx starred",
				},
			),
			entry(
				{
					star: star("t"),
					name: "other",
				},
			),
		];
		const server =
		{
			status: "done",
			results: [result("r", "<b><u>qwzx</u></b> plain"), result("s", "<b><u>qwzx</u></b> starred")],
		} as const;
		expect(buildSwitcherRows(starred, server, "qwzx")).toStrictEqual(
			{
				rows: [
					{
						key: "s",
						id: "s",
						nodeId: "s",
						query: null,
						search: "<b><u>qwzx</u></b> starred",
						labelHtml: "<b><u>qwzx</u></b> starred",
						completed: false,
						starred: true,
						ancestors: [
							{
								id: "s",
								name: "qwzx starred",
							},
						],
					},
					{
						key: "r",
						id: "r",
						nodeId: "r",
						query: null,
						search: null,
						labelHtml: "<b><u>qwzx</u></b> plain",
						completed: false,
						starred: false,
						ancestors: [],
					},
				],
				emptyText: null,
				indexing: false,
			},
		);
	});

	it("labels a starred Home page as Home with no crumbs", () =>
	{
		expect(
			buildSwitcherRows(
				[
					entry(
						{
							star: star(null),
						},
					),
				],
				IDLE,
				"",
			).rows,
		).toStrictEqual([
			{
				key: "None",
				id: "",
				nodeId: null,
				query: null,
				search: "Home",
				labelHtml: "Home",
				completed: false,
				starred: true,
				ancestors: [],
			},
		]);
	});
});

describe("buildSwitcherRows paging and empty state", () =>
{
	it("shows 20 rows in total on the first page, starred matches included", () =>
	{
		const starred = [
			entry(
				{
					star: star("s1"),
					name: "qw one",
				},
			),
			entry(
				{
					star: star("s2"),
					name: "qw two",
				},
			),
		];
		const results = Array.from(
			{
				length: 20,
			},
			(_, index) => result(`r${index}`, `qw ${index}`),
		);
		const first = buildSwitcherRows(
			starred,
			{
				status: "done",
				results,
			},
			"qw",
			1,
		).rows.map((row) => row.key);
		expect(first).toStrictEqual(["s1", "s2", ...results.slice(0, 18).map((r) => r.id)]);
		expect(
			buildSwitcherRows(
				starred,
				{
					status: "done",
					results,
				},
				"qw",
				2,
			).rows,
		).toHaveLength(22);
	});

	it("gives server rows a null search", () =>
	{
		const [row] = buildSwitcherRows(
			[],
			{
				status: "done",
				results: [result("r", "qw")],
			},
			"qw",
		).rows;
		expect(row.search).toBeNull();
	});

	it("shows no empty text when a special row is listed", () =>
	{
		expect(
			buildSwitcherRows(
				[],
				{
					status: "done",
					results: [],
				},
				"..",
				1,
				1,
			).emptyText,
		).toBeNull();
	});

	it("shows the starred hint with no stars even when a filter matched nothing", () =>
	{
		expect(
			buildSwitcherRows(
				[],
				{
					status: "done",
					results: [],
				},
				"zz",
			).emptyText,
		).toBe("Your starred pages will appear here.");
	});

	it("reports no matches when stars exist but none matched", () =>
	{
		const starred = [
			entry(
				{
					star: star("a"),
					name: "Alpha",
				},
			),
		];
		expect(
			buildSwitcherRows(
				starred,
				{
					status: "done",
					results: [],
				},
				"zz",
			).emptyText,
		).toBe("No matches found. Try adjusting your search.");
	});
});

describe("starredNodeIds", () =>
{
	it("lists each starred node once in first-seen order, skipping home stars, so useQueries gets no duplicate keys", () =>
	{
		expect(
			starredNodeIds([star("a"), star(null, "#todo"), star("b"), star("a", "#todo"), star(null)]),
		).toStrictEqual(["a", "b"]);
	});
});
