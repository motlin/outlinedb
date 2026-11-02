import {describe, expect, it} from "vite-plus/test";
import {parseStrictInteger, parseStrictNumber} from "../../src/utils/parse-strict-number.js";

describe("parseStrictNumber", () =>
{
	it("parses clean integers and decimals", () =>
	{
		expect([parseStrictNumber("1700000000"), parseStrictNumber("0.55"), parseStrictNumber(" 42 ")]).toStrictEqual([
			1_700_000_000, 0.55, 42,
		]);
	});

	it("rejects blank and partially numeric input", () =>
	{
		expect([
			parseStrictNumber(""),
			parseStrictNumber("   "),
			parseStrictNumber("12px"),
			parseStrictNumber("abc"),
			parseStrictNumber("Infinity"),
		]).toStrictEqual([undefined, undefined, undefined, undefined, undefined]);
	});
});

describe("parseStrictInteger", () =>
{
	it("accepts integers and rejects fractions, blanks, and partial numbers", () =>
	{
		expect([
			parseStrictInteger("1700000000"),
			parseStrictInteger("0"),
			parseStrictInteger("1.5"),
			parseStrictInteger(""),
			parseStrictInteger("12px"),
		]).toStrictEqual([1_700_000_000, 0, undefined, undefined, undefined]);
	});
});
