// @vitest-environment happy-dom
import {describe, expect, it, vi} from "vite-plus/test";

vi.mock("../src/client/hooks/use-nodes.js", () => (
{
	fetchNode: async () =>
		Promise.resolve(
			{
				name: '<time startYear="2026" startMonth="10" startDay="23">Fri, Oct 23, 2026</time>',
			},
		),
	fetchChildren: async () =>
		Promise.resolve([
			{
				id: "c",
			},
		]),
	fetchAncestors: async () =>
		Promise.resolve([
			{
				id: "day",
				parent_id: "month",
			},
		]),
}));

const {loadMoveTarget} = await import("../src/client/hooks/use-move-to.js");

describe("loadMoveTarget", () =>
{
	it("names the target in plain text, as upstream's nameInPlainText", async () =>
	{
		const loaded = await loadMoveTarget("day");
		expect(
			{
				target: loaded.target,
				childCount: loaded.childCount,
				parent: loaded.parentOf("day"),
			},
		).toStrictEqual(
			{
				target:
				{
					id: "day",
					name: "Fri, Oct 23, 2026",
					defaultToBottom: false,
				},
				childCount: 1,
				parent: "month",
			},
		);
	});
});
