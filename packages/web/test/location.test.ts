import {describe, expect, it} from "vite-plus/test";
import {locationUrl, parseLocationHash, shortId} from "../src/client/location.js";

const UUID = "4823cefa-5fc0-478c-88ac-35035d443bf1";

describe("shortId", () =>
{
	it("keeps the last 12 characters of a uuid", () =>
	{
		expect(shortId(UUID)).toBe("35035d443bf1");
	});

	it("returns an already-short id unchanged", () =>
	{
		expect(shortId("35035d443bf1")).toBe("35035d443bf1");
	});
});

describe("locationUrl", () =>
{
	it("maps home to /", () =>
	{
		expect(
			locationUrl(
				{
					id: null,
				},
			),
		).toBe("/");
	});

	it("maps an item to its short-id hash", () =>
	{
		expect(
			locationUrl(
				{
					id: UUID,
				},
			),
		).toBe("/#/35035d443bf1");
	});

	it("appends an encoded search query to an item", () =>
	{
		expect(
			locationUrl(
				{
					id: UUID,
					query: "a b&c",
				},
			),
		).toBe("/#/35035d443bf1?q=a%20b%26c");
	});

	it("appends a search query at home", () =>
	{
		expect(
			locationUrl(
				{
					id: null,
					query: "x",
				},
			),
		).toBe("/#?q=x");
	});

	it("appends extra fragments after the query joined by &", () =>
	{
		expect(
			locationUrl(
				{
					id: UUID,
					query: "x",
					fragments:
					{
						view: "board",
					},
				},
			),
		).toBe("/#/35035d443bf1?q=x&view=board");
	});
});

describe("parseLocationHash", () =>
{
	it("parses an item with a query", () =>
	{
		expect(parseLocationHash("#/35035d443bf1?q=A2")).toStrictEqual(
			{
				id: "35035d443bf1",
				query: "A2",
				fragments: {},
			},
		);
	});

	it("treats an empty hash as home", () =>
	{
		expect(parseLocationHash("")).toStrictEqual(
			{
				id: null,
				query: null,
				fragments: {},
			},
		);
	});

	it("treats #/ as home", () =>
	{
		expect(parseLocationHash("#/")).toStrictEqual(
			{
				id: null,
				query: null,
				fragments: {},
			},
		);
	});

	it("drops an empty query and keeps other params as fragments", () =>
	{
		expect(parseLocationHash("#/abc?q=&x=1")).toStrictEqual(
			{
				id: "abc",
				query: null,
				fragments:
				{
					x: "1",
				},
			},
		);
	});

	it("decodes an encoded query at home", () =>
	{
		expect(parseLocationHash("#?q=a%20b%26c")).toStrictEqual(
			{
				id: null,
				query: "a b&c",
				fragments: {},
			},
		);
	});
});

describe("upstream URL edge cases", () =>
{
	it("reads + in a query as a space, as URLSearchParams does", () =>
	{
		expect(parseLocationHash("#/abc?q=a+b")).toStrictEqual(
			{
				id: "abc",
				query: "a b",
				fragments: {},
			},
		);
	});

	it("keeps only the text between the first and second ?", () =>
	{
		expect(parseLocationHash("#/abc?q=x?y=1")).toStrictEqual(
			{
				id: "abc",
				query: "x",
				fragments: {},
			},
		);
	});

	it("writes a fragment with an empty value as the bare key", () =>
	{
		expect(
			locationUrl(
				{
					id: null,
					fragments:
					{
						flag: "",
					},
				},
			),
		).toBe("/#?flag");
	});
});
