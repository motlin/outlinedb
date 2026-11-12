import {describe, expect, it} from "vite-plus/test";
import {childInstance, instanceKey, isCyclical} from "../src/mirror-path.js";

const M = "aaaa0000-0000-0000-0000-000000000000";
const K = "bbbb0000-0000-0000-0000-000000000000";
const mirrorM =
{
	id: M,
	isMirror: true,
};
const plainK =
{
	id: K,
};

describe("childInstance", () =>
{
	it("starts an instance at a mirror met outside any mirror", () =>
	{
		expect(childInstance(mirrorM, null)).toStrictEqual(
			{
				rootId: M,
				path: "aaaa",
			},
		);
	});

	it("leaves a plain row outside any mirror outside", () =>
	{
		expect(childInstance(plainK, null)).toBeNull();
	});

	it("grows the path by the first four characters of each row's id", () =>
	{
		const paths: string[] = [];
		let instance = childInstance(mirrorM, null);
		for (const node of [plainK, mirrorM, plainK, mirrorM, plainK])
		{
			instance = childInstance(node, instance);
			paths.push(instance?.path ?? "");
		}
		expect(paths).toStrictEqual([
			"aaaabbbb",
			"aaaabbbbaaaa",
			"aaaabbbbaaaabbbb",
			"aaaabbbbaaaabbbbaaaa",
			"aaaabbbbaaaabbbbaaaabbbb",
		]);
	});
});

describe("isCyclical", () =>
{
	it("is false while a mirror's chunk has repeated fewer than three times", () =>
	{
		expect(
			isCyclical(
				mirrorM,
				{
					rootId: M,
					path: "aaaabbbbaaaabbbb",
				},
			),
		).toBe(false);
	});

	it("is true once a chunk repeats three times", () =>
	{
		expect(
			isCyclical(
				mirrorM,
				{
					rootId: M,
					path: "aaaabbbbaaaabbbbaaaabbbb",
				},
			),
		).toBe(true);
	});

	it("is true for a mirror identified by originalNodeId", () =>
	{
		expect(
			isCyclical(
				{
					originalNodeId: K,
				},
				{
					rootId: M,
					path: "aaaabbbbaaaabbbbaaaabbbb",
				},
			),
		).toBe(true);
	});

	it("is false for a plain row at the same path", () =>
	{
		expect(
			isCyclical(
				plainK,
				{
					rootId: M,
					path: "aaaabbbbaaaabbbbaaaabbbb",
				},
			),
		).toBe(false);
	});

	it("is false outside any mirror", () =>
	{
		expect(isCyclical(mirrorM, null)).toBe(false);
	});
});

describe("instanceKey", () =>
{
	it("is the parent id outside a mirror and distinguishes instances inside one", () =>
	{
		expect([
			instanceKey("p", null),
			instanceKey(
				"p",
				{
					rootId: M,
					path: "aaaa",
				},
			),
			instanceKey(
				"p",
				{
					rootId: M,
					path: "aaaabbbb",
				},
			),
			instanceKey(null, null),
		]).toStrictEqual(["p", `p@${M}_aaaa`, `p@${M}_aaaabbbb`, null]);
	});
});
