// @vitest-environment happy-dom
import {describe, expect, it} from "vite-plus/test";
import
{
	buildPasteLines,
	buildItemCopyLines,
	planItemCopy,
	planMultilineSplice,
	planPasteApply,
	PASTE_LIMIT_ALERT,
} from "../src/client/paste/apply.js";
import type {PasteLine} from "../src/client/paste/lines.js";

const line = (name: string, extra: Partial<PasteLine> = {}): PasteLine => (
{
	name,
	mdBullet: false,
	children: [],
	...extra,
});
const plain = (text: string) =>
	buildPasteLines(
		{
			text,
		},
	);

describe("planPasteApply", () =>
{
	it("merges the first line, nests and splits after-text (U1)", () =>
	{
		expect(
			planPasteApply(
				{
					before: "P1",
					after: "",
					lines: plain("one\ntwo\n  three\nfour"),
					rowKind: "leaf",
				},
			),
		).toStrictEqual(
			{
				currentName: "P1one",
				childTrees: [],
				siblingTrees: [
					{
						name: "two",
						children: [
							{
								name: "three",
							},
						],
					},
					{
						name: "four",
					},
				],
				caret:
				{
					row: "lastCreated",
					offset: "end",
				},
			},
		);
	});

	it("splits the after-text into its own last row with the caret at 0 (U2)", () =>
	{
		expect(
			planPasteApply(
				{
					before: "fo",
					after: "ur",
					lines: plain("A\nB"),
					rowKind: "leaf",
				},
			),
		).toStrictEqual(
			{
				currentName: "foA",
				childTrees: [],
				siblingTrees: [
					{
						name: "B",
					},
					{
						name: "ur",
					},
				],
				caret:
				{
					row: "lastCreated",
					offset: 0,
				},
			},
		);
	});

	it("applies the first line's layout to the current row (U4)", () =>
	{
		const plan = planPasteApply(
			{
				before: "u",
				after: "r",
				lines: plain("# Head\nx"),
				rowKind: "leaf",
			},
		);
		expect(plan).toMatchObject(
			{
				currentName: "uHead",
				current:
				{
					layoutMode: "h1",
				},
			},
		);
	});

	it("splices a single plain line, untrimmed, with its metadata on the row (U3, U9, D7)", () =>
	{
		expect(
			planPasteApply(
				{
					before: "",
					after: "",
					lines: plain("# Title"),
					rowKind: "leaf",
				},
			),
		).toStrictEqual(
			{
				currentName: "Title",
				current:
				{
					layoutMode: "h1",
				},
				childTrees: [],
				siblingTrees: [],
				caret:
				{
					row: "current",
					offset: 5,
				},
			},
		);
		expect(
			planPasteApply(
				{
					before: "T1",
					after: "",
					lines: plain("   x  "),
					rowKind: "leaf",
				},
			),
		).toStrictEqual(
			{
				currentName: "T1   x  ",
				childTrees: [],
				siblingTrees: [],
				caret:
				{
					row: "current",
					offset: 8,
				},
			},
		);
	});

	it("replaces the selection with nothing for whitespace-only text (D8)", () =>
	{
		expect(
			planPasteApply(
				{
					before: "",
					after: "",
					lines: plain("   \n  \n"),
					rowKind: "leaf",
				},
			),
		).toStrictEqual(
			{
				currentName: "",
				childTrees: [],
				siblingTrees: [],
				caret:
				{
					row: "current",
					offset: 0,
				},
			},
		);
	});

	it("creates every line as first children of the zoom root and leaves its title (D1)", () =>
	{
		expect(
			planPasteApply(
				{
					before: "PD",
					after: "",
					lines: plain("T1\nT2"),
					rowKind: "zoomRoot",
				},
			),
		).toStrictEqual(
			{
				currentName: null,
				childTrees: [
					{
						name: "T1",
					},
					{
						name: "T2",
					},
				],
				siblingTrees: [],
				caret:
				{
					row: "lastCreated",
					offset: "end",
				},
			},
		);
	});

	it("creates siblings after a branch row without merging (D2, D3)", () =>
	{
		expect(
			planPasteApply(
				{
					before: "Par",
					after: "ent",
					lines: plain("A\nB"),
					rowKind: "branch",
				},
			),
		).toStrictEqual(
			{
				currentName: null,
				childTrees: [],
				siblingTrees: [
					{
						name: "A",
					},
					{
						name: "B",
					},
				],
				caret:
				{
					row: "lastCreated",
					offset: "end",
				},
			},
		);
	});

	it("strips line one's leading space and never copies the layout to siblings (D5)", () =>
	{
		const plan = planPasteApply(
			{
				before: "Todo row",
				after: "",
				lines: plain(" t1\nt2"),
				rowKind: "leaf",
			},
		);
		expect(plan).toMatchObject(
			{
				currentName: "Todo rowt1",
				siblingTrees: [
					{
						name: "t2",
					},
				],
			},
		);
		expect(plan).not.toHaveProperty("current");
	});

	it("turns an unindented dash into a bullet and nests the rest (D6)", () =>
	{
		expect(
			planPasteApply(
				{
					before: "Leaf row",
					after: "",
					lines: plain("\n- a\n  - b\n    - c\n- d"),
					rowKind: "leaf",
				},
			),
		).toStrictEqual(
			{
				currentName: "Leaf rowa",
				current:
				{
					layoutMode: "bullet",
				},
				childTrees: [
					{
						name: "b",
						children: [
							{
								name: "c",
							},
						],
					},
				],
				siblingTrees: [
					{
						name: "d",
						layoutMode: "bullet",
					},
				],
				caret:
				{
					row: "lastCreated",
					offset: "end",
				},
			},
		);
	});

	it("links urls in the merged text only (D9, D10)", () =>
	{
		expect(
			planPasteApply(
				{
					before: "Parent",
					after: " row",
					lines: plain("see https://ex.com/z now"),
					rowKind: "branch",
				},
			),
		).toMatchObject(
			{
				currentName: 'Parentsee <a href="https://ex.com/z">https://ex.com/z</a> now row',
			},
		);
		expect(
			planPasteApply(
				{
					before: "B",
					after: "",
					lines: plain(" u1 https://a.com/1\nu2 https://b.com/2 #tg @someone Oct 3, 2026"),
					rowKind: "leaf",
				},
			),
		).toStrictEqual(
			{
				currentName: 'Bu1 <a href="https://a.com/1">https://a.com/1</a>',
				childTrees: [],
				siblingTrees: [
					{
						name: "u2 https://b.com/2 #tg @someone Oct 3, 2026",
					},
				],
				caret:
				{
					row: "lastCreated",
					offset: "end",
				},
			},
		);
	});

	it("moves a leading nested group under the current row (D13)", () =>
	{
		expect(
			planPasteApply(
				{
					before: "d",
					after: "",
					lines: buildPasteLines(
						{
							text: "a\nb\nc",
							html: "<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>",
						},
					),
					rowKind: "leaf",
				},
			),
		).toStrictEqual(
			{
				currentName: "da",
				childTrees: [
					{
						name: "b",
					},
				],
				siblingTrees: [
					{
						name: "c",
					},
				],
				caret:
				{
					row: "lastCreated",
					offset: "end",
				},
			},
		);
	});

	it("carries notes, completion, layout and numbering into trees", () =>
	{
		const plan = planPasteApply(
			{
				before: "",
				after: "",
				lines: [
					line("x"),
					line(
						"y",
						{
							note: "n",
							complete: true,
							layoutMode: "numbered",
							numberedStart: 3,
						},
					),
				],
				rowKind: "branch",
			},
		);
		expect(plan).toMatchObject(
			{
				siblingTrees: [
					{
						name: "x",
					},
					{
						name: "y",
						note: "n",
						completed: true,
						layoutMode: "numbered",
						numberedStart: 3,
					},
				],
			},
		);
	});

	it("refuses more than 10000 lines with the upstream alert (D12)", () =>
	{
		const lines = Array.from(
			{
				length: 10_001,
			},
			() => line("x"),
		);
		expect(
			planPasteApply(
				{
					before: "",
					after: "",
					lines,
					rowKind: "leaf",
				},
			),
		).toStrictEqual(
			{
				alert: "Pasting more than 10000 items at a time is not supported.",
			},
		);
		expect(PASTE_LIMIT_ALERT).toBe("Pasting more than 10000 items at a time is not supported.");
	});

	it("counts nested lines toward the limit", () =>
	{
		const lines = [
			line(
				"p",
				{
					children: Array.from(
						{
							length: 10_000,
						},
						() => line("x"),
					),
				},
			),
		];
		expect(
			planPasteApply(
				{
					before: "",
					after: "",
					lines,
					rowKind: "leaf",
				},
			),
		).toHaveProperty("alert");
	});
});

describe("buildPasteLines", () =>
{
	it("ignores html when pasting as plain text (PD5)", () =>
	{
		expect(
			buildPasteLines(
				{
					text: "a\nb",
					html: "<ul><li><b>a</b></li><li>b</li></ul>",
					plain: true,
				},
			),
		).toStrictEqual(plain("a\nb"));
		expect(
			buildPasteLines(
				{
					text: "a\nb",
					html: "<ul><li><b>a</b></li><li>b</li></ul>",
				},
			)[0]?.name,
		).toBe("<b>a</b>");
	});

	it("reads OPML text", () =>
	{
		expect(
			buildPasteLines(
				{
					text: '<opml><body><outline text="x"/></body></opml>',
				},
			),
		).toStrictEqual([line("x")]);
	});

	it("applies markdown to plain text", () =>
	{
		expect(
			buildPasteLines(
				{
					text: "# Title",
				},
			),
		).toStrictEqual([
			line(
				"Title",
				{
					layoutMode: "h1",
				},
			),
		]);
	});
});

describe("planMultilineSplice", () =>
{
	it("escapes and keeps every newline, including a leading one (D4)", () =>
	{
		expect(
			planMultilineSplice(
				{
					before: "Quote row",
					after: "",
					text: "\nq1\nq2 <x>",
				},
			),
		).toStrictEqual(
			{
				html: "Quote row\nq1\nq2 &lt;x&gt;",
				caret: 19,
			},
		);
	});
});

describe("item copy", () =>
{
	const html =
		'<ul><li><span class="name" data-wfid="abc" data-parent="p"><span class="innerContentContainer">NoteRow2</span></span><br/><span class="note">nl1\nl2 &lt;x&gt; &amp; y\n- l3</span></li></ul>';

	it("rebuilds rows from Workflowy's own copy html (U15)", () =>
	{
		expect(buildItemCopyLines(html)).toStrictEqual([
			line(
				"NoteRow2",
				{
					note: "nl1\nl2 &lt;x&gt; &amp; y\n- l3",
				},
			),
		]);
		expect(buildItemCopyLines("<b>x</b>")).toBeNull();
	});

	it("replaces an empty row at its index", () =>
	{
		expect(
			planItemCopy(
				{
					lines: buildItemCopyLines(html) ?? [],
					rowEmpty: true,
					rowIndex: 4,
					rowOpen: false,
				},
			),
		).toStrictEqual(
			{
				deleteCurrent: true,
				placement:
				{
					kind: "index",
					index: 4,
				},
				trees: [
					{
						name: "NoteRow2",
						note: "nl1\nl2 &lt;x&gt; &amp; y\n- l3",
					},
				],
			},
		);
	});

	it("goes first under an open row, else after the row", () =>
	{
		const lines = [line("x")];
		expect(
			planItemCopy(
				{
					lines,
					rowEmpty: false,
					rowIndex: 0,
					rowOpen: true,
				},
			),
		).toMatchObject(
			{
				deleteCurrent: false,
				placement:
				{
					kind: "firstChild",
				},
			},
		);
		expect(
			planItemCopy(
				{
					lines,
					rowEmpty: false,
					rowIndex: 0,
					rowOpen: false,
				},
			),
		).toMatchObject(
			{
				deleteCurrent: false,
				placement:
				{
					kind: "after",
				},
			},
		);
	});
});
