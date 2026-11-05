import {describe, expect, it} from "vite-plus/test";
import {parsePeopleHints} from "../../src/services/people-hints.js";

const MARKDOWN = `# People Disambiguation Reference

Intro prose mentioning @AliceBrown that is not a table row.

## Voice-to-text typos & misspellings

| Name in text | Person | Notes |
|---|---|---|
| Alise | @AliceBrown | Typo of Alice |
| "Bobby" / Bobbie | @Bob | Voice-to-text |
| cleaning ladies | (skip) | Not a person |

## Shorthands

| Shorthand | Resolution | Notes |
|---|---|---|
| "both kids" | @AliceBrown and @Bob | The two kids |
| "parents" (school context) | NOT @Carol/@Dave | Other kids' parents |
| Straight Bob | Straight @Bob | Qualifier |
| \`Mom\` / mom | @carol | Guard possessives |

## Homonyms

| Name in text | Person | Notes |
|---|---|---|
| Alice (book club) | @AliceBrown | Reads with Bob |
| Alise | @AliceBrown | Repeated row |
`;

describe("parsePeopleHints", () => {
	it("maps each @Name in a table's second column to the first-column phrases, skipping NOT rows and prose", () => {
		expect(parsePeopleHints(MARKDOWN)).toStrictEqual(
			new Map([
				["@alicebrown", ["Alise", "both kids", "Alice (book club)"]],
				["@bob", ["Bobby / Bobbie", "both kids", "Straight Bob"]],
				["@carol", ["Mom / mom"]],
			]),
		);
	});

	it("returns an empty map for text without tables", () => {
		expect(parsePeopleHints("# Title\n\nJust prose about @Bob.\n")).toStrictEqual(new Map());
	});
});
