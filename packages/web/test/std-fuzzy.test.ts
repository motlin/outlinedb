import {describe, expect, it} from "vite-plus/test";
import {fuzzyMatch, fuzzyRegExp, fuzzyScore, fuzzyValid} from "../src/client/std-fuzzy.js";

const SLASH_LABELS = [
	"Bullets",
	"Board",
	"Table",
	"To-do",
	"Heading 1",
	"Heading 2",
	"Heading 3",
	"Paragraph",
	"Quote",
	"Code Block",
	"Divider",
	"Shortcut",
	"Upload file",
	"Number",
	"Complete",
	"Add date",
	"Add comment",
	"Add note",
	"Open in Pane",
	"Duplicate",
	"Move To...",
	"Move Here...",
	"Move To Child...",
	"Move to Today",
	"Move to Tomorrow",
	"Move to Next Week",
	"Move to Date...",
	"Share",
	"Export",
	"Mirror",
	"Mirror To...",
	"Mirror To Child...",
	"Mirror Here...",
	"Mirror to Today",
	"Mirror to Date...",
	"Expand all",
	"Collapse all",
	"Sort A-Z",
	"Sort Z-A",
	"Copy internal link",
	"Add from template",
	"Delete",
	"Count",
	"Priority: Default to Bottom",
	"Show Command Palette",
];

function rank(term: string): string[]
{
	const matches = SLASH_LABELS.filter((label) => fuzzyMatch(term, label));
	matches.sort((a, b) => fuzzyScore(term, b) - fuzzyScore(term, a));
	return matches;
}

describe("fuzzyMatch", () =>
{
	it("tests a case-insensitive subsequence", () =>
	{
		expect([
			fuzzyMatch("mo", "Mirror"),
			fuzzyMatch("mo", "Add comment"),
			fuzzyMatch("", "x"),
			fuzzyMatch("x", ""),
			fuzzyMatch("MT", "move to"),
		]).toStrictEqual([true, false, false, false, true]);
	});
});

describe("fuzzyScore", () =>
{
	it("returns -1 for empty inputs or a partial match", () =>
	{
		expect([fuzzyScore("x", ""), fuzzyScore("", "x"), fuzzyScore("xyz", "xy")]).toStrictEqual([-1, -1, -1]);
	});

	it("scores word starts, capitals and streaks", () =>
	{
		expect([fuzzyScore("m", "Mirror"), fuzzyScore("mi", "Mirror"), fuzzyScore("i", "mIx")]).toStrictEqual([
			15,
			25 - 0.01,
			11 - 0.01,
		]);
	});
});

describe("fuzzyValid and fuzzyRegExp", () =>
{
	it("strips non-alphanumerics", () =>
	{
		expect([
			fuzzyValid("a-b"),
			fuzzyValid("-/ "),
			fuzzyRegExp("m-o").source,
			fuzzyRegExp("m-o").flags,
		]).toStrictEqual([true, false, String.raw`\bm.*o`, "iu"]);
	});
});

describe("slash menu ranking matches upstream FILTER RESULTS", () =>
{
	it("ranks the 45 slash labels", () =>
	{
		expect(
			{
				m: rank("m"),
				mo: rank("mo"),
				dup: rank("dup"),
				h1: rank("h1"),
				todo: rank("todo"),
				mt: rank("mt"),
				ex: rank("ex"),
				pri: rank("pri"),
				date: rank("date"),
			},
		).toStrictEqual(
			{
				m: [
					"Move To...",
					"Move Here...",
					"Move To Child...",
					"Move to Today",
					"Move to Tomorrow",
					"Move to Next Week",
					"Move to Date...",
					"Mirror",
					"Mirror To...",
					"Mirror To Child...",
					"Mirror Here...",
					"Mirror to Today",
					"Mirror to Date...",
					"Number",
					"Complete",
					"Add comment",
					"Add from template",
					"Show Command Palette",
					"Priority: Default to Bottom",
				],
				mo: [
					"Move To...",
					"Move Here...",
					"Move To Child...",
					"Move to Today",
					"Move to Tomorrow",
					"Move to Next Week",
					"Move to Date...",
					"Mirror",
					"Mirror To...",
					"Mirror To Child...",
					"Mirror Here...",
					"Mirror to Today",
					"Mirror to Date...",
				],
				dup: ["Duplicate"],
				h1: ["Heading 1"],
				todo: ["To-do"],
				mt: [
					"Move To...",
					"Move To Child...",
					"Move to Today",
					"Move to Tomorrow",
					"Move to Next Week",
					"Move to Date...",
					"Mirror To...",
					"Mirror To Child...",
					"Mirror to Today",
					"Mirror to Date...",
					"Add from template",
					"Complete",
					"Add comment",
					"Show Command Palette",
				],
				ex: ["Export", "Expand all", "Move to Next Week"],
				pri: ["Priority: Default to Bottom", "Copy internal link"],
				date: [
					"Move to Date...",
					"Mirror to Date...",
					"Duplicate",
					"Add date",
					"Add from template",
					"Show Command Palette",
				],
			},
		);
	});
});
