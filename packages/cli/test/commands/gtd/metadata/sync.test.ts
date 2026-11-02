import {describe, expect, it} from "vite-plus/test";
import {GTD_CONTEXTS} from "../../../../src/commands/gtd/metadata/sync.js";

describe("gtd:metadata:sync contexts", () =>
{
	it("suggests no #work, #personal, or #computer context tags", () =>
	{
		expect(GTD_CONTEXTS).toStrictEqual(
			{
				location: ["#home", "#errands", "#anywhere"],
				mode: ["#call", "#email", "#read", "#buy", "#waiting"],
			},
		);
	});
});
