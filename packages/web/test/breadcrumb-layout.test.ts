import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import
{
	createBreadcrumbLayout,
	crumbInputsFromKey,
	crumbInputsKey,
	measureCrumbLabel,
	paneCrumbOptions,
} from "../src/client/breadcrumb-layout.js";
import type {CrumbInput} from "../src/client/breadcrumb-layout.js";

const measure = (label: string): number => label.length * 7;
const long = (ch: string): string => ch.repeat(40);

function crumbs(labels: string[]): CrumbInput[]
{
	return labels.map((label, i) => (
	{
		id: `n${i}`,
		label,
	}));
}

function summarize(items: ReturnType<ReturnType<typeof createBreadcrumbLayout>["calculateVisibleItems"]>)
{
	return items.map(({id, group, isZoomed, truncateWidth}) => (
	{
		id,
		group,
		isZoomed,
		truncateWidth,
	}));
}

describe("calculateVisibleItems", () =>
{
	const layout = createBreadcrumbLayout({}, measure);

	it("keeps short trails whole with a first-half / second-half split", () =>
	{
		expect(layout.calculateVisibleItems(crumbs(["Home", "Ab", "Cd"]), 1000, [])).toStrictEqual([
			{
				id: "n0",
				label: "Home",
				group: 0,
				isZoomed: false,
				truncateWidth: null,
			},
			{
				id: "n1",
				label: "Ab",
				group: 0,
				isZoomed: false,
				truncateWidth: null,
			},
			{
				id: "n2",
				label: "Cd",
				group: 2,
				isZoomed: false,
				truncateWidth: null,
			},
		]);
	});

	it("shaves the widest items one pixel at a time until the trail fits", () =>
	{
		const items = crumbs(["Home", "Sandbox", long("a"), long("b"), long("c"), long("d")]);
		expect(summarize(layout.calculateVisibleItems(items, 675, []))).toStrictEqual([
			{
				id: "n0",
				group: 0,
				isZoomed: false,
				truncateWidth: null,
			},
			{
				id: "n1",
				group: 0,
				isZoomed: false,
				truncateWidth: null,
			},
			{
				id: "n2",
				group: 0,
				isZoomed: false,
				truncateWidth: 107,
			},
			{
				id: "n3",
				group: 2,
				isZoomed: false,
				truncateWidth: 107,
			},
			{
				id: "n4",
				group: 2,
				isZoomed: false,
				truncateWidth: 107,
			},
			{
				id: "n5",
				group: 2,
				isZoomed: false,
				truncateWidth: 108,
			},
		]);
	});

	it("collapses middle-outward once truncation alone cannot fit", () =>
	{
		const items = crumbs(["Home", "Sandbox", long("a"), long("b"), long("c"), long("d")]);
		expect(summarize(layout.calculateVisibleItems(items, 500, []))).toStrictEqual([
			{
				id: "n0",
				group: 0,
				isZoomed: false,
				truncateWidth: null,
			},
			{
				id: "n1",
				group: 0,
				isZoomed: false,
				truncateWidth: null,
			},
			{
				id: "n2",
				group: 1,
				isZoomed: false,
				truncateWidth: null,
			},
			{
				id: "n3",
				group: 1,
				isZoomed: false,
				truncateWidth: null,
			},
			{
				id: "n4",
				group: 2,
				isZoomed: false,
				truncateWidth: 138,
			},
			{
				id: "n5",
				group: 2,
				isZoomed: false,
				truncateWidth: 139,
			},
		]);
	});

	it("never collapses Home or the current item, truncating them to 48 instead", () =>
	{
		const items = crumbs(["Home", ...["a", "b", "c", "d", "e", "f", "g"].map(long)]);
		expect(summarize(layout.calculateVisibleItems(items, 100, []))).toStrictEqual([
			{
				id: "n0",
				group: 0,
				isZoomed: false,
				truncateWidth: null,
			},
			{
				id: "n1",
				group: 1,
				isZoomed: false,
				truncateWidth: null,
			},
			{
				id: "n2",
				group: 1,
				isZoomed: false,
				truncateWidth: null,
			},
			{
				id: "n3",
				group: 1,
				isZoomed: false,
				truncateWidth: null,
			},
			{
				id: "n4",
				group: 1,
				isZoomed: false,
				truncateWidth: null,
			},
			{
				id: "n5",
				group: 1,
				isZoomed: false,
				truncateWidth: null,
			},
			{
				id: "n6",
				group: 1,
				isZoomed: false,
				truncateWidth: null,
			},
			{
				id: "n7",
				group: 2,
				isZoomed: false,
				truncateWidth: 48,
			},
		]);
	});

	it("collapses a non-zoomed sibling before a zoomed item", () =>
	{
		const items = crumbs(["Home", long("a"), long("b"), long("c"), long("d")]);
		expect(
			{
				plain: summarize(layout.calculateVisibleItems(items, 524, [])),
				zoomed: summarize(layout.calculateVisibleItems(items, 524, ["n2"])),
			},
		).toStrictEqual(
			{
				plain: [
					{
						id: "n0",
						group: 0,
						isZoomed: false,
						truncateWidth: null,
					},
					{
						id: "n1",
						group: 0,
						isZoomed: false,
						truncateWidth: 116,
					},
					{
						id: "n2",
						group: 1,
						isZoomed: false,
						truncateWidth: null,
					},
					{
						id: "n3",
						group: 2,
						isZoomed: false,
						truncateWidth: 117,
					},
					{
						id: "n4",
						group: 2,
						isZoomed: false,
						truncateWidth: 117,
					},
				],
				zoomed: [
					{
						id: "n0",
						group: 0,
						isZoomed: false,
						truncateWidth: null,
					},
					{
						id: "n1",
						group: 0,
						isZoomed: false,
						truncateWidth: 116,
					},
					{
						id: "n2",
						group: 0,
						isZoomed: true,
						truncateWidth: 117,
					},
					{
						id: "n3",
						group: 1,
						isZoomed: false,
						truncateWidth: null,
					},
					{
						id: "n4",
						group: 2,
						isZoomed: false,
						truncateWidth: 117,
					},
				],
			},
		);
	});
});

describe("item groups", () =>
{
	const layout = createBreadcrumbLayout({}, measure);

	it("chunks consecutive collapsed items and accumulates left offsets", () =>
	{
		const items = crumbs(["Home", "Sandbox", long("a"), long("b"), long("c"), long("d")]);
		const visible = layout.calculateVisibleItems(items, 500, []);
		const groups = layout.getItemGroups(visible);
		expect(
			{
				chunks: groups.map((chunk) => chunk.map((item) => item.id)),
				offsets: layout.getItemGroupsWithLeftOffset(groups).map(({leftOffset, items: chunk}) => (
				{
					leftOffset,
					ids: chunk.map((item) => item.id),
				})),
			},
		).toStrictEqual(
			{
				chunks: [
					["n0", "n1"],
					["n2", "n3"],
					["n4", "n5"],
				],
				// Upstream quirk kept: an all-collapsed chunk measures as -itemGap.
				offsets: [
					{
						leftOffset: 0,
						ids: ["n0", "n1"],
					},
					{
						leftOffset: 106,
						ids: ["n2", "n3"],
					},
					{
						leftOffset: 77,
						ids: ["n4", "n5"],
					},
				],
			},
		);
	});
});

describe("measureCrumbLabel", () =>
{
	afterEach(() =>
	{
		vi.unstubAllGlobals();
	});

	it("measures with the body font at 14.22px and caches by label", () =>
	{
		const fonts: string[] = [];
		const context =
		{
			font: "",
			measureText: vi.fn<
				(text: string) =>
				{
					width: number;
				}
			>((text) =>
			{
				fonts.push(context.font);
				return {
					width: text.length * 8,
				};
			}),
		};
		vi.stubGlobal(
			"document",
			{
				body: {},
				createElement: () => (
				{
					getContext: () => context,
				}),
			},
		);
		vi.stubGlobal("getComputedStyle", () => (
		{
			fontFamily: "Test Sans",
		}));
		const label = `measure-${Math.random()}`;
		expect(
			{
				first: measureCrumbLabel(label),
				second: measureCrumbLabel(label),
				calls: context.measureText.mock.calls.length,
				fonts,
			},
		).toStrictEqual(
			{
				first: label.length * 8,
				second: label.length * 8,
				calls: 1,
				fonts: ["14.22px Test Sans"],
			},
		);
	});
});

describe("crumbInputsKey", () =>
{
	it("round-trips a trail whose labels hold slashes and spaces", () =>
	{
		const items = crumbs(["Home", "a/b", "", "x y"]);
		expect(crumbInputsFromKey(crumbInputsKey(items))).toStrictEqual(items);
	});

	it("round-trips an empty trail", () =>
	{
		expect(crumbInputsFromKey(crumbInputsKey([]))).toStrictEqual([]);
	});

	it("gives equal trails equal keys and different trails different keys", () =>
	{
		expect(crumbInputsKey(crumbs(["Home", "a"]))).toBe(crumbInputsKey(crumbs(["Home", "a"])));
		expect(crumbInputsKey(crumbs(["Home", "a"]))).not.toBe(crumbInputsKey(crumbs(["Home", "b"])));
	});
});

describe("paneCrumbOptions", () =>
{
	it("uses regular sizes from 500px and compact sizes below", () =>
	{
		expect([paneCrumbOptions(500), paneCrumbOptions(450), paneCrumbOptions(300)]).toStrictEqual([
			{
				sizes:
				{
					rightMargin: 8,
					itemGap: 18,
					ellipsisWidth: 28,
				},
				maxWidth: 140,
				threeDotPosition: "left",
			},
			{
				sizes:
				{
					rightMargin: 4,
					itemGap: 14,
					ellipsisWidth: 28,
				},
				maxWidth: 190,
				threeDotPosition: "left",
			},
			{
				sizes:
				{
					rightMargin: 4,
					itemGap: 14,
					ellipsisWidth: 28,
				},
				maxWidth: 120,
				threeDotPosition: "left",
			},
		]);
	});
});
