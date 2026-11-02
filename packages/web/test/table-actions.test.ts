import {beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {QueryClient} from "@tanstack/react-query";
import type {NodeResponse} from "../src/node-types.js";

vi.mock("../src/client/stores/outline.js", () => (
{
	activePaneView: () => (
	{
		zoomedNodeId: "t",
	}),
	useOutlineStore:
	{
		getState: () => ({}),
	},
}));

const {nodeKeys} = await import("../src/client/node-cache.js");
const {locateCell} = await import("../src/client/table-cache.js");
const {addColumn, addRow, cellBackspace, cellDelete, cellEnter, duplicateColumn, moveCell, structureTable} =
	await import("../src/client/table-actions.js");
import type {TableDeps} from "../src/client/table-actions.js";

function node(id: string, parentId: string | null, priority: number, over: Partial<NodeResponse> = {}): NodeResponse
{
	return {
		id,
		parent_id: parentId,
		name: id,
		note: null,
		priority,
		data:
		{
			layoutMode: null,
		},
		createdAt: null,
		modifiedAt: null,
		completedAt: null,
		hasChildren: false,
		...over,
	};
}

let queryClient = new QueryClient();
let calls: unknown[] = [];
let confirmAnswer = true;
let counter = 0;

function deps(): TableDeps
{
	return {
		queryClient,
		create: (request) =>
		{
			calls.push(["create", request]);
		},
		remove: (id) =>
		{
			calls.push(["remove", id]);
		},
		move: (id, parentId, index) =>
		{
			calls.push(["move", id, parentId, index]);
		},
		duplicate: async (ids, parentId, index) =>
		{
			calls.push(["duplicate", ids, parentId, index]);
			return Promise.resolve([]);
		},
		setTable: (id, path, value) =>
		{
			calls.push(["setTable", id, path, value]);
		},
		expand: (ids) =>
		{
			calls.push(["expand", [...ids]]);
		},
		focus: (id, caret) =>
		{
			calls.push(["focus", id, caret]);
		},
		confirm: async (message) =>
		{
			calls.push(["confirm", message]);
			return Promise.resolve(confirmAnswer);
		},
		loadChildren: async () => Promise.resolve([]),
		batch: async (fn) =>
		{
			await fn();
		},
		newId: () => `new${(counter += 1)}`,
	};
}

/** Name|Qty / Apple|3(child) / Pear|"" */
function seed(): void
{
	queryClient = new QueryClient();
	const set = (parent: string | null, children: NodeResponse[]) =>
		queryClient.setQueryData(nodeKeys.children(parent), children);
	set(null, [
		node(
			"t",
			null,
			0,
			{
				data:
				{
					layoutMode: "table",
				},
				hasChildren: true,
			},
		),
	]);
	set("t", [
		node(
			"h",
			"t",
			0,
			{
				hasChildren: true,
			},
		),
		node(
			"a",
			"t",
			1,
			{
				hasChildren: true,
			},
		),
		node(
			"p",
			"t",
			2,
			{
				hasChildren: true,
			},
		),
	]);
	set("h", [node("h0", "h", 0), node("h1", "h", 1)]);
	set("a", [
		node("a0", "a", 0),
		node(
			"a1",
			"a",
			1,
			{
				hasChildren: true,
			},
		),
	]);
	set("p", [
		node("p0", "p", 0),
		node(
			"p1",
			"p",
			1,
			{
				name: "",
			},
		),
	]);
}

function located(id: string)
{
	const location = locateCell(queryClient, id);
	if (location === null)
	{
		throw new Error(`${id} is not a cell`);
	}
	return location;
}

describe("table actions", () =>
{
	beforeEach(() =>
	{
		seed();
		calls = [];
		confirmAnswer = true;
		counter = 0;
	});

	it("locates a cell in its renderable table only", () =>
	{
		expect(
			{
				cell: locateCell(queryClient, "a1")?.colIndex,
				row: locateCell(queryClient, "a"),
				table: locateCell(queryClient, "t"),
			},
		).toStrictEqual(
			{
				cell: 1,
				row: null,
				table: null,
			},
		);
	});

	it("Enter inserts a padded row below and focuses the same column", async () =>
	{
		await cellEnter(deps(), located("a1"));
		expect(calls).toStrictEqual([
			[
				"create",
				{
					id: "new1",
					parent_id: "t",
					name: "Row",
					index: 2,
				},
			],
			[
				"create",
				{
					id: "new2",
					parent_id: "new1",
					name: "",
					index: 0,
				},
			],
			[
				"create",
				{
					id: "new3",
					parent_id: "new1",
					name: "",
					index: 1,
				},
			],
			["focus", "new3", "start"],
		]);
	});

	it("deleting a body cell with children asks first, then clears it and refocuses above", async () =>
	{
		await cellDelete(deps(), located("a1"), []);
		expect(calls).toStrictEqual([
			[
				"confirm",
				"Some cells contain nested items. If you delete these cells, their nested items will be deleted too.",
			],
			["remove", "a1"],
			[
				"create",
				{
					id: "new1",
					parent_id: "a",
					name: "",
					index: 1,
				},
			],
			["focus", "h1", "start"],
		]);
	});

	it("keeps the cell when the confirmation is declined", async () =>
	{
		confirmAnswer = false;
		await cellDelete(deps(), located("a1"), []);
		expect(calls.map((call) => (call as unknown[])[0])).toStrictEqual(["confirm"]);
	});

	it("deleting a header cell removes the column and focuses its neighbour", async () =>
	{
		await cellDelete(deps(), located("h0"), []);
		expect(calls).toStrictEqual([
			["remove", "h0"],
			["remove", "a0"],
			["remove", "p0"],
			["focus", "h1", "start"],
		]);
	});

	it("Backspace clears a wholly empty cell and ignores a cell with text", async () =>
	{
		await cellBackspace(
			deps(),
			located("p1"),
			{
				name: "",
				note: "",
				hasChildren: false,
			},
		);
		await cellBackspace(
			deps(),
			located("a0"),
			{
				name: "a0",
				note: "",
				hasChildren: false,
			},
		);
		expect(calls).toStrictEqual([
			["remove", "p1"],
			[
				"create",
				{
					id: "new1",
					parent_id: "p",
					name: "",
					index: 1,
				},
			],
			["focus", "a1", "start"],
		]);
	});

	it("duplicates the cell's column into the next slot of every row", async () =>
	{
		await duplicateColumn(deps(), located("a0"));
		expect(calls).toStrictEqual([
			["duplicate", ["h0"], "h", 1],
			["duplicate", ["a0"], "a", 1],
			["duplicate", ["p0"], "p", 1],
		]);
	});

	it("moves a body row up, a header column right, and ignores a move past the end", async () =>
	{
		await moveCell(deps(), located("p0"), "up");
		await moveCell(deps(), located("h0"), "down");
		const stayed = await moveCell(deps(), located("a0"), "up");
		expect(
			{
				calls,
				stayed,
			},
		).toStrictEqual(
			{
				calls: [
					["move", "p", "t", 1],
					["move", "h0", "h", 1],
					["move", "a0", "a", 1],
					["move", "p0", "p", 1],
				],
				stayed: false,
			},
		);
	});

	it("the header plus appends a cell to every row and focuses the new header cell", async () =>
	{
		await addColumn(deps(), "t");
		expect(calls).toStrictEqual([
			[
				"create",
				{
					id: "new1",
					parent_id: "h",
					name: "",
					index: 2,
				},
			],
			[
				"create",
				{
					id: "new2",
					parent_id: "a",
					name: "",
					index: 2,
				},
			],
			[
				"create",
				{
					id: "new3",
					parent_id: "p",
					name: "",
					index: 2,
				},
			],
			["focus", "new1", "start"],
		]);
	});

	it("the add-row button appends a Row as wide as the table and focuses its first cell", async () =>
	{
		await addRow(deps(), "t");
		expect(calls).toStrictEqual([
			[
				"create",
				{
					id: "new1",
					parent_id: "t",
					name: "Row",
					index: 3,
				},
			],
			[
				"create",
				{
					id: "new2",
					parent_id: "new1",
					name: "",
					index: 0,
				},
			],
			[
				"create",
				{
					id: "new3",
					parent_id: "new1",
					name: "",
					index: 1,
				},
			],
			["focus", "new2", "start"],
		]);
	});

	it("turning a table off drops the trailing empty cell, keeping a row that has text", async () =>
	{
		await structureTable(deps(), "t", false);
		expect(calls).toStrictEqual([["remove", "p1"]]);
	});

	it("turning a table on adds a Headers row when the first row is not one, padding and expanding the rows", async () =>
	{
		await structureTable(deps(), "t", true);
		expect(calls).toStrictEqual([
			[
				"create",
				{
					id: "new1",
					parent_id: "t",
					name: "Headers",
					index: 0,
				},
			],
			["setTable", "new1", ["table", "headers"], true],
			[
				"create",
				{
					id: "new2",
					parent_id: "new1",
					name: "",
					index: 0,
				},
			],
			[
				"create",
				{
					id: "new3",
					parent_id: "new1",
					name: "",
					index: 1,
				},
			],
			["expand", ["h", "a", "p"]],
		]);
	});
});
