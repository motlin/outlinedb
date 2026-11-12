import {describe, expect, it} from "vite-plus/test";
import
{
	applyToggle,
	defaultOrder,
	label,
	locationKey,
	mostRecent,
	moveKey,
	parseLocationKey,
	shouldRecordView,
	starCurrentLocation,
	uniqueId,
} from "../src/index.js";
import type {Star} from "../src/index.js";

function star(nodeId: string | null, query: string | null, position: number, name: string | null = null): Star
{
	return {
		key: locationKey(
			{
				nodeId,
				query,
			},
		),
		nodeId,
		query,
		name,
		position,
	};
}

describe("locationKey", () =>
{
	it("joins nodeId and query with an underscore", () =>
	{
		expect(
			locationKey(
				{
					nodeId: "abc",
					query: "date:past ",
				},
			),
		).toBe("abc_date:past ");
	});

	it("uses None for Home and omits an empty query", () =>
	{
		expect([
			locationKey(
				{
					nodeId: null,
					query: null,
				},
			),
			locationKey(
				{
					nodeId: "abc",
					query: "",
				},
			),
		]).toStrictEqual(["None", "abc"]);
	});
});

describe("parseLocationKey", () =>
{
	it("splits at the first underscore so queries may contain underscores", () =>
	{
		expect(parseLocationKey("abc_a_b")).toStrictEqual(
			{
				nodeId: "abc",
				query: "a_b",
			},
		);
	});

	it("maps None to a Home location with no query", () =>
	{
		expect(parseLocationKey("None")).toStrictEqual(
			{
				nodeId: null,
				query: null,
			},
		);
	});

	it("maps an empty query to null", () =>
	{
		expect(parseLocationKey("abc_")).toStrictEqual(
			{
				nodeId: "abc",
				query: null,
			},
		);
	});
});

describe("uniqueId", () =>
{
	it("formats Home and search locations", () =>
	{
		expect([
			uniqueId(
				{
					nodeId: null,
					query: null,
				},
			),
			uniqueId(
				{
					nodeId: "abc",
					query: "x",
				},
			),
		]).toStrictEqual(["None/None/", "None/abc/x"]);
	});
});

describe("applyToggle", () =>
{
	it("adds then removes a star", () =>
	{
		const loc =
		{
			nodeId: "p1",
			query: null,
		};
		const first = applyToggle([], loc);
		const second = applyToggle(first.stars, loc);
		expect(
			{
				values: [first.value, second.value],
				afterAdd: first.stars,
				final: second.stars,
			},
		).toStrictEqual(
			{
				values: [true, false],
				afterAdd: [
					{
						key: "p1",
						nodeId: "p1",
						query: null,
						name: null,
						position: 0,
					},
				],
				final: [],
			},
		);
	});

	it("appends with position max + 1", () =>
	{
		const existing = [star("a", null, 3), star("b", null, 7)];
		expect(
			applyToggle(
				existing,
				{
					nodeId: "c",
					query: "q",
				},
			),
		).toStrictEqual(
			{
				stars: [
					...existing,
					{
						key: "c_q",
						nodeId: "c",
						query: "q",
						name: null,
						position: 8,
					},
				],
				value: true,
			},
		);
	});

	it("honors force", () =>
	{
		const existing = [star("a", null, 0)];
		expect([
			applyToggle(
				existing,
				{
					nodeId: "a",
					query: null,
				},
				true,
			),
			applyToggle(
				[],
				{
					nodeId: "a",
					query: null,
				},
				false,
			),
		]).toStrictEqual([
			{
				stars: existing,
				value: true,
			},
			{
				stars: [],
				value: false,
			},
		]);
	});
});

describe("defaultOrder", () =>
{
	it("orders searches by query, then pages by name", () =>
	{
		const names: Record<string, string> =
		{
			p2: "Bravo",
		};
		const stars = [star("p2", null, 0), star("p1", "zeta", 1), star("p1", "alpha", 2)];
		expect(defaultOrder(stars, (id) => names[id ?? ""] ?? "").map((s) => s.key)).toStrictEqual([
			"p1_alpha",
			"p1_zeta",
			"p2",
		]);
	});
});

describe("moveKey", () =>
{
	it("moves the source after the target", () =>
	{
		expect(moveKey(["a", "b", "c"], "a", "c", true)).toStrictEqual(["b", "c", "a"]);
	});

	it("moves the source before the target", () =>
	{
		expect(moveKey(["a", "b", "c"], "c", "a", false)).toStrictEqual(["c", "a", "b"]);
	});

	it("returns the input unchanged for unknown keys", () =>
	{
		const keys = ["a", "b"];
		expect([moveKey(keys, "x", "a", true), moveKey(keys, "a", "x", true)]).toStrictEqual([keys, keys]);
	});
});

describe("mostRecent", () =>
{
	const a = star("a", null, 0);
	const b = star("b", null, 1);
	const c = star("c", null, 2);

	it("sorts by last viewed desc", () =>
	{
		expect(
			mostRecent(
				[c, b, a],
				{
					"None/b/": 5,
					"None/a/": 9,
				},
			),
		).toStrictEqual([a, b, c]);
	});

	it("breaks ties and never-viewed by uniqueId asc", () =>
	{
		expect(
			mostRecent(
				[b, a, c],
				{
					"None/c/": 1,
				},
			),
		).toStrictEqual([c, a, b]);
	});
});

describe("label", () =>
{
	const nameText = (id: string | null) => `name:${id}`;

	it("prefers name, then query, then nameText, with Home for the root", () =>
	{
		expect([
			label(star("a", "q", 0, "Custom"), nameText),
			label(star("a", "q", 0), nameText),
			label(star("a", null, 0), nameText),
			label(star(null, null, 0), nameText),
		]).toStrictEqual(["Custom", "q", "name:a", "Home"]);
	});
});

describe("starCurrentLocation", () =>
{
	it("stars the page plus the committed query, Home included, with an empty query as none", () =>
	{
		expect([
			starCurrentLocation(
				{
					zoomedId: null,
					query: null,
				},
			),
			starCurrentLocation(
				{
					zoomedId: "a",
					query: "#x",
				},
			),
			starCurrentLocation(
				{
					zoomedId: "a",
					query: "",
				},
			),
		]).toStrictEqual([
			{
				nodeId: null,
				query: null,
			},
			{
				nodeId: "a",
				query: "#x",
			},
			{
				nodeId: "a",
				query: null,
			},
		]);
	});
});

describe("shouldRecordView", () =>
{
	it("records only when the location changed", () =>
	{
		const a =
		{
			nodeId: "a",
			query: null,
		};
		expect([
			shouldRecordView(null, a),
			shouldRecordView(
				a,
				{
					nodeId: "a",
					query: null,
				},
			),
			shouldRecordView(
				a,
				{
					nodeId: "a",
					query: "q",
				},
			),
		]).toStrictEqual([true, false, true]);
	});
});
