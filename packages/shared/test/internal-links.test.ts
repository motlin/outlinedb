import {describe, expect, it} from "vite-plus/test";
import {hasInternalLink, internalLinkShortIds} from "../src/workflowy/internal-links.js";

describe("internalLinkShortIds", () =>
{
	it("reads a short id from a workflowy.com link", () =>
	{
		expect(internalLinkShortIds('<a href="https://workflowy.com/#/81df3e9581ea">a</a>')).toStrictEqual([
			"81df3e9581ea",
		]);
	});

	it("rejects a link whose hash carries a search", () =>
	{
		expect(internalLinkShortIds('<a href="https://workflowy.com/#/81df3e9581ea?q=x">a</a>')).toStrictEqual([]);
	});

	it("accepts any host", () =>
	{
		expect(internalLinkShortIds('<a href="https://example.com/#/81df3e9581ea">a</a>')).toStrictEqual([
			"81df3e9581ea",
		]);
	});

	it("rejects a relative href", () =>
	{
		expect(internalLinkShortIds('<a href="/#/81df3e9581ea">a</a>')).toStrictEqual([]);
	});

	it("deduplicates links to the same id", () =>
	{
		expect(
			internalLinkShortIds(
				'<a href="https://workflowy.com/#/81df3e9581ea">a</a> <a href="https://workflowy.com/#/81df3e9581ea">b</a>',
			),
		).toStrictEqual(["81df3e9581ea"]);
	});

	it("reduces a full uuid hash to its last 12 hex", () =>
	{
		expect(
			internalLinkShortIds('<a href="https://workflowy.com/#/11111111-2222-3333-4444-81df3e9581ea">a</a>'),
		).toStrictEqual(["81df3e9581ea"]);
	});

	it("hasInternalLink follows the same rule", () =>
	{
		expect(hasInternalLink('<a href="https://workflowy.com/#/81df3e9581ea?q=x">a</a>')).toBe(false);
	});
});
