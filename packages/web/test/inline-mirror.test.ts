import {describe, expect, it} from "vite-plus/test";
import
{
	inlineMirrorInsertion,
	inlineMirrorRefusal,
	planInlineMirror,
	planMirrorOpen,
	planMirrorRearm,
} from "../src/client/inline-mirror.js";

describe("planMirrorOpen", () =>
{
	it("opens on the second parenthesis of ((", () =>
	{
		expect([planMirrorOpen("see ((", 5), planMirrorOpen("see (", 4), planMirrorOpen("a(b", 1)]).toStrictEqual([
			{
				start: 4,
				end: 6,
			},
			null,
			null,
		]);
	});
});

describe("planMirrorRearm", () =>
{
	it("re-arms a resting ((query ending at the caret", () =>
	{
		expect([
			planMirrorRearm("see ((Orig", 10),
			planMirrorRearm("see ((Orig))", 12),
			planMirrorRearm("no", 2),
		]).toStrictEqual([
			{
				start: 4,
				end: 10,
			},
			null,
			null,
		]);
	});
});

describe("planInlineMirror", () =>
{
	it("replaces the row when nothing else is in the name", () =>
	{
		expect(
			planInlineMirror(
				{
					beforeHtml: "",
					afterHtml: "",
				},
			),
		).toStrictEqual(
			{
				kind: "replace-row",
			},
		);
		expect(
			planInlineMirror(
				{
					beforeHtml: "<b></b>",
					afterHtml: "&nbsp;",
				},
			),
		).toStrictEqual(
			{
				kind: "replace-row",
			},
		);
	});

	it("splits the row, dropping one whitespace before the ((", () =>
	{
		expect(
			planInlineMirror(
				{
					beforeHtml: "see ",
					afterHtml: " then",
				},
			),
		).toStrictEqual(
			{
				kind: "split",
				before: "see",
				after: " then",
			},
		);
		expect(
			planInlineMirror(
				{
					beforeHtml: "see  ",
					afterHtml: "",
				},
			),
		).toStrictEqual(
			{
				kind: "split",
				before: "see ",
				after: "",
			},
		);
	});
});

describe("inlineMirrorInsertion", () =>
{
	it("inserts (( at the start or after a space, else ' (('", () =>
	{
		expect([inlineMirrorInsertion(""), inlineMirrorInsertion("see "), inlineMirrorInsertion("see")]).toStrictEqual([
			"((",
			"((",
			" ((",
		]);
	});
});

describe("inlineMirrorRefusal", () =>
{
	it("refuses Home, the row itself and the row's ancestors", () =>
	{
		const lineage = ["parent", "grand"];
		expect([
			inlineMirrorRefusal(
				{
					pickId: "None",
					rowId: "row",
					parentLineage: lineage,
				},
			),
			inlineMirrorRefusal(
				{
					pickId: "row",
					rowId: "row",
					parentLineage: lineage,
				},
			),
			inlineMirrorRefusal(
				{
					pickId: "grand",
					rowId: "row",
					parentLineage: lineage,
				},
			),
			inlineMirrorRefusal(
				{
					pickId: "other",
					rowId: "row",
					parentLineage: lineage,
				},
			),
		]).toStrictEqual([
			"Cannot mirror Home",
			"Cannot mirror an item into itself",
			"Cannot mirror an item into itself",
			null,
		]);
	});
});
