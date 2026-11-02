import {describe, expect, it} from "vite-plus/test";
import {parseQuery} from "../src/search/index.js";

describe("QueryNode.revealsCompleted", () =>
{
	it("propagates through AND, OR and NOT like upstream's shouldRevealMatchingCompletedItems", () =>
	{
		const queries = [
			"is:complete",
			"IS:COMPLETE",
			"rc is:complete",
			"-is:complete",
			"rc OR is:complete",
			"is:complete OR inner",
			"rc",
			"is:completed",
			'"is:complete"',
			"is:incomplete",
		];
		expect(Object.fromEntries(queries.map((query) => [query, parseQuery(query).revealsCompleted()]))).toStrictEqual(
			{
				"is:complete": true,
				"IS:COMPLETE": true,
				"rc is:complete": true,
				"-is:complete": true,
				"rc OR is:complete": true,
				"is:complete OR inner": true,
				rc: false,
				"is:completed": false,
				'"is:complete"': false,
				"is:incomplete": false,
			},
		);
	});
});
