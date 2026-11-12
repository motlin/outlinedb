import {describe, expect, it, vi} from "vite-plus/test";
import {filterBySearch, openMenuExport, selectionExportRequest} from "../src/client/export-entry.js";
import type {ExportRequest} from "../src/client/export-entry.js";

describe("selectionExportRequest", () =>
{
	it("exports the selected rows honoring search", () =>
	{
		expect(selectionExportRequest(["a", "b"])).toStrictEqual(
			{
				nodeIds: ["a", "b"],
				ignoreSearch: false,
			},
		);
	});
});

describe("openMenuExport", () =>
{
	it("exports the zoomed item without fetching", async () =>
	{
		const open = vi.fn<(request: ExportRequest) => void>();
		const fetchTopLevelIds = vi.fn<() => Promise<string[]>>(async () => Promise.resolve(["x"]));

		await openMenuExport("z", fetchTopLevelIds, open);

		expect([open.mock.calls, fetchTopLevelIds.mock.calls.length]).toStrictEqual([
			[
				[
					{
						nodeIds: ["z"],
						ignoreSearch: false,
					},
				],
			],
			0,
		]);
	});

	it("exports every top-level item ignoring search at Home", async () =>
	{
		const open = vi.fn<(request: ExportRequest) => void>();

		await openMenuExport(null, async () => Promise.resolve(["t1", "t2"]), open);

		expect(open.mock.calls).toStrictEqual([
			[
				{
					nodeIds: ["t1", "t2"],
					ignoreSearch: true,
				},
			],
		]);
	});

	it("never opens with no items", async () =>
	{
		const open = vi.fn<(request: ExportRequest) => void>();

		await openMenuExport(null, async () => Promise.resolve([]), open);

		expect(open.mock.calls).toStrictEqual([]);
	});
});

describe("filterBySearch", () =>
{
	it("keeps the roots and only the descendants the search shows", () =>
	{
		const tree = [
			{
				id: "r",
				children: [
					{
						id: "hit",
						children: [
							{
								id: "deep",
								children: [],
							},
						],
					},
					{
						id: "miss",
						children: [],
					},
				],
			},
		];

		expect(filterBySearch(tree, (id) => id === "hit")).toStrictEqual([
			{
				id: "r",
				children: [
					{
						id: "hit",
						children: [],
					},
				],
			},
		]);
	});
});
