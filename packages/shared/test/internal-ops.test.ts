import {describe, expect, it} from "vite-plus/test";
import {applyMetadataPatches, buildMetadataPatches} from "../src/internal/metadata-patch.js";
import
{
	bulkCreateOp,
	bulkMoveOp,
	clientTimestamp,
	completeOp,
	deleteOp,
	editOp,
	moveOp,
	ROOT_PROJECT_ID,
	uncompleteOp,
	undeleteOp,
} from "../src/internal/ops.js";

const DATE_JOINED_SEC = 1_500_000_000;
const NOW_MS = 1_800_000_000_500;
const CLIENT_TS = 300_000_000;
const CLOCK =
{
	now: NOW_MS,
	dateJoinedSec: DATE_JOINED_SEC,
};

describe("buildMetadataPatches", () =>
{
	it("adds the full nested object at the first missing level", () =>
	{
		expect(buildMetadataPatches({}, ["starring", "locations", "abc"], "None")).toStrictEqual(
			{
				patches: [
					{
						op: "add",
						path: ["starring"],
						value:
						{
							locations:
							{
								abc: "None",
							},
						},
					},
				],
				inverse: [
					{
						op: "remove",
						path: ["starring"],
					},
				],
			},
		);
	});

	it("adds a leaf under an existing parent", () =>
	{
		expect(
			buildMetadataPatches(
				{
					starring:
					{
						locations: {},
					},
				},
				["starring", "locations", "abc"],
				"None",
			),
		).toStrictEqual(
			{
				patches: [
					{
						op: "add",
						path: ["starring", "locations", "abc"],
						value: "None",
					},
				],
				inverse: [
					{
						op: "remove",
						path: ["starring", "locations", "abc"],
					},
				],
			},
		);
	});

	it("replaces an existing value with a replace inverse of the old value", () =>
	{
		expect(
			buildMetadataPatches(
				{
					color:
					{
						tags:
						{
							alice: 1,
						},
					},
				},
				["color", "tags", "alice"],
				3,
			),
		).toStrictEqual(
			{
				patches: [
					{
						op: "replace",
						path: ["color", "tags", "alice"],
						value: 3,
					},
				],
				inverse: [
					{
						op: "replace",
						path: ["color", "tags", "alice"],
						value: 1,
					},
				],
			},
		);
	});

	it("replaces a non-object intermediate with the nested object", () =>
	{
		expect(
			buildMetadataPatches(
				{
					priority: true,
				},
				["priority", "defaultToBottom"],
				true,
			),
		).toStrictEqual(
			{
				patches: [
					{
						op: "replace",
						path: ["priority"],
						value:
						{
							defaultToBottom: true,
						},
					},
				],
				inverse: [
					{
						op: "replace",
						path: ["priority"],
						value: true,
					},
				],
			},
		);
	});

	it("removes an existing value with an add inverse of the old value", () =>
	{
		expect(
			buildMetadataPatches(
				{
					layoutMode: "board",
				},
				["layoutMode"],
				undefined,
			),
		).toStrictEqual(
			{
				patches: [
					{
						op: "remove",
						path: ["layoutMode"],
					},
				],
				inverse: [
					{
						op: "add",
						path: ["layoutMode"],
						value: "board",
					},
				],
			},
		);
	});

	it("emits nothing when removing a missing value or setting an identical one", () =>
	{
		expect(buildMetadataPatches({}, ["color", "tags", "alice"], undefined)).toStrictEqual(
			{
				patches: [],
				inverse: [],
			},
		);
		expect(
			buildMetadataPatches(
				{
					layoutMode: "board",
				},
				["layoutMode"],
				"board",
			),
		).toStrictEqual(
			{
				patches: [],
				inverse: [],
			},
		);
	});

	it("rejects array values", () =>
	{
		expect(() => buildMetadataPatches({}, ["starring", "order"], ["a", "b"])).toThrow(
			new TypeError("array metadata is not supported"),
		);
	});

	it("rejects an empty path", () =>
	{
		expect(() => buildMetadataPatches({}, [], 1)).toThrow(new TypeError("metadata path must not be empty"));
	});
});

describe("applyMetadataPatches", () =>
{
	it("applies patches without mutating the input", () =>
	{
		const metadata =
		{
			color:
			{
				tags:
				{
					alice: 1,
				},
			},
			layoutMode: "board",
		};
		const result = applyMetadataPatches(metadata, [
			{
				op: "replace",
				path: ["color", "tags", "alice"],
				value: 3,
			},
			{
				op: "add",
				path: ["starring"],
				value:
				{
					locations:
					{
						abc: "None",
					},
				},
			},
			{
				op: "remove",
				path: ["layoutMode"],
			},
		]);
		expect(result).toStrictEqual(
			{
				color:
				{
					tags:
					{
						alice: 3,
					},
				},
				starring:
				{
					locations:
					{
						abc: "None",
					},
				},
			},
		);
		expect(metadata).toStrictEqual(
			{
				color:
				{
					tags:
					{
						alice: 1,
					},
				},
				layoutMode: "board",
			},
		);
	});

	it("round-trips patches and their inverse", () =>
	{
		const metadata =
		{
			starring:
			{
				locations: {},
			},
		};
		const {patches, inverse} = buildMetadataPatches(metadata, ["starring", "locations", "abc"], "None");
		const patched = applyMetadataPatches(metadata, patches);
		expect(patched).toStrictEqual(
			{
				starring:
				{
					locations:
					{
						abc: "None",
					},
				},
			},
		);
		expect(applyMetadataPatches(patched, inverse)).toStrictEqual(metadata);
	});
});

describe("clientTimestamp", () =>
{
	it("is whole seconds since the account join date", () =>
	{
		expect(clientTimestamp(CLOCK)).toBe(CLIENT_TS);
	});
});

describe("editOp", () =>
{
	it("builds a rename with metadata patches and undo data", () =>
	{
		const {patches, inverse} = buildMetadataPatches({}, ["layoutMode"], "board");
		expect(
			editOp(
				{
					id: "c",
					name: "New",
					note: "Note",
					metadataPatches: patches,
					metadataInversePatches: inverse,
					previous:
					{
						name: "Old",
						note: "",
						lastModified: 299_000_000,
						lastModifiedBy: null,
					},
					...CLOCK,
				},
			),
		).toStrictEqual(
			{
				type: "edit",
				data:
				{
					projectid: "c",
					name: "New",
					description: "Note",
					metadataPatches: [
						{
							op: "add",
							path: ["layoutMode"],
							value: "board",
						},
					],
					metadataInversePatches: [
						{
							op: "remove",
							path: ["layoutMode"],
						},
					],
				},
				client_timestamp: CLIENT_TS,
				undo_data:
				{
					previous_last_modified: 299_000_000,
					previous_last_modified_by: null,
					previous_name: "Old",
					previous_description: "",
					metadataPatches: [
						{
							op: "remove",
							path: ["layoutMode"],
						},
					],
				},
			},
		);
	});

	it("builds a metadata-only edit on Home", () =>
	{
		const {patches, inverse} = buildMetadataPatches({}, ["color", "tags", "alice"], 3);
		expect(
			editOp(
				{
					id: ROOT_PROJECT_ID,
					metadataPatches: patches,
					metadataInversePatches: inverse,
					...CLOCK,
				},
			),
		).toStrictEqual(
			{
				type: "edit",
				data:
				{
					projectid: "None",
					metadataPatches: [
						{
							op: "add",
							path: ["color"],
							value:
							{
								tags:
								{
									alice: 3,
								},
							},
						},
					],
					metadataInversePatches: [
						{
							op: "remove",
							path: ["color"],
						},
					],
				},
				client_timestamp: CLIENT_TS,
				undo_data:
				{
					previous_last_modified: null,
					previous_last_modified_by: null,
					metadataPatches: [
						{
							op: "remove",
							path: ["color"],
						},
					],
				},
			},
		);
	});
});

describe("bulkCreateOp", () =>
{
	it("puts client-generated ids into project_trees and returns them", () =>
	{
		const generated = ["id-1", "id-2"];
		const {op, ids} = bulkCreateOp(
			{
				parentId: "p",
				index: 2,
				trees: [
					{
						name: "First",
						note: "n",
						metadata:
						{
							layoutMode: "board",
						},
						children: [
							{
								name: "Child",
							},
						],
					},
				],
				userId: 42,
				generateId: () => generated.shift() ?? "unexpected",
				...CLOCK,
			},
		);
		expect(ids).toStrictEqual(["id-1"]);
		expect(op).toStrictEqual(
			{
				type: "bulk_create",
				data:
				{
					parentid: "p",
					starting_priority: 2,
					project_trees: JSON.stringify([
						{
							id: "id-1",
							nm: "First",
							no: "n",
							metadata:
							{
								layoutMode: "board",
							},
							ct: CLIENT_TS,
							cb: 42,
							ch: [
								{
									id: "id-2",
									nm: "Child",
									ct: CLIENT_TS,
									cb: 42,
									ch: [],
								},
							],
						},
					]),
					isForSearch: false,
				},
				client_timestamp: CLIENT_TS,
				undo_data: {},
			},
		);
	});

	it("emits cp for completed trees at every depth", () =>
	{
		const generated = ["id-1", "id-2"];
		const {op} = bulkCreateOp(
			{
				parentId: "p",
				index: 0,
				trees: [
					{
						name: "a",
						completed: true,
						children: [
							{
								name: "b",
								metadata:
								{
									layoutMode: "h1",
								},
							},
						],
					},
				],
				userId: 42,
				generateId: () => generated.shift() ?? "unexpected",
				...CLOCK,
			},
		);
		expect(op.data.project_trees).toBe(
			JSON.stringify([
				{
					id: "id-1",
					nm: "a",
					ct: CLIENT_TS,
					cb: 42,
					cp: CLIENT_TS,
					ch: [
						{
							id: "id-2",
							nm: "b",
							metadata:
							{
								layoutMode: "h1",
							},
							ct: CLIENT_TS,
							cb: 42,
							ch: [],
						},
					],
				},
			]),
		);
	});

	it("keeps caller-supplied ids", () =>
	{
		const {op, ids} = bulkCreateOp(
			{
				parentId: "p",
				index: 0,
				trees: [
					{
						id: "fixed",
						name: "Day",
					},
				],
				userId: 42,
				generateId: () => "unexpected",
				...CLOCK,
			},
		);
		expect(ids).toStrictEqual(["fixed"]);
		expect(op.data.project_trees).toBe(
			JSON.stringify([
				{
					id: "fixed",
					nm: "Day",
					ct: CLIENT_TS,
					cb: 42,
					ch: [],
				},
			]),
		);
	});
});

describe("moveOp", () =>
{
	it("builds the full envelope for a same-parent move up", () =>
	{
		expect(
			moveOp(
				{
					id: "c",
					parentId: "p",
					index: 0,
					from:
					{
						parentId: "p",
						index: 2,
					},
					...CLOCK,
				},
			),
		).toStrictEqual(
			{
				type: "move",
				data:
				{
					projectid: "c",
					parentid: "p",
					priority: 0,
				},
				client_timestamp: CLIENT_TS,
				undo_data:
				{
					previous_parentid: "p",
					previous_priority: 2,
					previous_last_modified: null,
					previous_last_modified_by: null,
				},
			},
		);
	});

	it("uses the index after removal for a same-parent move down", () =>
	{
		expect(
			moveOp(
				{
					id: "c",
					parentId: "p",
					index: 3,
					from:
					{
						parentId: "p",
						index: 0,
					},
					...CLOCK,
				},
			).data,
		).toStrictEqual(
			{
				projectid: "c",
				parentid: "p",
				priority: 2,
			},
		);
	});

	it("keeps the slot index when moving to another parent", () =>
	{
		expect(
			moveOp(
				{
					id: "c",
					parentId: "q",
					index: 3,
					from:
					{
						parentId: "p",
						index: 0,
					},
					previous:
					{
						lastModified: 10,
						lastModifiedBy: 7,
					},
					...CLOCK,
				},
			),
		).toStrictEqual(
			{
				type: "move",
				data:
				{
					projectid: "c",
					parentid: "q",
					priority: 3,
				},
				client_timestamp: CLIENT_TS,
				undo_data:
				{
					previous_parentid: "p",
					previous_priority: 0,
					previous_last_modified: 10,
					previous_last_modified_by: 7,
				},
			},
		);
	});
});

describe("bulkMoveOp", () =>
{
	it("uses the count of non-moved siblings before the block as priority", () =>
	{
		expect(
			bulkMoveOp(
				{
					items: [
						{
							id: "a",
							from:
							{
								parentId: "p",
								index: 0,
							},
						},
						{
							id: "c",
							from:
							{
								parentId: "p",
								index: 2,
							},
						},
					],
					parentId: "p",
					siblings: ["a", "b", "c", "d", "e"],
					index: 4,
					...CLOCK,
				},
			),
		).toStrictEqual(
			{
				type: "bulk_move",
				data:
				{
					projectids_json: JSON.stringify(["a", "c"]),
					parentid: "p",
					priority: 2,
				},
				client_timestamp: CLIENT_TS,
				undo_data:
				{
					move_undo_datas: [
						{
							previous_parentid: "p",
							previous_priority: 0,
							previous_last_modified: null,
							previous_last_modified_by: null,
							priority_used_for_move: 2,
						},
						{
							previous_parentid: "p",
							previous_priority: 2,
							previous_last_modified: null,
							previous_last_modified_by: null,
							priority_used_for_move: 3,
						},
					],
				},
			},
		);
	});
});

describe("delete, undelete, complete, uncomplete", () =>
{
	it("builds delete with its location in undo data", () =>
	{
		expect(
			deleteOp(
				{
					id: "c",
					from:
					{
						parentId: "p",
						index: 1,
					},
					...CLOCK,
				},
			),
		).toStrictEqual(
			{
				type: "delete",
				data:
				{
					projectid: "c",
				},
				client_timestamp: CLIENT_TS,
				undo_data:
				{
					previous_last_modified: null,
					previous_last_modified_by: null,
					parentid: "p",
					priority: 1,
				},
			},
		);
	});

	it("builds undelete at an explicit location", () =>
	{
		expect(
			undeleteOp(
				{
					id: "c",
					parentId: "p",
					index: 1,
					...CLOCK,
				},
			),
		).toStrictEqual(
			{
				type: "undelete",
				data:
				{
					projectid: "c",
					parentid: "p",
					priority: 1,
				},
				client_timestamp: CLIENT_TS,
				undo_data:
				{
					previous_last_modified: null,
					previous_last_modified_by: null,
				},
			},
		);
	});

	it("builds complete and uncomplete with the previous completion state", () =>
	{
		expect(
			completeOp(
				{
					id: "c",
					previousCompleted: false,
					...CLOCK,
				},
			),
		).toStrictEqual(
			{
				type: "complete",
				data:
				{
					projectid: "c",
				},
				client_timestamp: CLIENT_TS,
				undo_data:
				{
					previous_last_modified: null,
					previous_last_modified_by: null,
					previous_completed: false,
				},
			},
		);
		expect(
			uncompleteOp(
				{
					id: "c",
					previousCompleted: 299_000_000,
					...CLOCK,
				},
			),
		).toStrictEqual(
			{
				type: "uncomplete",
				data:
				{
					projectid: "c",
				},
				client_timestamp: CLIENT_TS,
				undo_data:
				{
					previous_last_modified: null,
					previous_last_modified_by: null,
					previous_completed: 299_000_000,
				},
			},
		);
	});
});
