import {describe, expect, it} from "vite-plus/test";
import {stripHtmlTags} from "../src/html/index.js";

describe("stripHtmlTags", () =>
{
	it("keeps unknown tag-like text", () =>
	{
		expect(stripHtmlTags("line two & <three>")).toBe("line two & <three>");
	});

	it("keeps escaped tag-like text", () =>
	{
		expect(stripHtmlTags("line two &amp; &lt;three&gt;")).toBe("line two & <three>");
	});

	it("still strips real markup", () =>
	{
		expect(stripHtmlTags('<b>bold</b> <a href="x">link</a> <time startYear="2026">d</time><br>')).toBe(
			"bold link d",
		);
	});
});
