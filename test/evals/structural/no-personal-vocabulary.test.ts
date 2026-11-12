import {describe, expect, it} from "vite-plus/test";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {PROJECT_ROOT, trackedFiles} from "./helpers/scan-roots.js";

/**
 * Which holidays and observances someone keeps is personal, so the emoji for
 * them live in the gitignored `.llm/gtd/journal-vocabulary.md`, never in the
 * reusable `plugins/` or `.claude/` files. Naming a specific holiday in a
 * plugin rule reveals the author's religion or culture.
 *
 * Likewise, which workout programs someone follows and how they log them is
 * personal, so program names and canonical line shapes live in the gitignored
 * `.llm/gtd/exercise-formats.md`.
 */

const HOLIDAY_NAMES =
	/\b(christmas|easter|good friday|lent|yom kippur|rosh hashanah|passover|pesach|hanukkah|chanukah|shabbat|sukkot|purim|bar mitzvah|bat mitzvah|hebrew school|ramadan|eid|diwali|holi|vesak|lunar new year)\b/iu;
const EXERCISE_PROGRAMS =
	/\b(digin|insanity|shaun t|p90x|t25|21 day fix|beachbody|body ?pump|couch to 5k|stronglifts|crossfit)\b/iu;
const SCAN_ROOTS = ["plugins", ".claude"];

function scanTracked(pattern: RegExp): string[]
{
	const violations: string[] = [];
	for (const root of SCAN_ROOTS)
	{
		for (const relativePath of trackedFiles(root))
		{
			const content = readFileSync(join(PROJECT_ROOT, relativePath), "utf8");
			content.split("\n").forEach((line, index) =>
			{
				const match = pattern.exec(line);
				if (match)
				{
					violations.push(`${relativePath}:${index + 1}: ${match[0]}`);
				}
			});
		}
	}
	return violations;
}

describe("Structural Eval: No Personal Vocabulary", () =>
{
	it("no tracked file under plugins/ or .claude/ names a specific holiday", () =>
	{
		expect(scanTracked(HOLIDAY_NAMES)).toStrictEqual([]);
	});

	it("no tracked file under plugins/ or .claude/ names a specific exercise program", () =>
	{
		expect(scanTracked(EXERCISE_PROGRAMS)).toStrictEqual([]);
	});

	it("refine-journal-prep reads holiday emoji from the private journal vocabulary", () =>
	{
		const prep = readFileSync(join(PROJECT_ROOT, "plugins/gtd/commands/refine-journal-prep.md"), "utf8");

		expect(prep).toMatch(/holiday[^\n]*journal-vocabulary\.md|journal-vocabulary\.md[^\n]*holiday/iu);
	});

	it("refine-journal-prep looks up community events and places in the vocabulary emoji table, not only holidays", () =>
	{
		const prep = readFileSync(join(PROJECT_ROOT, "plugins/gtd/commands/refine-journal-prep.md"), "utf8");

		expect(prep).toMatch(/religious or community event[^\n]*place[^\n]*journal-vocabulary\.md/iu);
	});

	it("refine-journal-prep leads emoji options with the occasion rather than the means", () =>
	{
		const prep = readFileSync(join(PROJECT_ROOT, "plugins/gtd/commands/refine-journal-prep.md"), "utf8");

		expect(prep).toMatch(/occasion over the means/iu);
	});

	it("refine-journal-apply offers to record a vocabulary-matched emoji pick in journal-vocabulary.md", () =>
	{
		const apply = readFileSync(join(PROJECT_ROOT, "plugins/gtd/commands/refine-journal-apply.md"), "utf8");

		expect(apply).toMatch(/emoji pick[^\n]*journal-vocabulary\.md/iu);
	});
});
