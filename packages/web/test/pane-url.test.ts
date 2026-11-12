import {describe, expect, it} from "vite-plus/test";
import
{
	applyPaneStorageUpdate,
	createPaneId,
	decodePanes,
	decodeWorkspace,
	encodePanes,
	encodeWorkspace,
	paneStorageUpdate,
	reconcilePaneUrl,
	restoredPaneWidth,
	restoredRuntime,
	sameWorkspace,
	storeWorkspaceUrl,
	withPanesFragment,
} from "../src/client/pane-url.js";
import type {PaneUrlAction, WorkspaceUrl} from "../src/client/pane-url.js";

const MAIN = "AAAAAAAAAAA";
const SIDE = "BBBBBBBBBBB";
const THIRD = "DDDDDDDDDDD";

function base64url(text: string): string
{
	return Buffer.from(text, "utf8").toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

describe("encodePanes", () =>
{
	it("prefixes v2. to base64url JSON of the pane state, like upstream $92", () =>
	{
		const state = [
			[MAIN, "item-tree"],
			[SIDE, "item-tree", ["35035d443bf1"]],
		];
		expect(encodePanes(state)).toBe(`v2.${base64url(JSON.stringify(state))}`);
	});

	it("encodes non-ASCII search queries as UTF-8", () =>
	{
		const state = [
			[MAIN, "item-tree"],
			[SIDE, "item-tree", ["None", "café ✓"]],
		];
		expect(encodePanes(state)).toBe(`v2.${base64url(JSON.stringify(state))}`);
	});
});

describe("decodePanes", () =>
{
	it("is absent for a missing value", () =>
	{
		expect(decodePanes(undefined)).toStrictEqual(
			{
				kind: "absent",
			},
		);
	});

	it("round-trips an encoded state", () =>
	{
		const state: [string, string, ...unknown[]][] = [
			[MAIN, "item-tree"],
			[SIDE, "item-tree", ["35035d443bf1", "q"]],
		];
		expect(decodePanes(encodePanes(state))).toStrictEqual(
			{
				kind: "valid",
				state,
			},
		);
	});

	it.each([
		["no v2. prefix", "v1.W10"],
		["an empty payload", "v2."],
		["non-base64url characters", "v2.ab+c"],
		["an impossible base64 length", "v2.abcde"],
		["non-JSON", `v2.${base64url("{")}`],
		["a non-array", `v2.${base64url("{}")}`],
		["an empty array", `v2.${base64url("[]")}`],
		["a main entry of the wrong length", `v2.${base64url(JSON.stringify([[MAIN]]))}`],
		["a main entry that is not item-tree", `v2.${base64url(JSON.stringify([[MAIN, "board"]]))}`],
		["a malformed main pane id", `v2.${base64url(JSON.stringify([["short", "item-tree"]]))}`],
		[
			"a pane entry of the wrong length",
			`v2.${base64url(
				JSON.stringify([
					[MAIN, "item-tree"],
					[SIDE, "item-tree"],
				]),
			)}`,
		],
		[
			"a malformed pane id",
			`v2.${base64url(
				JSON.stringify([
					[MAIN, "item-tree"],
					["bad!", "item-tree", []],
				]),
			)}`,
		],
		[
			"a duplicate pane id",
			`v2.${base64url(
				JSON.stringify([
					[MAIN, "item-tree"],
					[MAIN, "item-tree", []],
				]),
			)}`,
		],
		[
			"an empty pane type",
			`v2.${base64url(
				JSON.stringify([
					[MAIN, "item-tree"],
					[SIDE, "", []],
				]),
			)}`,
		],
	])("is invalid for %s", (_label, value) =>
	{
		expect(decodePanes(value)).toStrictEqual(
			{
				kind: "invalid",
			},
		);
	});

	it("is invalid past upstream's 65536-character cap", () =>
	{
		expect(decodePanes(`v2.${"a".repeat(65_536)}`)).toStrictEqual(
			{
				kind: "invalid",
			},
		);
	});
});

describe("encodeWorkspace / decodeWorkspace", () =>
{
	it("encodes each pane's zoom as its short id, main first", () =>
	{
		const encoded = encodeWorkspace(
			{
				mainPaneId: MAIN,
				panes: [
					{
						paneId: SIDE,
						location: "4823cefa-5fc0-478c-88ac-35035d443bf1",
					},
					{
						paneId: THIRD,
						location: "7f3e2a1b9c0d",
					},
				],
			},
		);
		expect(decodePanes(encoded)).toStrictEqual(
			{
				kind: "valid",
				state: [
					[MAIN, "item-tree"],
					[SIDE, "item-tree", ["35035d443bf1"]],
					[THIRD, "item-tree", ["7f3e2a1b9c0d"]],
				],
			},
		);
	});

	it("encodes a Home zoom as upstream's None", () =>
	{
		const encoded = encodeWorkspace(
			{
				mainPaneId: MAIN,
				panes: [
					{
						paneId: SIDE,
						location: null,
					},
				],
			},
		);
		expect(decodePanes(encoded)).toStrictEqual(
			{
				kind: "valid",
				state: [
					[MAIN, "item-tree"],
					[SIDE, "item-tree", ["None"]],
				],
			},
		);
	});

	it("writes a pane's search query after its zoom, like upstream's [shortId, searchQuery], leaving empty ones out", () =>
	{
		const encoded = encodeWorkspace(
			{
				mainPaneId: MAIN,
				panes: [
					{
						paneId: SIDE,
						location: null,
						query: "#todo",
					},
					{
						paneId: THIRD,
						location: null,
						query: "",
					},
				],
			},
		);
		expect(decodePanes(encoded)).toStrictEqual(
			{
				kind: "valid",
				state: [
					[MAIN, "item-tree"],
					[SIDE, "item-tree", ["None", "#todo"]],
					[THIRD, "item-tree", ["None"]],
				],
			},
		);
	});

	it("decodes every extra item-tree pane, with None as Home and an optional query", () =>
	{
		const value = encodePanes([
			[MAIN, "item-tree"],
			[SIDE, "item-tree", ["None"]],
			[THIRD, "item-tree", ["35035d443bf1", "todo"]],
		]);
		expect(decodeWorkspace(value)).toStrictEqual(
			{
				mainPaneId: MAIN,
				panes: [
					{
						paneId: SIDE,
						location: null,
						query: null,
					},
					{
						paneId: THIRD,
						location: "35035d443bf1",
						query: "todo",
					},
				],
			},
		);
	});

	it.each([
		["absent", undefined],
		["invalid", "v2."],
		["main pane only", encodePanes([[MAIN, "item-tree"]])],
		[
			"an unknown pane type after a valid pane",
			encodePanes([
				[MAIN, "item-tree"],
				[SIDE, "item-tree", ["None"]],
				[THIRD, "board", ["None"]],
			]),
		],
		[
			"a non-array urlState",
			encodePanes([
				[MAIN, "item-tree"],
				[SIDE, "item-tree", "None"],
			]),
		],
		[
			"a non-string id",
			encodePanes([
				[MAIN, "item-tree"],
				[SIDE, "item-tree", [7]],
			]),
		],
		[
			"a non-string query",
			encodePanes([
				[MAIN, "item-tree"],
				[SIDE, "item-tree", ["None", 7]],
			]),
		],
		[
			"an empty id",
			encodePanes([
				[MAIN, "item-tree"],
				[SIDE, "item-tree", [""]],
			]),
		],
	])("is null for %s", (_label, value) =>
	{
		expect(decodeWorkspace(value)).toBeNull();
	});
});

describe("sameWorkspace", () =>
{
	const zoomed =
	{
		paneId: SIDE,
		location: "4823cefa-5fc0-478c-88ac-35035d443bf1",
	};

	it("compares pane ids in order and each zoom's short id", () =>
	{
		const a =
		{
			mainPaneId: MAIN,
			panes: [
				zoomed,
				{
					paneId: THIRD,
					location: null,
				},
			],
		};
		expect(
			{
				same: sameWorkspace(
					a,
					{
						mainPaneId: MAIN,
						panes: [
							{
								paneId: SIDE,
								location: "35035d443bf1",
							},
							{
								paneId: THIRD,
								location: null,
							},
						],
					},
				),
				otherZoom: sameWorkspace(
					a,
					{
						mainPaneId: MAIN,
						panes: [
							{
								paneId: SIDE,
								location: null,
							},
							{
								paneId: THIRD,
								location: null,
							},
						],
					},
				),
				reordered: sameWorkspace(
					a,
					{
						mainPaneId: MAIN,
						panes: [
							{
								paneId: THIRD,
								location: null,
							},
							zoomed,
						],
					},
				),
				fewer: sameWorkspace(
					a,
					{
						mainPaneId: MAIN,
						panes: [zoomed],
					},
				),
				otherMain: sameWorkspace(
					a,
					{
						...a,
						mainPaneId: THIRD,
					},
				),
				bothNull: sameWorkspace(null, null),
				oneNull: sameWorkspace(a, null),
			},
		).toStrictEqual(
			{
				same: true,
				otherZoom: false,
				reordered: false,
				fewer: false,
				otherMain: false,
				bothNull: true,
				oneNull: false,
			},
		);
	});

	it("tells pane searches apart, with no query the same as an empty one", () =>
	{
		const a =
		{
			paneId: SIDE,
			location: null,
		};
		const ws = (pane: {paneId: string; location: null; query?: string | null}) => (
		{
			mainPaneId: MAIN,
			panes: [pane],
		});
		expect(
			{
				otherQuery: sameWorkspace(
					ws(
						{
							...a,
							query: "x",
						},
					),
					ws(
						{
							...a,
							query: "y",
						},
					),
				),
				addedQuery: sameWorkspace(
					ws(a),
					ws(
						{
							...a,
							query: "x",
						},
					),
				),
				emptyQuery: sameWorkspace(
					ws(
						{
							...a,
							query: null,
						},
					),
					ws(
						{
							...a,
							query: "",
						},
					),
				),
			},
		).toStrictEqual(
			{
				otherQuery: false,
				addedQuery: false,
				emptyQuery: true,
			},
		);
	});
});

describe("storeWorkspaceUrl", () =>
{
	it("names every open pane in order with its committed search query", () =>
	{
		expect(
			storeWorkspaceUrl(
				[
					{
						id: SIDE,
						zoomedId: "alice",
						query: "todo",
					},
					{
						id: THIRD,
						zoomedId: null,
						query: "",
					},
				],
				MAIN,
			),
		).toStrictEqual(
			{
				mainPaneId: MAIN,
				panes: [
					{
						paneId: SIDE,
						location: "alice",
						query: "todo",
					},
					{
						paneId: THIRD,
						location: null,
						query: null,
					},
				],
			},
		);
	});

	it("is null with no pane open", () =>
	{
		expect(storeWorkspaceUrl([], null)).toBeNull();
	});
});

describe("reconcilePaneUrl", () =>
{
	const ws: WorkspaceUrl =
	{
		mainPaneId: MAIN,
		panes: [
			{
				paneId: SIDE,
				location: "35035d443bf1",
			},
		],
	};

	it.each<[string, WorkspaceUrl | null, WorkspaceUrl | null, boolean, PaneUrlAction]>([
		["nothing anywhere", null, null, false, "none"],
		["URL and store agree", ws, ws, false, "none"],
		["the URL names panes the store lacks (reload)", ws, null, true, "apply"],
		[
			"the URL names another zoom (Back)",
			{
				mainPaneId: MAIN,
				panes: [
					{
						paneId: SIDE,
						location: null,
					},
				],
			},
			ws,
			true,
			"apply",
		],
		[
			"the URL names one more pane (Forward)",
			{
				mainPaneId: MAIN,
				panes: [
					...ws.panes,
					{
						paneId: THIRD,
						location: null,
					},
				],
			},
			ws,
			true,
			"apply",
		],
		["Back reaches an entry without panes", null, ws, true, "close"],
		["an in-app link drops the param while panes are open", null, ws, false, "restore-url"],
	])("%s", (_label, url, store, isPop, expected) =>
	{
		expect(
			reconcilePaneUrl(
				{
					url,
					store,
					isPop,
				},
			),
		).toBe(expected);
	});
});

describe("createPaneId", () =>
{
	it("makes an 11-character base64url id from 8 random bytes", () =>
	{
		const bytes = new Uint8Array([0xfb, 0xff, 0xbf, 0x00, 0x01, 0x02, 0x03, 0x04]);
		expect(createPaneId(() => bytes)).toBe(Buffer.from(bytes).toString("base64url"));
	});

	it("makes a well-formed id from crypto by default", () =>
	{
		expect(createPaneId()).toMatch(/^[A-Za-z0-9_-]{11}$/u);
	});
});

describe("paneStorageUpdate", () =>
{
	it("writes the active pane and a width key per pane, like pane-workspace-runtime:v2", () =>
	{
		expect(
			paneStorageUpdate(
				{
					previousIds: [],
					ids: [MAIN, SIDE, THIRD],
					activePaneId: SIDE,
					widths: [716, 716, 472],
				},
			),
		).toStrictEqual(
			{
				set:
				{
					"pane-workspace-runtime:v2": JSON.stringify(
						{
							activePaneId: SIDE,
						},
					),
					[`pane-width:${MAIN}`]: JSON.stringify(
						{
							type: "item-tree",
							width: 716,
						},
					),
					[`pane-width:${SIDE}`]: JSON.stringify(
						{
							type: "item-tree",
							width: 716,
						},
					),
					[`pane-width:${THIRD}`]: JSON.stringify(
						{
							type: "item-tree",
							width: 472,
						},
					),
				},
				remove: [],
			},
		);
	});

	it("removes the width key of a pane that closed", () =>
	{
		expect(
			paneStorageUpdate(
				{
					previousIds: [MAIN, SIDE, THIRD],
					ids: [MAIN, SIDE],
					activePaneId: MAIN,
					widths: [800, 616],
				},
			),
		).toStrictEqual(
			{
				set:
				{
					"pane-workspace-runtime:v2": JSON.stringify(
						{
							activePaneId: MAIN,
						},
					),
					[`pane-width:${MAIN}`]: JSON.stringify(
						{
							type: "item-tree",
							width: 800,
						},
					),
					[`pane-width:${SIDE}`]: JSON.stringify(
						{
							type: "item-tree",
							width: 616,
						},
					),
				},
				remove: [`pane-width:${THIRD}`],
			},
		);
	});

	it("writes no width key for an unusable width", () =>
	{
		expect(
			paneStorageUpdate(
				{
					previousIds: [],
					ids: [MAIN, SIDE],
					activePaneId: MAIN,
					widths: [Number.NaN, 0],
				},
			),
		).toStrictEqual(
			{
				set:
				{
					"pane-workspace-runtime:v2": JSON.stringify(
						{
							activePaneId: MAIN,
						},
					),
				},
				remove: [`pane-width:${MAIN}`, `pane-width:${SIDE}`],
			},
		);
	});

	it("removes every key once no pane is left", () =>
	{
		expect(
			paneStorageUpdate(
				{
					previousIds: [MAIN, SIDE],
					ids: [],
					activePaneId: MAIN,
					widths: [],
				},
			),
		).toStrictEqual(
			{
				set: {},
				remove: ["pane-workspace-runtime:v2", `pane-width:${MAIN}`, `pane-width:${SIDE}`],
			},
		);
	});
});

describe("applyPaneStorageUpdate", () =>
{
	function fakeStorage()
	{
		const entries = new Map<string, string>();
		return {
			entries,
			setItem: (key: string, value: string) =>
			{
				entries.set(key, value);
			},
			removeItem: (key: string) =>
			{
				entries.delete(key);
			},
		};
	}

	it("leaves a runtime key and a width key per pane while panes are open, and no pane key once they close", () =>
	{
		const storage = fakeStorage();
		const ids = [MAIN, SIDE, THIRD];
		applyPaneStorageUpdate(
			storage,
			paneStorageUpdate(
				{
					previousIds: [],
					ids,
					activePaneId: MAIN,
					widths: [716, 716, 472],
				},
			),
		);
		const open = Object.fromEntries(storage.entries);
		applyPaneStorageUpdate(
			storage,
			paneStorageUpdate(
				{
					previousIds: ids,
					ids: [],
					activePaneId: MAIN,
					widths: [],
				},
			),
		);
		expect(
			{
				open,
				closed: Object.fromEntries(storage.entries),
			},
		).toStrictEqual(
			{
				open:
				{
					"pane-workspace-runtime:v2": JSON.stringify(
						{
							activePaneId: MAIN,
						},
					),
					[`pane-width:${MAIN}`]: JSON.stringify(
						{
							type: "item-tree",
							width: 716,
						},
					),
					[`pane-width:${SIDE}`]: JSON.stringify(
						{
							type: "item-tree",
							width: 716,
						},
					),
					[`pane-width:${THIRD}`]: JSON.stringify(
						{
							type: "item-tree",
							width: 472,
						},
					),
				},
				closed: {},
			},
		);
	});
});

describe("restoredRuntime / restoredPaneWidth", () =>
{
	it("restores the stored active pane only when it is one of the URL's panes", () =>
	{
		const stored = JSON.stringify(
			{
				activePaneId: THIRD,
			},
		);
		expect(
			{
				match: restoredRuntime(stored, [MAIN, SIDE, THIRD]),
				notInUrl: restoredRuntime(stored, [MAIN, SIDE]),
				missing: restoredRuntime(null, [MAIN]),
				garbage: restoredRuntime("{", [MAIN]),
				legacy: restoredRuntime(
					JSON.stringify(
						{
							panes: [],
						},
					),
					[MAIN],
				),
			},
		).toStrictEqual(
			{
				match:
				{
					activePaneId: THIRD,
				},
				notInUrl: null,
				missing: null,
				garbage: null,
				legacy: null,
			},
		);
	});

	it("restores a pane's width only for an item-tree record with a positive width", () =>
	{
		expect([
			restoredPaneWidth(
				JSON.stringify(
					{
						type: "item-tree",
						width: 716.5,
					},
				),
			),
			restoredPaneWidth(
				JSON.stringify(
					{
						type: "inbox",
						width: 716,
					},
				),
			),
			restoredPaneWidth(
				JSON.stringify(
					{
						type: "item-tree",
						width: 0,
					},
				),
			),
			restoredPaneWidth(
				JSON.stringify(
					{
						type: "item-tree",
						width: "wide",
					},
				),
			),
			restoredPaneWidth(null),
			restoredPaneWidth("{"),
		]).toStrictEqual([716.5, null, null, null, null, null]);
	});
});

describe("withPanesFragment", () =>
{
	it("sets the panes param after the main location and its query", () =>
	{
		expect(withPanesFragment("#/4823cefa-5fc0-478c-88ac-35035d443bf1?q=x", "v2.abc")).toBe(
			"/#/35035d443bf1?q=x&panes=v2.abc",
		);
	});

	it("sets it at Home", () =>
	{
		expect(withPanesFragment("", "v2.abc")).toBe("/#?panes=v2.abc");
	});

	it("drops the param, keeping other fragments", () =>
	{
		expect(withPanesFragment("#/35035d443bf1?view=board&panes=v2.abc", null)).toBe("/#/35035d443bf1?view=board");
	});

	it("drops it back to plain Home", () =>
	{
		expect(withPanesFragment("#?panes=v2.abc", null)).toBe("/");
	});
});
