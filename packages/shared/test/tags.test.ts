import {describe, expect, it} from "vite-plus/test";
import {findTags, getEndingTagText} from "../src/tags/index.js";

describe("findTags", () =>
{
	it("finds a tag with its index", () =>
	{
		expect(findTags("Alpha #taZebra item")).toStrictEqual([
			{
				index: 6,
				tag: "#taZebra",
			},
		]);
	});

	it("skips all-digit tags shorter than 4 characters", () =>
	{
		expect(findTags("Numbers #123 #1234 #12a").map((t) => t.tag)).toStrictEqual(["#1234", "#12a"]);
	});

	it("keeps case and treats colon-separated segments as one tag", () =>
	{
		expect(findTags("Delta #TaZebra upper, #ta:sub:key end").map((t) => t.tag)).toStrictEqual([
			"#TaZebra",
			"#ta:sub:key",
		]);
	});

	it("respects boundary characters", () =>
	{
		expect(findTags("Edge (#taParen) #taDot. foo#taNo &#taAmp").map((t) => t.tag)).toStrictEqual([
			"#taParen",
			"#taDot",
		]);
	});

	it("reports indexes after a boundary character", () =>
	{
		expect(findTags("(#taParen) @bob")).toStrictEqual([
			{
				index: 1,
				tag: "#taParen",
			},
			{
				index: 11,
				tag: "@bob",
			},
		]);
	});

	it("skips tags inside URLs", () =>
	{
		expect(findTags("see https://x.com/#frag ok")).toStrictEqual([]);
	});

	it("finds tags inside URLs when skipUrls is false", () =>
	{
		expect(
			findTags(
				"see https://x.com/#frag ok",
				{
					skipUrls: false,
				},
			),
		).toStrictEqual([
			{
				index: 18,
				tag: "#frag",
			},
		]);
	});
});

describe("getEndingTagText", () =>
{
	it("returns the tag being typed at the caret", () =>
	{
		expect(getEndingTagText("Type here #taA")).toBe("#taA");
	});

	it("returns a bare hash", () =>
	{
		expect(getEndingTagText("foo#")).toBe("#");
	});

	it("allows a trailing colon while typing", () =>
	{
		expect(getEndingTagText("a #ta:")).toBe("#ta:");
	});

	it("returns undefined after whitespace", () =>
	{
		expect(getEndingTagText("#taA ")).toBeUndefined();
	});

	it("returns undefined for mentions", () =>
	{
		expect(getEndingTagText("@bob")).toBeUndefined();
	});
});
