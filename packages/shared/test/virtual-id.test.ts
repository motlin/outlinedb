import {describe, expect, it} from "vite-plus/test";
import
{
	parseVirtualId,
	parseVirtualShortId,
	upstreamExpansionKey,
	virtualId,
	virtualShortId,
} from "../src/workflowy/virtual-id.js";

const CHILD = "7b1c2d3e-aaaa-4bbb-8ccc-c910f3eac9b3";
const ROOT = "0e9f8d7c-1111-4222-8333-d4f14a54f384";

describe("virtual ids", () =>
{
	it("builds the long id, the URL form and the account's expansion key", () =>
	{
		const row =
		{
			childId: CHILD,
			mirrorRootId: ROOT,
			path: "",
		};
		const nested =
		{
			...row,
			path: "0e9f7b1c",
		};

		expect(
			{
				long: virtualId(row),
				short: virtualShortId(row),
				nestedShort: virtualShortId(nested),
				key: upstreamExpansionKey(virtualId(row)),
				nestedKey: upstreamExpansionKey(virtualId(nested)),
				plainKey: upstreamExpansionKey(CHILD),
			},
		).toStrictEqual(
			{
				long: `virtual_${CHILD}_${ROOT}`,
				short: "v_c910f3eac9b3_d4f14a54f384",
				nestedShort: "v_c910f3eac9b3_d4f14a54f384_0e9f7b1c",
				key: "v_7b1c0e9f",
				nestedKey: "v_7b1c0e9f0e9f7b1c",
				plainKey: "7b1c2d3e",
			},
		);
	});

	it("parses the URL form and the long id back, and rejects anything else", () =>
	{
		expect(
			{
				short: parseVirtualShortId("v_c910f3eac9b3_d4f14a54f384_0e9f7b1c"),
				plainShort: parseVirtualShortId("c910f3eac9b3"),
				long: parseVirtualId(
					virtualId(
						{
							childId: CHILD,
							mirrorRootId: ROOT,
							path: "0e9f",
						},
					),
				),
				plainLong: parseVirtualId(CHILD),
			},
		).toStrictEqual(
			{
				short:
				{
					nodeShortId: "c910f3eac9b3",
					mirrorShortId: "d4f14a54f384",
					path: "0e9f7b1c",
				},
				plainShort: null,
				long:
				{
					childId: CHILD,
					mirrorRootId: ROOT,
					path: "0e9f",
				},
				plainLong: null,
			},
		);
	});
});
