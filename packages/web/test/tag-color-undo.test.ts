import {describe, expect, it} from "vite-plus/test";
import {invertOp, tagColorOp} from "../src/client/undo-history.js";

describe("tagColorOp", () =>
{
	it("records setting a color over none, and its inverse removes it", () =>
	{
		const op = tagColorOp("#x", undefined, "green");
		expect([op, op && invertOp(op)]).toStrictEqual([
			{
				kind: "tagColor",
				tag: "#x",
				before: null,
				after: "green",
			},
			{
				kind: "tagColor",
				tag: "#x",
				before: "green",
				after: null,
			},
		]);
	});

	it("records the previous color when removing, and nothing when the color is unchanged", () =>
	{
		expect([
			tagColorOp("#x", "red", null),
			tagColorOp("#x", "red", "red"),
			tagColorOp("#x", undefined, null),
		]).toStrictEqual([
			{
				kind: "tagColor",
				tag: "#x",
				before: "red",
				after: null,
			},
			null,
			null,
		]);
	});
});
