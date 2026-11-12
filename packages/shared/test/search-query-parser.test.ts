import {expect, describe, it} from "vite-plus/test";
import {parseSearchQuery} from "../src/search/query-parser.js";

describe("parseSearchQuery", () =>
{
	it("treats bare terms as required (AND)", () =>
	{
		const parsed = parseSearchQuery("meeting notes");
		expect(parsed.requiredTerms).toStrictEqual(["meeting", "notes"]);
		expect(parsed.orTerms).toStrictEqual([]);
	});

	it("extracts quoted exact phrases", () =>
	{
		const parsed = parseSearchQuery('"quarterly review" agenda');
		expect(parsed.exactPhrases).toStrictEqual(["quarterly review"]);
		// The quoted span is removed before term parsing.
		expect(parsed.requiredTerms).toStrictEqual(["agenda"]);
	});

	it("parses is:complete and is:incomplete", () =>
	{
		expect(parseSearchQuery("done is:complete")).toStrictEqual(
			{
				exactPhrases: [],
				requiredTerms: ["done"],
				orTerms: [],
				excludedTerms: [],
				isComplete: true,
				lastChangedDays: null,
			},
		);
		expect(parseSearchQuery("todo is:incomplete")).toStrictEqual(
			{
				exactPhrases: [],
				requiredTerms: ["todo"],
				orTerms: [],
				excludedTerms: [],
				isComplete: false,
				lastChangedDays: null,
			},
		);
		expect(parseSearchQuery("plain")).toStrictEqual(
			{
				exactPhrases: [],
				requiredTerms: ["plain"],
				orTerms: [],
				excludedTerms: [],
				isComplete: null,
				lastChangedDays: null,
			},
		);
	});

	it("parses last-changed:Nd", () =>
	{
		expect(parseSearchQuery("recent last-changed:7d")).toStrictEqual(
			{
				exactPhrases: [],
				requiredTerms: ["recent"],
				orTerms: [],
				excludedTerms: [],
				isComplete: null,
				lastChangedDays: 7,
			},
		);
		expect(parseSearchQuery("plain")).toStrictEqual(
			{
				exactPhrases: [],
				requiredTerms: ["plain"],
				orTerms: [],
				excludedTerms: [],
				isComplete: null,
				lastChangedDays: null,
			},
		);
	});

	it("collects -negations and removes them from terms", () =>
	{
		const parsed = parseSearchQuery("budget -draft -archived");
		expect(parsed.excludedTerms).toStrictEqual(["draft", "archived"]);
		expect(parsed.requiredTerms).toStrictEqual(["budget"]);
	});

	it("splits OR groups, keeping intra-group terms as AND", () =>
	{
		const parsed = parseSearchQuery("alpha beta OR gamma");
		expect(parsed.orTerms).toStrictEqual([["alpha", "beta"], ["gamma"]]);
		expect(parsed.requiredTerms).toStrictEqual([]);
	});

	it("combines operators in one query", () =>
	{
		const parsed = parseSearchQuery('"exact one" foo -bar is:complete last-changed:3d');
		expect(parsed.exactPhrases).toStrictEqual(["exact one"]);
		expect(parsed.requiredTerms).toStrictEqual(["foo"]);
		expect(parsed.excludedTerms).toStrictEqual(["bar"]);
		expect(parsed.isComplete).toBe(true);
		expect(parsed.lastChangedDays).toBe(3);
	});

	it("returns empty structure for an empty query", () =>
	{
		const parsed = parseSearchQuery("   ");
		expect(parsed).toStrictEqual(
			{
				exactPhrases: [],
				requiredTerms: [],
				orTerms: [],
				excludedTerms: [],
				isComplete: null,
				lastChangedDays: null,
			},
		);
	});
});
